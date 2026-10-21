import { defaultIdempotencyKey } from "../aquifer.js";
import { bytesToHex, constantTimeEqual, hmacSha256, sha256Hex, utf8 } from "../encoding.js";
import type { DeliveryEnvelope, HeadersRecord, InletConfig, ProviderName, RouteConfig } from "../types.js";

/**
 * One accepted webhook on the events topic. The Kafka key is the route and
 * fairness identity, so one user's events stay in order in one partition.
 */
export interface EventRecord {
  schema: "inlet.event.v1";
  /** Stable across redrives: hash of provider, route and provider event ID. */
  delivery_id: string;
  /** The Kafka key: hash of route and fairness identity, the same one SQS FIFO groups by. */
  partition_key: string;
  event_id: string;
  event_type: string;
  provider: ProviderName;
  route_id: string;
  user_id: string;
  destination: string;
  method: "POST";
  content_type?: string;
  headers: HeadersRecord;
  body_base64: string;
  /** When Inlet accepted the webhook (ISO 8601). Unchanged by redrives. */
  received_at: string;
  /** When this copy of the event was written (ISO 8601). */
  written_at: string;
  /** The reconciler looks for a result once this time passes (ISO 8601). */
  reconcile_after: string;
  /** How many times the reconciler has written this event again. */
  redrive: number;
  /**
   * Which Aquifer idempotency key this copy uses. 0 is the original key; it
   * goes up only when a redrive must run the job again after a failure.
   */
  key_generation: number;
  idempotency_key: string;
  max_retries?: number;
  execute_before?: number;
  traceparent?: string;
  events_topic: string;
  results_topic: string;
}

export type ResultStatus =
  | "owned"
  | "completed"
  | "failed"
  | "dead_letter"
  | "redriven"
  | "gave_up";

/** One outcome on the results topic, keyed by delivery_id. */
export interface ResultRecord {
  schema: "inlet.result.v1";
  delivery_id: string;
  event_id: string;
  route_id: string;
  provider: ProviderName;
  user_id: string;
  redrive: number;
  key_generation: number;
  status: ResultStatus;
  job_id?: string;
  response_status?: number;
  reason?: string;
  recorded_at: string;
  /** Which part of Inlet wrote this record. */
  source: "dispatch" | "completion" | "reconciler";
}

/** Results that end an event's delivery attempt. owned and redriven don't. */
export const terminalStatuses: ReadonlySet<ResultStatus> = new Set([
  "completed",
  "failed",
  "dead_letter",
  "gave_up",
]);

export async function deliveryId(provider: string, routeId: string, eventId: string): Promise<string> {
  return sha256Hex(`${provider}\0${routeId}\0${eventId}`);
}

export function topicsFor(config: InletConfig, route: Pick<RouteConfig, "eventsTopic" | "resultsTopic">): {
  eventsTopic: string;
  resultsTopic: string;
} {
  if (config.kafka === undefined) throw new Error("Kafka topics need delivery: kafka");
  return {
    eventsTopic: route.eventsTopic ?? config.kafka.eventsTopic,
    resultsTopic: route.resultsTopic ?? config.kafka.resultsTopic,
  };
}

export function idempotencyKeyFor(
  envelope: Pick<DeliveryEnvelope, "provider" | "routeId" | "eventId">,
  keyGeneration: number,
): string {
  const base = defaultIdempotencyKey(envelope);
  return keyGeneration === 0 ? base : `${base}:r${keyGeneration}`;
}

export async function eventRecordFromEnvelope(
  envelope: DeliveryEnvelope,
  partitionKey: string,
  topics: { eventsTopic: string; resultsTopic: string },
  reconcileAfterSeconds: number,
  now = new Date(),
): Promise<EventRecord> {
  const record: EventRecord = {
    schema: "inlet.event.v1",
    delivery_id: await deliveryId(envelope.provider, envelope.routeId, envelope.eventId),
    partition_key: partitionKey,
    event_id: envelope.eventId,
    event_type: envelope.eventType,
    provider: envelope.provider,
    route_id: envelope.routeId,
    user_id: envelope.userId,
    destination: envelope.destination,
    method: "POST",
    headers: envelope.headers,
    body_base64: envelope.bodyBase64,
    received_at: new Date(envelope.receivedAt).toISOString(),
    written_at: now.toISOString(),
    reconcile_after: new Date(now.getTime() + reconcileAfterSeconds * 1_000).toISOString(),
    redrive: 0,
    key_generation: 0,
    idempotency_key: idempotencyKeyFor(envelope, 0),
    events_topic: topics.eventsTopic,
    results_topic: topics.resultsTopic,
  };
  const contentType = headerValue(envelope.headers, "content-type");
  if (contentType !== undefined) record.content_type = contentType;
  const traceparent = headerValue(envelope.headers, "traceparent");
  if (traceparent !== undefined) record.traceparent = traceparent;
  if (envelope.maxRetries !== undefined) record.max_retries = envelope.maxRetries;
  if (envelope.executeBefore !== undefined) record.execute_before = envelope.executeBefore;
  return record;
}

/** The Aquifer submission for one event record. */
export function envelopeFromEventRecord(record: EventRecord, completionUrl: string): DeliveryEnvelope {
  const envelope: DeliveryEnvelope = {
    version: 1,
    routeId: record.route_id,
    provider: record.provider,
    eventId: record.event_id,
    eventType: record.event_type,
    userId: record.user_id,
    destination: record.destination,
    completionUrl,
    receivedAt: Date.parse(record.received_at),
    headers: { ...record.headers, "x-inlet-delivery-id": record.delivery_id },
    bodyBase64: record.body_base64,
    idempotencyKey: record.idempotency_key,
  };
  if (record.max_retries !== undefined) envelope.maxRetries = record.max_retries;
  if (record.execute_before !== undefined) envelope.executeBefore = record.execute_before;
  return envelope;
}

export function resultFor(
  event: EventRecord,
  status: ResultStatus,
  source: ResultRecord["source"],
  details: Partial<Pick<ResultRecord, "job_id" | "response_status" | "reason">> = {},
  now = new Date(),
): ResultRecord {
  return {
    schema: "inlet.result.v1",
    delivery_id: event.delivery_id,
    event_id: event.event_id,
    route_id: event.route_id,
    provider: event.provider,
    user_id: event.user_id,
    redrive: event.redrive,
    key_generation: event.key_generation,
    status,
    ...details,
    recorded_at: now.toISOString(),
    source,
  };
}

export function parseEventRecord(value: string): EventRecord {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.schema !== "inlet.event.v1" || typeof parsed.delivery_id !== "string") {
    throw new Error("not an inlet.event.v1 record");
  }
  return parsed as unknown as EventRecord;
}

export function parseResultRecord(value: string): ResultRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schema !== "inlet.result.v1" || typeof parsed.delivery_id !== "string") {
      return undefined;
    }
    return parsed as unknown as ResultRecord;
  } catch {
    return undefined;
  }
}

/** The event fields a completion URL carries, signed. */
export type CompletionFields = Pick<
  EventRecord,
  "route_id" | "delivery_id" | "event_id" | "user_id" | "redrive" | "key_generation"
>;

export const completionPath = "/_inlet/completions";

/**
 * Where Aquifer sends this event's completion webhook. Aquifer's webhook
 * only carries the job ID and outcome, so the query string names the event,
 * and the signature stops anyone else from posting results.
 */
export async function completionUrl(baseUrl: string, secret: string, event: CompletionFields): Promise<string> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${completionPath}`);
  url.searchParams.set("route", event.route_id);
  url.searchParams.set("delivery", event.delivery_id);
  url.searchParams.set("event", event.event_id);
  url.searchParams.set("user", event.user_id);
  url.searchParams.set("redrive", String(event.redrive));
  url.searchParams.set("gen", String(event.key_generation));
  url.searchParams.set("sig", await completionSignature(secret, event));
  return url.toString();
}

/** Reads and verifies a completion URL's query. Undefined when it doesn't verify. */
export async function verifyCompletionQuery(
  query: URLSearchParams,
  secret: string,
): Promise<CompletionFields | undefined> {
  const fields = {
    route_id: query.get("route") ?? "",
    delivery_id: query.get("delivery") ?? "",
    event_id: query.get("event") ?? "",
    user_id: query.get("user") ?? "",
    redrive: Number(query.get("redrive")),
    key_generation: Number(query.get("gen")),
  };
  const sig = query.get("sig");
  if (
    !sig ||
    !fields.route_id ||
    !fields.delivery_id ||
    !fields.event_id ||
    !Number.isInteger(fields.redrive) ||
    !Number.isInteger(fields.key_generation)
  ) {
    return undefined;
  }
  const expected = await completionSignature(secret, fields);
  return constantTimeEqual(utf8(expected), utf8(sig)) ? fields : undefined;
}

async function completionSignature(secret: string, event: CompletionFields): Promise<string> {
  const message = [
    event.route_id,
    event.delivery_id,
    event.event_id,
    event.user_id,
    String(event.redrive),
    String(event.key_generation),
  ].join("\0");
  return bytesToHex(await hmacSha256(utf8(secret), utf8(message)));
}

function headerValue(headers: HeadersRecord, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

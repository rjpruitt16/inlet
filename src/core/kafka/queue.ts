import { ConfigurationError, InletError } from "../errors.js";
import type { DeliveryEnvelope, InletConfig, OrderedQueue, ProviderName } from "../types.js";
import {
  eventRecordFromEnvelope,
  topicsFor,
  verifyCompletionQuery,
  type ResultRecord,
  type ResultStatus,
} from "./records.js";

/** Writes to Kafka. A runtime implements it with a real client or an HTTP API. */
export interface KafkaWriter {
  write(topic: string, messages: Array<{ key: string; value: string; timestamp: number }>): Promise<void>;
}

/**
 * The intake's queue in Kafka mode: each accepted webhook becomes one
 * record on its route's events topic, keyed so one user's events share a
 * partition and stay in order.
 */
export class KafkaEventQueue implements OrderedQueue {
  constructor(
    private readonly config: InletConfig,
    private readonly writer: KafkaWriter,
  ) {
    if (config.kafka === undefined) throw new ConfigurationError("KafkaEventQueue needs delivery: kafka");
  }

  async send(envelope: DeliveryEnvelope, groupId: string): Promise<void> {
    const route = this.config.routes.find((candidate) => candidate.id === envelope.routeId);
    if (route === undefined) throw new ConfigurationError(`unknown route ${envelope.routeId}`);
    const now = new Date();
    const record = await eventRecordFromEnvelope(
      envelope,
      groupId,
      topicsFor(this.config, route),
      this.config.kafka!.reconcile.afterSeconds,
      now,
    );
    await this.writer.write(record.events_topic, [
      { key: groupId, value: JSON.stringify(record), timestamp: now.getTime() },
    ]);
  }
}

/**
 * Handles Aquifer's completion webhook for a Kafka-mode event and writes
 * the outcome to the route's results topic. Throws InletError for requests
 * that aren't a valid, signed completion.
 */
export async function recordCompletion(
  query: URLSearchParams,
  body: Uint8Array,
  secret: string,
  config: InletConfig,
  writer: KafkaWriter,
  now = new Date(),
): Promise<ResultRecord> {
  const fields = await verifyCompletionQuery(query, secret);
  if (fields === undefined) {
    throw new InletError("completion signature is invalid", 401, "invalid_completion_signature");
  }
  const route = config.routes.find((candidate) => candidate.id === fields.route_id);
  if (route === undefined || config.kafka === undefined) {
    throw new InletError("completion route not found", 404, "route_not_found");
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new InletError("completion body must be a JSON object", 400, "invalid_completion");
  }
  const status: ResultStatus | undefined =
    payload.status === "completed" ? "completed" : payload.status === "failed" ? "failed" : undefined;
  if (status === undefined) {
    throw new InletError("completion status must be completed or failed", 400, "invalid_completion");
  }

  const result: ResultRecord = {
    schema: "inlet.result.v1",
    delivery_id: fields.delivery_id,
    event_id: fields.event_id,
    route_id: fields.route_id,
    provider: route.provider as ProviderName,
    user_id: fields.user_id,
    redrive: fields.redrive,
    key_generation: fields.key_generation,
    status,
    recorded_at: now.toISOString(),
    source: "completion",
  };
  if (typeof payload.job_id === "string") result.job_id = payload.job_id;
  if (typeof payload.response_status === "number") result.response_status = payload.response_status;
  if (typeof payload.reason === "string") result.reason = payload.reason.slice(0, 500);

  await writer.write(topicsFor(config, route).resultsTopic, [
    { key: result.delivery_id, value: JSON.stringify(result), timestamp: now.getTime() },
  ]);
  return result;
}

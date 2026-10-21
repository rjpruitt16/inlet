import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import type { Kafka } from "kafkajs";
import { FetchAquiferTransport } from "../../core/aquifer.js";
import { parseConfig } from "../../core/config.js";
import { deliverEnvelope } from "../../core/delivery.js";
import { InletError } from "../../core/errors.js";
import { normalizeHeaders } from "../../core/headers.js";
import { InletIntake } from "../../core/ingress.js";
import { dispatchEvents } from "../../core/kafka/dispatch.js";
import { KafkaEventQueue, recordCompletion } from "../../core/kafka/queue.js";
import { reconcileTopic, type ReconcileSummary } from "../../core/kafka/reconcile.js";
import {
  completionPath,
  completionUrl,
  parseEventRecord,
  topicsFor,
  type EventRecord,
  type ResultRecord,
} from "../../core/kafka/records.js";
import type { DeliveryAction, DeliveryEnvelope, HeadersRecord, InletConfig } from "../../core/types.js";
import { defaultProviders } from "../../providers/index.js";
import { kafkaFromEnv, KafkajsReconcileLog, KafkajsWriter } from "./kafka.js";
import { SqsFifoQueue } from "./queue.js";
import { AwsSecretResolver } from "./secrets.js";

interface AwsRuntime {
  config: InletConfig;
  intake: InletIntake;
  aquifer: FetchAquiferTransport;
  secrets: AwsSecretResolver;
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl?: string;
  /** Set when delivery is kafka. */
  kafka?: { client: Kafka; writer: KafkajsWriter };
}

let runtimePromise: Promise<AwsRuntime> | undefined;

export async function httpHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const runtime = await getRuntime();
    const request: {
      method: string;
      path: string;
      url?: string;
      headers: HeadersRecord;
      body: Uint8Array;
    } = {
      method: event.requestContext.http.method,
      path: event.rawPath,
      headers: compactHeaders(event.headers),
      body: decodeBody(event.body ?? "", event.isBase64Encoded),
    };
    const requestUrl = apiGatewayRequestUrl(event);
    if (requestUrl !== undefined) request.url = requestUrl;
    if (runtime.kafka && request.path === completionPath && request.method.toUpperCase() === "POST") {
      const result = await recordCompletion(
        new URLSearchParams(event.rawQueryString ?? ""),
        request.body,
        await completionSecret(runtime),
        runtime.config,
        runtime.kafka.writer,
      );
      return jsonResponse(200, { recorded: true, status: result.status });
    }
    if (request.method.toUpperCase() === "GET") {
      const response = await runtime.intake.challenge(request);
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
      };
    }
    const immediate = await runtime.intake.immediateResponse(request);
    if (immediate) {
      return {
        statusCode: immediate.statusCode,
        headers: immediate.headers,
        body: immediate.body,
      };
    }
    const result = await runtime.intake.accept(request);
    return jsonResponse(202, { accepted: true, ...result });
  } catch (error) {
    if (error instanceof InletError) {
      return jsonResponse(error.statusCode, { error: error.message, code: error.code });
    }
    console.error("inlet intake failed", error);
    return jsonResponse(503, { error: "webhook intake unavailable", code: "intake_unavailable" });
  }
}

export async function queueHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  const runtime = await getRuntime();
  const failures = new Set<string>();
  const groups = groupRecords(event.Records);

  await Promise.all(
    Array.from(groups.values(), async (records) => {
      let groupBlocked = false;
      for (const record of records) {
        if (groupBlocked) {
          failures.add(record.messageId);
          continue;
        }

        const action = await processRecord(record, runtime);
        if (action.kind === "retry") {
          await delayRecord(record, action.delayMs, runtime);
          failures.add(record.messageId);
          groupBlocked = true;
        } else if (action.kind === "dead-letter") {
          const moved = await moveToDeadLetter(record, action, runtime);
          if (!moved) {
            failures.add(record.messageId);
            groupBlocked = true;
          }
        }
      }
    }),
  );

  return {
    batchItemFailures: Array.from(failures, (itemIdentifier) => ({ itemIdentifier })),
  };
}

async function processRecord(record: SQSRecord, runtime: AwsRuntime): Promise<DeliveryAction> {
  let envelope: DeliveryEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    return {
      kind: "dead-letter",
      reason: error instanceof Error ? error.message : "invalid queue message",
    };
  }
  const attempt = Number(record.attributes.ApproximateReceiveCount) || 1;
  const first = await deliverEnvelope(envelope, attempt, runtime.aquifer, runtime.config.confirmation);
  if (first.kind !== "confirm") return first;

  await sleep(first.delayMs);
  const second = await deliverEnvelope(
    envelope,
    attempt + 1,
    runtime.aquifer,
    runtime.config.confirmation,
    new Date(),
    undefined,
    first.state,
  );
  if (second.kind !== "confirm") return second;

  // SQS messages are immutable, so a confirmation state cannot be attached
  // before returning this message to the queue. A future receive starts a new
  // two-observation cycle instead of accepting one successful response.
  return {
    kind: "retry",
    delayMs: second.delayMs,
    reason: "confirmation_required",
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function delayRecord(record: SQSRecord, delayMs: number, runtime: AwsRuntime): Promise<void> {
  await runtime.sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: runtime.queueUrl,
      ReceiptHandle: record.receiptHandle,
      VisibilityTimeout: Math.min(43_200, Math.max(1, Math.ceil(delayMs / 1_000))),
    }),
  );
}

async function moveToDeadLetter(
  record: SQSRecord,
  action: Extract<DeliveryAction, { kind: "dead-letter" }>,
  runtime: AwsRuntime,
): Promise<boolean> {
  if (!runtime.dlqUrl) {
    console.error("inlet permanent delivery failure; no INLET_DLQ_URL configured", {
      messageId: record.messageId,
      reason: action.reason,
      statusCode: action.statusCode,
    });
    return false;
  }

  await runtime.sqs.send(
    new SendMessageCommand({
      QueueUrl: runtime.dlqUrl,
      MessageBody: JSON.stringify({
        failed_at: Date.now(),
        reason: action.reason,
        status_code: action.statusCode,
        source_message_id: record.messageId,
        envelope: parseDeadLetterBody(record.body),
      }),
      MessageGroupId: record.attributes.MessageGroupId ?? "invalid",
      MessageDeduplicationId: `${record.messageId}-${record.attributes.ApproximateReceiveCount}`,
    }),
  );
  return true;
}

function parseDeadLetterBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { raw_body: body };
  }
}

async function getRuntime(): Promise<AwsRuntime> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

async function createRuntime(): Promise<AwsRuntime> {
  const configSource = process.env.INLET_CONFIG;
  if (!configSource) throw new Error("INLET_CONFIG is required");

  const config = parseConfig(configSource);
  const secrets = new AwsSecretResolver();
  const timeoutMs = Number(process.env.INLET_AQUIFER_TIMEOUT_MS ?? "5000");
  const aquifer = new FetchAquiferTransport(config.aquiferUrl, { timeoutMs });

  if (config.delivery === "kafka") {
    const client = await kafkaFromEnv(secrets);
    const writer = new KafkajsWriter(client);
    return {
      config,
      intake: new InletIntake(config, defaultProviders(), secrets, new KafkaEventQueue(config, writer)),
      aquifer,
      secrets,
      sqs: new SQSClient({}),
      queueUrl: "",
      kafka: { client, writer },
    };
  }

  const queueUrl = process.env.INLET_QUEUE_URL;
  if (!queueUrl) throw new Error("INLET_QUEUE_URL is required");
  const queue = new SqsFifoQueue(queueUrl);
  const runtime: AwsRuntime = {
    config,
    intake: new InletIntake(config, defaultProviders(), secrets, queue),
    aquifer,
    secrets,
    sqs: queue.client,
    queueUrl,
  };
  if (process.env.INLET_DLQ_URL) runtime.dlqUrl = process.env.INLET_DLQ_URL;
  return runtime;
}

/**
 * Kafka trigger for delivery: kafka. Lambda's MSK or self-managed Kafka
 * event source delivers records in partition order. Throwing makes Lambda
 * deliver the batch again, which is how an event Aquifer hasn't confirmed
 * gets retried; records already confirmed come back as duplicates.
 */
export async function kafkaHandler(event: KafkaTriggerEvent, context: Pick<Context, "getRemainingTimeInMillis">): Promise<void> {
  const runtime = await getRuntime();
  const kafka = requireKafka(runtime);
  const records: EventRecord[] = [];
  for (const partitionRecords of Object.values(event.records ?? {})) {
    const ordered = [...partitionRecords].sort((left, right) => left.offset - right.offset);
    for (const record of ordered) {
      try {
        records.push(parseEventRecord(Buffer.from(record.value ?? "", "base64").toString("utf8")));
      } catch (error) {
        console.error("inlet skipped a record that isn't an Inlet event", {
          topic: record.topic,
          partition: record.partition,
          offset: record.offset,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (records.length === 0) return;

  const baseUrl = process.env.INLET_PUBLIC_URL;
  if (!baseUrl) throw new Error("INLET_PUBLIC_URL is required for delivery: kafka");
  const secret = await completionSecret(runtime);
  const outcome = await dispatchEvents(records, {
    aquifer: runtime.aquifer,
    confirmation: runtime.config.confirmation,
    completionUrlFor: (record) => completionUrl(baseUrl, secret, record),
    remainingMs: () => context.getRemainingTimeInMillis(),
  });
  await writeResults(kafka.writer, outcome.results);
  if (outcome.unfinished.length > 0) {
    throw new Error(`inlet: ${outcome.unfinished.length} event(s) not yet confirmed by Aquifer; retrying the batch`);
  }
}

/** Scheduled reconciler for delivery: kafka, one pass over every events topic. */
export async function reconcileHandler(): Promise<Record<string, ReconcileSummary>> {
  const runtime = await getRuntime();
  const kafka = requireKafka(runtime);
  const reconcile = runtime.config.kafka!.reconcile;
  const log = new KafkajsReconcileLog(
    kafka.client,
    kafka.writer,
    process.env.INLET_KAFKA_RECONCILER_GROUP ?? "inlet-reconciler",
  );
  const topics = new Set(runtime.config.routes.map((route) => topicsFor(runtime.config, route).eventsTopic));
  const summaries: Record<string, ReconcileSummary> = {};
  for (const topic of topics) {
    summaries[topic] = await reconcileTopic(topic, log, reconcile);
  }
  console.log("inlet reconcile pass", summaries);
  return summaries;
}

/** The Lambda event for MSK and self-managed Kafka triggers. */
export interface KafkaTriggerEvent {
  records?: Record<
    string,
    Array<{ topic: string; partition: number; offset: number; timestamp: number; value?: string }>
  >;
}

function requireKafka(runtime: AwsRuntime): NonNullable<AwsRuntime["kafka"]> {
  if (!runtime.kafka) throw new Error("this handler needs delivery: kafka in INLET_CONFIG");
  return runtime.kafka;
}

async function completionSecret(runtime: AwsRuntime): Promise<string> {
  const ref = process.env.INLET_COMPLETION_SECRET_REF;
  if (!ref) throw new Error("INLET_COMPLETION_SECRET_REF is required for delivery: kafka");
  return runtime.secrets.resolve(ref);
}

async function writeResults(
  writer: KafkajsWriter,
  results: Array<{ topic: string; result: ResultRecord }>,
): Promise<void> {
  const byTopic = new Map<string, ResultRecord[]>();
  for (const { topic, result } of results) {
    const group = byTopic.get(topic) ?? [];
    group.push(result);
    byTopic.set(topic, group);
  }
  const now = Date.now();
  for (const [topic, group] of byTopic) {
    await writer.write(
      topic,
      group.map((result) => ({ key: result.delivery_id, value: JSON.stringify(result), timestamp: now })),
    );
  }
}

function groupRecords(records: SQSRecord[]): Map<string, SQSRecord[]> {
  const groups = new Map<string, SQSRecord[]>();
  for (const record of records) {
    const group = record.attributes.MessageGroupId ?? record.messageId;
    const groupRecords = groups.get(group) ?? [];
    groupRecords.push(record);
    groups.set(group, groupRecords);
  }
  return groups;
}

function parseEnvelope(source: string): DeliveryEnvelope {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) {
    throw new Error("unsupported Inlet queue message");
  }
  return value as DeliveryEnvelope;
}

function compactHeaders(headers: Record<string, string | undefined>): HeadersRecord {
  const result: HeadersRecord = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function decodeBody(body: string, encoded: boolean): Uint8Array {
  return encoded ? Uint8Array.from(Buffer.from(body, "base64")) : new TextEncoder().encode(body);
}

function apiGatewayRequestUrl(event: APIGatewayProxyEventV2): string | undefined {
  const headers = normalizeHeaders(compactHeaders(event.headers));
  const host = headers["x-forwarded-host"] ?? headers.host;
  if (!host) return undefined;
  const protocol = headers["x-forwarded-proto"] ?? "https";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  return `${protocol}://${host}${event.rawPath}${query}`;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

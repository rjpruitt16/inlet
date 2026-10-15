import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import { FetchAquiferTransport } from "../../core/aquifer.js";
import { parseConfig } from "../../core/config.js";
import { deliverEnvelope } from "../../core/delivery.js";
import { InletError } from "../../core/errors.js";
import { normalizeHeaders } from "../../core/headers.js";
import { InletIntake } from "../../core/ingress.js";
import type { DeliveryAction, DeliveryEnvelope, HeadersRecord, InletConfig } from "../../core/types.js";
import { defaultProviders } from "../../providers/index.js";
import { SqsFifoQueue } from "./queue.js";
import { AwsSecretResolver } from "./secrets.js";

interface AwsRuntime {
  config: InletConfig;
  intake: InletIntake;
  aquifer: FetchAquiferTransport;
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl?: string;
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
  const queueUrl = process.env.INLET_QUEUE_URL;
  if (!configSource) throw new Error("INLET_CONFIG is required");
  if (!queueUrl) throw new Error("INLET_QUEUE_URL is required");

  const config = parseConfig(configSource);
  const queue = new SqsFifoQueue(queueUrl);
  const timeoutMs = Number(process.env.INLET_AQUIFER_TIMEOUT_MS ?? "5000");
  const runtime: AwsRuntime = {
    config,
    intake: new InletIntake(config, defaultProviders(), new AwsSecretResolver(), queue),
    aquifer: new FetchAquiferTransport(config.aquiferUrl, { timeoutMs }),
    sqs: queue.client,
    queueUrl,
  };
  if (process.env.INLET_DLQ_URL) runtime.dlqUrl = process.env.INLET_DLQ_URL;
  return runtime;
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

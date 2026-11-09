import { constantTimeEqual, utf8 } from "../encoding.js";
import { InletError } from "../errors.js";
import type { HeadersRecord, InletConfig } from "../types.js";
import type { KafkaWriter } from "./queue.js";

/** Where Aquifer's transcript export (AQUIFER_WS_EXPORT_URL) posts batches. */
export const websocketExportPath = "/_inlet/websocket-events";

/**
 * Kafka's default maximum message size is 1 MB; INLET_KAFKA_MAX_RECORD_BYTES
 * overrides it for topics configured larger. A larger record would fail
 * partway through the write, so the batch is refused first.
 */
export const defaultMaxRecordBytes = 1_000_000;

/**
 * One WebSocket message on the WebSocket topic, keyed by session_id so a
 * session's messages stay in order. Exported at least once: drop repeats
 * by session_id + stream_id.
 */
export interface WebSocketRecord {
  schema: "inlet.websocket.v1";
  session_id: string;
  /** The transcript entry's ID, the cursor clients replay from. */
  stream_id: string;
  direction: string;
  type: string;
  message_id?: string;
  caused_by?: string;
  generation?: number;
  payload?: unknown;
  recorded_at: number;
  /** The Aquifer node that exported it. */
  node_id?: string;
}

/**
 * Writes one batch from Aquifer's transcript export to the WebSocket
 * topic. Returns how many messages it wrote. Throws InletError for
 * requests that aren't an authorized, well-formed batch; a Kafka failure
 * propagates, so Aquifer gets a non-2xx and sends the batch again.
 */
export async function recordWebSocketBatch(
  headers: HeadersRecord,
  body: Uint8Array,
  token: string,
  config: InletConfig,
  writer: KafkaWriter,
  maxRecordBytes = defaultMaxRecordBytes,
): Promise<number> {
  if (config.kafka === undefined) {
    throw new InletError("WebSocket export needs delivery: kafka", 404, "not_found");
  }
  const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? "";
  if (!constantTimeEqual(utf8(authorization), utf8(`Bearer ${token}`))) {
    throw new InletError("WebSocket export token is invalid", 401, "invalid_export_token");
  }

  let batch: { schema?: unknown; node_id?: unknown; events?: unknown };
  try {
    batch = JSON.parse(new TextDecoder().decode(body)) as typeof batch;
  } catch {
    throw new InletError("batch must be JSON", 400, "invalid_batch");
  }
  if (batch.schema !== "aquifer.websocket_batch.v1" || !Array.isArray(batch.events)) {
    throw new InletError("batch must be aquifer.websocket_batch.v1 with an events array", 400, "invalid_batch");
  }

  const nodeId = typeof batch.node_id === "string" ? batch.node_id : undefined;
  const messages: Array<{ key: string; value: string; timestamp: number }> = [];
  for (const raw of batch.events) {
    const record = webSocketRecord(raw, nodeId);
    if (record === undefined) {
      throw new InletError("every event needs session_id, stream_id, direction, type and recorded_at", 400, "invalid_batch");
    }
    const value = JSON.stringify(record);
    if (new TextEncoder().encode(value).length > maxRecordBytes) {
      // 413: Aquifer halves the batch, and skips a single message that
      // still doesn't fit.
      throw new InletError(
        `message ${record.session_id}/${record.stream_id} is over the ${maxRecordBytes}-byte record limit`,
        413,
        "record_too_large",
      );
    }
    messages.push({ key: record.session_id, value, timestamp: record.recorded_at });
  }
  await writer.write(config.kafka.websocketTopic, messages);
  return messages.length;
}

function webSocketRecord(raw: unknown, nodeId: string | undefined): WebSocketRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const event = raw as Record<string, unknown>;
  const text = (name: string): string | undefined =>
    typeof event[name] === "string" && (event[name] as string).length > 0 ? (event[name] as string) : undefined;
  const sessionId = text("session_id");
  const streamId = text("stream_id");
  const direction = text("direction");
  const type = text("type");
  if (!sessionId || !streamId || !direction || !type || typeof event.recorded_at !== "number") return undefined;

  const record: WebSocketRecord = {
    schema: "inlet.websocket.v1",
    session_id: sessionId,
    stream_id: streamId,
    direction,
    type,
    recorded_at: event.recorded_at,
  };
  const messageId = text("message_id");
  if (messageId) record.message_id = messageId;
  const causedBy = text("caused_by");
  if (causedBy) record.caused_by = causedBy;
  if (typeof event.generation === "number") record.generation = event.generation;
  if (event.payload !== undefined) record.payload = event.payload;
  if (nodeId) record.node_id = nodeId;
  return record;
}

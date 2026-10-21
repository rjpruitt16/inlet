import { randomUUID } from "node:crypto";
import { Kafka, logLevel, type Admin, type Producer, type SASLOptions } from "kafkajs";
import type { KafkaWriter } from "../../core/kafka/queue.js";
import type { ReconcileLog } from "../../core/kafka/reconcile.js";
import { parseEventRecord, parseResultRecord, type EventRecord, type ResultRecord } from "../../core/kafka/records.js";
import type { SecretResolver } from "../../core/types.js";

/**
 * Kafka connection settings from the environment, so any Kafka works:
 * Confluent, Redpanda, MSK or self-hosted.
 *
 * INLET_KAFKA_BROKERS          host:port[,host:port]
 * INLET_KAFKA_SSL              "false" to turn TLS off (default on)
 * INLET_KAFKA_SASL_MECHANISM   scram-sha-512 | scram-sha-256 | plain (default: no SASL)
 * INLET_KAFKA_SECRET_REF       secret holding {"username","password"}, the same
 *                              Secrets Manager format Lambda's Kafka trigger reads
 */
export async function kafkaFromEnv(secrets: SecretResolver): Promise<Kafka> {
  const brokers = (process.env.INLET_KAFKA_BROKERS ?? "")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);
  if (brokers.length === 0) throw new Error("INLET_KAFKA_BROKERS is required for delivery: kafka");

  const mechanism = process.env.INLET_KAFKA_SASL_MECHANISM?.toLowerCase();
  let sasl: SASLOptions | undefined;
  if (mechanism) {
    if (mechanism !== "scram-sha-512" && mechanism !== "scram-sha-256" && mechanism !== "plain") {
      throw new Error("INLET_KAFKA_SASL_MECHANISM must be scram-sha-512, scram-sha-256 or plain");
    }
    const ref = process.env.INLET_KAFKA_SECRET_REF;
    if (!ref) throw new Error("INLET_KAFKA_SECRET_REF is required with INLET_KAFKA_SASL_MECHANISM");
    const credentials = JSON.parse(await secrets.resolve(ref)) as { username?: string; password?: string };
    if (!credentials.username || !credentials.password) {
      throw new Error("the Kafka secret must be JSON with username and password");
    }
    sasl = { mechanism, username: credentials.username, password: credentials.password };
  }

  const config: ConstructorParameters<typeof Kafka>[0] = {
    clientId: "inlet",
    brokers,
    ssl: process.env.INLET_KAFKA_SSL !== "false",
    logLevel: logLevel.WARN,
  };
  if (sasl) config.sasl = sasl;
  return new Kafka(config);
}

export class KafkajsWriter implements KafkaWriter {
  private producer: Producer | undefined;
  private connecting: Promise<Producer> | undefined;

  constructor(private readonly kafka: Kafka) {}

  async write(topic: string, messages: Array<{ key: string; value: string; timestamp: number }>): Promise<void> {
    if (messages.length === 0) return;
    const producer = await this.connected();
    await producer.send({
      topic,
      acks: -1,
      messages: messages.map((message) => ({
        key: message.key,
        value: message.value,
        timestamp: String(message.timestamp),
      })),
    });
  }

  async close(): Promise<void> {
    await this.producer?.disconnect();
    this.producer = undefined;
    this.connecting = undefined;
  }

  private async connected(): Promise<Producer> {
    if (this.producer) return this.producer;
    this.connecting ??= (async () => {
      const producer = this.kafka.producer({ allowAutoTopicCreation: false });
      await producer.connect();
      this.producer = producer;
      return producer;
    })();
    return this.connecting;
  }
}

interface RawMessage {
  partition: number;
  offset: string;
  timestamp: number;
  value: string;
}

/**
 * The reconciler's Kafka access. Its cursor is a consumer group that never
 * joins: offsets are read and written through the admin API, and topics are
 * read with a short-lived reader that seeks to the range it needs.
 */
export class KafkajsReconcileLog implements ReconcileLog {
  constructor(
    private readonly kafka: Kafka,
    private readonly writer: KafkajsWriter,
    private readonly cursorGroup: string,
    private readonly readTimeoutMs = 60_000,
  ) {}

  async readOverdue(eventsTopic: string, now: Date): Promise<{ events: EventRecord[]; commit(): Promise<void> }> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const ends = await highWatermarks(admin, eventsTopic);
      const committed = await admin.fetchOffsets({ groupId: this.cursorGroup, topics: [eventsTopic] });
      const lows = await lowWatermarks(admin, eventsTopic);
      const starts = new Map<number, bigint>();
      for (const [partition, low] of lows) {
        const stored = committed[0]?.partitions.find((entry) => entry.partition === partition)?.offset;
        const cursor = stored !== undefined && stored !== "-1" ? BigInt(stored) : low;
        starts.set(partition, cursor < low ? low : cursor);
      }

      const events: EventRecord[] = [];
      const next = new Map<number, bigint>();
      await this.readRange(eventsTopic, starts, ends, (message) => {
        let record: EventRecord;
        try {
          record = parseEventRecord(message.value);
        } catch {
          // Not an Inlet event: step over it.
          next.set(message.partition, BigInt(message.offset) + 1n);
          return "continue";
        }
        if (Date.parse(record.reconcile_after) > now.getTime()) return "stop";
        events.push(record);
        next.set(message.partition, BigInt(message.offset) + 1n);
        return "continue";
      });

      return {
        events,
        commit: async () => {
          if (next.size === 0) return;
          const commitAdmin = this.kafka.admin();
          await commitAdmin.connect();
          try {
            await commitAdmin.setOffsets({
              groupId: this.cursorGroup,
              topic: eventsTopic,
              partitions: Array.from(next, ([partition, offset]) => ({ partition, offset: offset.toString() })),
            });
          } finally {
            await commitAdmin.disconnect();
          }
        },
      };
    } finally {
      await admin.disconnect();
    }
  }

  async readResults(resultsTopic: string, from: Date, to: Date): Promise<ResultRecord[]> {
    const admin = this.kafka.admin();
    await admin.connect();
    let starts: Map<number, bigint>;
    let ends: Map<number, bigint>;
    try {
      ends = await highWatermarks(admin, resultsTopic);
      const byTime = await admin.fetchTopicOffsetsByTimestamp(resultsTopic, from.getTime());
      starts = new Map(byTime.map((entry) => [entry.partition, BigInt(entry.offset)]));
    } finally {
      await admin.disconnect();
    }

    const results: ResultRecord[] = [];
    await this.readRange(resultsTopic, starts, ends, (message) => {
      if (message.timestamp > to.getTime()) return "stop";
      const result = parseResultRecord(message.value);
      if (result) results.push(result);
      return "continue";
    });
    return results;
  }

  write(topic: string, messages: Array<{ key: string; value: string; timestamp: number }>): Promise<void> {
    return this.writer.write(topic, messages);
  }

  /**
   * Reads each partition from its start offset up to (not including) its
   * end offset, or until visit() returns "stop" for that partition.
   */
  private async readRange(
    topic: string,
    starts: Map<number, bigint>,
    ends: Map<number, bigint>,
    visit: (message: RawMessage) => "continue" | "stop",
  ): Promise<void> {
    const open = new Set<number>();
    for (const [partition, start] of starts) {
      if (start < (ends.get(partition) ?? 0n)) open.add(partition);
    }
    if (open.size === 0) return;

    const consumer = this.kafka.consumer({
      groupId: `inlet-reader-${randomUUID()}`,
      allowAutoTopicCreation: false,
    });
    await consumer.connect();
    try {
      await consumer.subscribe({ topic, fromBeginning: true });
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const close = (partition: number): void => {
        if (!open.delete(partition)) return;
        consumer.pause([{ topic, partitions: [partition] }]);
        if (open.size === 0) finish();
      };

      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: async ({ batch }) => {
          const partition = batch.partition;
          if (!open.has(partition)) return;
          const end = ends.get(partition) ?? 0n;
          for (const message of batch.messages) {
            const offset = BigInt(message.offset);
            if (offset < (starts.get(partition) ?? 0n)) continue;
            if (offset >= end) {
              close(partition);
              return;
            }
            const verdict = visit({
              partition,
              offset: message.offset,
              timestamp: Number(message.timestamp),
              value: message.value?.toString("utf8") ?? "",
            });
            if (verdict === "stop" || offset + 1n >= end) {
              close(partition);
              return;
            }
          }
        },
      });
      for (const [partition, start] of starts) {
        if (open.has(partition)) consumer.seek({ topic, partition, offset: start.toString() });
      }

      const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.readTimeoutMs));
      await Promise.race([finished, timeout]);
    } finally {
      await consumer.disconnect();
    }
  }
}

async function highWatermarks(admin: Admin, topic: string): Promise<Map<number, bigint>> {
  const offsets = await admin.fetchTopicOffsets(topic);
  return new Map(offsets.map((entry) => [entry.partition, BigInt(entry.high)]));
}

async function lowWatermarks(admin: Admin, topic: string): Promise<Map<number, bigint>> {
  const offsets = await admin.fetchTopicOffsets(topic);
  return new Map(offsets.map((entry) => [entry.partition, BigInt(entry.low)]));
}

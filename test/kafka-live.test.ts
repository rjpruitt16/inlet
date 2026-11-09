import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Kafka, logLevel } from "kafkajs";
import { reconcileTopic } from "../src/core/kafka/reconcile.js";
import { eventRecordFromEnvelope, type EventRecord, type ResultRecord } from "../src/core/kafka/records.js";
import { KafkajsReconcileLog, KafkajsWriter } from "../src/runtimes/aws/kafka.js";

// Runs against a real Kafka when INLET_KAFKA_TEST_BROKERS is set, e.g.
//   docker run -d -p 19092:19092 docker.redpanda.com/redpandadata/redpanda:v24.2.7 \
//     redpanda start --mode dev-container --smp 1 --memory 512M \
//     --kafka-addr internal://0.0.0.0:9092,external://0.0.0.0:19092 \
//     --advertise-kafka-addr internal://localhost:9092,external://localhost:19092
//   INLET_KAFKA_TEST_BROKERS=localhost:19092 npm test
const brokers = process.env.INLET_KAFKA_TEST_BROKERS;

test("reconciler cursor, results search and redrive against a real Kafka", { skip: !brokers }, async () => {
  const kafka = new Kafka({ clientId: "inlet-test", brokers: brokers!.split(","), logLevel: logLevel.NOTHING });
  const suffix = randomUUID().slice(0, 8);
  const eventsTopic = `inlet-test-events-${suffix}`;
  const resultsTopic = `inlet-test-results-${suffix}`;
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [
      { topic: eventsTopic, numPartitions: 3 },
      { topic: resultsTopic, numPartitions: 3 },
    ],
  });
  await admin.disconnect();

  const writer = new KafkajsWriter(kafka);
  const log = new KafkajsReconcileLog(kafka, writer, `inlet-test-cursor-${suffix}`, 20_000);
  const config = { afterSeconds: 60, searchWindowSeconds: 600, maxRedrives: 3 };
  const now = new Date();
  const past = new Date(now.getTime() - 120_000);

  try {
    const done = await event("done", "user-a", eventsTopic, resultsTopic, past);
    const lost = await event("lost", "user-b", eventsTopic, resultsTopic, past);
    const notYet = await event("not-yet", "user-a", eventsTopic, resultsTopic, now);
    for (const record of [done, lost, notYet]) {
      await writer.write(eventsTopic, [
        { key: record.partition_key, value: JSON.stringify(record), timestamp: Date.parse(record.written_at) },
      ]);
    }
    await writer.write(resultsTopic, [
      { key: done.delivery_id, value: JSON.stringify(completed(done)), timestamp: past.getTime() + 1_000 },
    ]);

    const first = await reconcileTopic(eventsTopic, log, config, now);
    assert.deepEqual(first, { checked: 2, ok: 1, redriven: 1, gaveUp: 0 });

    // The cursor moved past both checked events, so a second pass finds
    // nothing due: not-yet and the new redrive are both in the future.
    const second = await reconcileTopic(eventsTopic, log, config, now);
    assert.deepEqual(second, { checked: 0, ok: 0, redriven: 0, gaveUp: 0 });

    // An hour later the redrive and not-yet are due; neither has a result.
    const later = await reconcileTopic(eventsTopic, log, config, new Date(now.getTime() + 3_600_000));
    assert.equal(later.checked, 2);
    assert.equal(later.redriven, 2);
  } finally {
    await writer.close();
    const cleanup = kafka.admin();
    await cleanup.connect();
    await cleanup.deleteTopics({ topics: [eventsTopic, resultsTopic] }).catch(() => {});
    await cleanup.disconnect();
  }
});

async function event(
  eventId: string,
  userId: string,
  eventsTopic: string,
  resultsTopic: string,
  writtenAt: Date,
): Promise<EventRecord> {
  return eventRecordFromEnvelope(
    {
      version: 1,
      routeId: "github-main",
      provider: "github",
      eventId,
      eventType: "push",
      userId,
      destination: "https://backend.example/github",
      receivedAt: writtenAt.getTime(),
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from("{}").toString("base64"),
    },
    `key-${userId}`,
    { eventsTopic, resultsTopic },
    60,
    writtenAt,
  );
}

function completed(record: EventRecord): ResultRecord {
  return {
    schema: "inlet.result.v1",
    delivery_id: record.delivery_id,
    event_id: record.event_id,
    route_id: record.route_id,
    provider: record.provider,
    user_id: record.user_id,
    redrive: 0,
    key_generation: 0,
    status: "completed",
    recorded_at: new Date().toISOString(),
    source: "completion",
  };
}

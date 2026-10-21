import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/core/config.js";
import { dispatchEvents } from "../src/core/kafka/dispatch.js";
import { KafkaEventQueue, recordCompletion } from "../src/core/kafka/queue.js";
import { decide, reconcileTopic, type ReconcileLog } from "../src/core/kafka/reconcile.js";
import {
  completionUrl,
  eventRecordFromEnvelope,
  type EventRecord,
  type ResultRecord,
} from "../src/core/kafka/records.js";
import type { AquiferResponse, AquiferTransport, DeliveryEnvelope } from "../src/core/types.js";

const kafkaConfig = `
aquifer_url: http://aquifer.internal:8080
delivery: kafka
confirmation:
  delay_ms: 1
  jitter_ratio: 0
  base_backoff_ms: 1
  max_backoff_ms: 2
kafka:
  reconcile:
    after_seconds: 60
    search_window_seconds: 120
    max_redrives: 2
routes:
  - id: github-main
    path: /webhooks/github
    provider: github
    secret_ref: GITHUB_SECRET
    destination: https://backend.example/github
  - id: stripe-main
    path: /webhooks/stripe
    provider: stripe
    secret_ref: STRIPE_SECRET
    destination: https://backend.example/stripe
    events_topic: billing.events
    results_topic: billing.results
`;

test("parseConfig defaults delivery to sqs and reads Kafka settings and route topics", () => {
  const sqs = parseConfig(`
aquifer_url: http://aquifer:8080
routes:
  - { id: one, path: /hook, provider: github, secret_ref: A, destination: https://one.example/hook }
`);
  assert.equal(sqs.delivery, "sqs");
  assert.equal(sqs.kafka, undefined);

  const config = parseConfig(kafkaConfig);
  assert.equal(config.delivery, "kafka");
  assert.equal(config.kafka?.eventsTopic, "inlet.events");
  assert.equal(config.kafka?.resultsTopic, "inlet.results");
  assert.deepEqual(config.kafka?.reconcile, { afterSeconds: 60, searchWindowSeconds: 120, maxRedrives: 2 });
  assert.equal(config.routes[1]?.eventsTopic, "billing.events");
});

test("parseConfig rejects Kafka settings that don't fit together", () => {
  const route = "routes:\n  - { id: one, path: /hook, provider: github, secret_ref: A, destination: https://one.example/hook";
  assert.throws(() => parseConfig(`aquifer_url: http://a:1\nkafka: {}\n${route} }`), /require delivery: kafka/);
  assert.throws(() => parseConfig(`aquifer_url: http://a:1\n${route}, events_topic: x }`), /topics require delivery: kafka/);
  assert.throws(
    () => parseConfig(`aquifer_url: http://a:1\ndelivery: kafka\n${route}, completion_url: https://x.example }`),
    /completion_url can't be used/,
  );
  assert.throws(
    () => parseConfig(`aquifer_url: http://a:1\ndelivery: kafka\nkafka: { reconcile: { after_seconds: 600, search_window_seconds: 60 } }\n${route} }`),
    /search_window_seconds must be at least after_seconds/,
  );
  assert.throws(() => parseConfig(`aquifer_url: http://a:1\ndelivery: kafka\n${route}, events_topic: "bad topic" }`), /topic name/);
});

test("KafkaEventQueue writes the event to its route's topic, keyed by the SQS group ID", async () => {
  const config = parseConfig(kafkaConfig);
  const writes: Array<{ topic: string; key: string; record: EventRecord }> = [];
  const queue = new KafkaEventQueue(config, {
    async write(topic, messages) {
      for (const message of messages) writes.push({ topic, key: message.key, record: JSON.parse(message.value) });
    },
  });

  await queue.send(envelope("evt-1", "stripe-main", "acct_1"), "group-hash");

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.topic, "billing.events");
  assert.equal(writes[0]?.key, "group-hash");
  const record = writes[0]!.record;
  assert.equal(record.schema, "inlet.event.v1");
  assert.equal(record.partition_key, "group-hash");
  assert.equal(record.results_topic, "billing.results");
  assert.equal(record.idempotency_key, "inlet:stripe:stripe-main:evt-1");
  assert.equal(record.content_type, "application/json");
  assert.equal(record.redrive, 0);
  assert.equal(Date.parse(record.reconcile_after) - Date.parse(record.written_at), 60_000);
});

test("dispatch keeps one user's events in order and waits once to confirm the batch", async () => {
  const aquifer: ScriptedAquifer = new ScriptedAquifer((body): AquiferResponse => {
    const seen = aquifer.calls.filter((call: { idempotent_key: string }) => call.idempotent_key === body.idempotent_key).length;
    return seen === 1 ? accepted(body.idempotent_key) : duplicate(body.idempotent_key);
  });
  let sleeps = 0;
  const records = await Promise.all([
    record("a1", "user-a"),
    record("b1", "user-b"),
    record("a2", "user-a"),
  ]);

  const outcome = await dispatchEvents(records, {
    aquifer,
    confirmation: parseConfig(kafkaConfig).confirmation,
    completionUrlFor: async () => "https://inlet.example/_inlet/completions?x=1",
    remainingMs: () => 600_000,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.deepEqual(outcome.unfinished, []);
  assert.equal(sleeps, 1, "one confirmation wait for the whole batch");
  assert.deepEqual(
    outcome.results.map(({ result }) => [result.event_id, result.status]).sort(),
    [["a1", "owned"], ["a2", "owned"], ["b1", "owned"]],
  );
  const firstPass = aquifer.calls.slice(0, 3).map((call) => call.idempotent_key);
  assert.ok(
    firstPass.indexOf("inlet:github:github-main:a1") < firstPass.indexOf("inlet:github:github-main:a2"),
    "user-a's first event is submitted before its second",
  );
  assert.equal(aquifer.calls[0]?.webhook_url, "https://inlet.example/_inlet/completions?x=1");
});

test("dispatch holds a user's later events behind one it can't deliver yet", async () => {
  const aquifer = new ScriptedAquifer((body) =>
    body.idempotent_key.endsWith(":a1") ? { statusCode: 503, headers: {}, body: { error: "busy" } } : accepted(body.idempotent_key),
  );
  const records = await Promise.all([record("a1", "user-a"), record("a2", "user-a")]);

  const outcome = await dispatchEvents(records, {
    aquifer,
    confirmation: parseConfig(kafkaConfig).confirmation,
    completionUrlFor: async () => "https://inlet.example/c",
    remainingMs: () => 0,
    sleep: async () => {},
  });

  assert.deepEqual(outcome.unfinished.map((event) => event.event_id), ["a1", "a2"]);
  assert.ok(!aquifer.calls.some((call: { idempotent_key: string }) => call.idempotent_key.endsWith(":a2")), "a2 must not overtake a1");
});

test("dispatch records Aquifer's permanent rejections as dead_letter", async () => {
  const aquifer = new ScriptedAquifer(() => ({ statusCode: 400, headers: {}, body: { error: "url is not allowed" } }));
  const outcome = await dispatchEvents([await record("x1", "user-x")], {
    aquifer,
    confirmation: parseConfig(kafkaConfig).confirmation,
    completionUrlFor: async () => "https://inlet.example/c",
    remainingMs: () => 600_000,
    sleep: async () => {},
  });
  assert.deepEqual(outcome.unfinished, []);
  assert.equal(outcome.results[0]?.result.status, "dead_letter");
  assert.equal(outcome.results[0]?.result.reason, "url is not allowed");
});

test("a signed completion is written to the route's results topic; a forged one is refused", async () => {
  const config = parseConfig(kafkaConfig);
  const event = await record("evt-9", "user-9");
  const url = new URL(await completionUrl("https://inlet.example/", "s3cret", event));
  const writes: Array<{ topic: string; result: ResultRecord }> = [];
  const writer = {
    async write(topic: string, messages: Array<{ value: string }>) {
      for (const message of messages) writes.push({ topic, result: JSON.parse(message.value) });
    },
  };
  const body = new TextEncoder().encode(JSON.stringify({ job_id: "job-9", status: "completed", response_status: 202, body: "secret body" }));

  const result = await recordCompletion(url.searchParams, body, "s3cret", config, writer);
  assert.equal(result.status, "completed");
  assert.equal(writes[0]?.topic, "inlet.results");
  assert.equal(writes[0]?.result.delivery_id, event.delivery_id);
  assert.equal(writes[0]?.result.response_status, 202);
  assert.ok(!JSON.stringify(writes[0]).includes("secret body"), "the destination's response body isn't stored");

  url.searchParams.set("redrive", "1");
  await assert.rejects(recordCompletion(url.searchParams, body, "s3cret", config, writer), /signature is invalid/);
});

test("decide: completed is done, failed reruns with a new key, missing reruns with the same key", async () => {
  const event = await record("e1", "u1");
  const result = (status: ResultRecord["status"], redrive = 0): ResultRecord => ({
    schema: "inlet.result.v1",
    delivery_id: event.delivery_id,
    event_id: event.event_id,
    route_id: event.route_id,
    provider: event.provider,
    user_id: event.user_id,
    redrive,
    key_generation: 0,
    status,
    recorded_at: new Date().toISOString(),
    source: "completion",
  });

  assert.deepEqual(decide(event, [result("owned"), result("completed")], 3), { kind: "ok" });
  assert.deepEqual(decide(event, [result("dead_letter")], 3), { kind: "ok" });
  assert.deepEqual(decide(event, [result("failed")], 3), { kind: "redrive", newKey: true, reason: "failed" });
  assert.deepEqual(decide(event, [result("owned")], 3), { kind: "redrive", newKey: false, reason: "no_completion" });
  assert.deepEqual(decide(event, [], 3), { kind: "redrive", newKey: false, reason: "no_result" });
  assert.deepEqual(decide(event, [result("completed", 1)], 3), { kind: "redrive", newKey: false, reason: "no_result" },
    "a later copy's result doesn't count for this copy");
  assert.deepEqual(decide({ ...event, redrive: 3 }, [], 3), { kind: "gave_up", reason: "no_result" });
});

test("reconcile stops at the first event that isn't due, redrives missing ones, then moves the cursor", async () => {
  const config = parseConfig(kafkaConfig).kafka!.reconcile;
  const now = new Date("2026-10-20T12:00:00Z");
  const due = (id: string) => record(id, "u", new Date(now.getTime() - 120_000));
  const done = await due("done");
  const lost = await due("lost");
  const failed = await due("failed");
  const notYet = await record("not-yet", "u", new Date(now.getTime() - 10_000));

  const log = new MemoryLog([done, lost, failed, notYet], [
    resultOf(done, "completed"),
    resultOf(failed, "failed"),
  ]);
  const summary = await reconcileTopic("inlet.events", log, config, now);

  assert.deepEqual(summary, { checked: 3, ok: 1, redriven: 2, gaveUp: 0 });
  assert.equal(log.cursor, 3, "the cursor stops before the event that isn't due");
  const redrives = log.written.filter((write) => write.topic === "inlet.events").map((write) => JSON.parse(write.value) as EventRecord);
  assert.deepEqual(redrives.map((event) => [event.event_id, event.redrive, event.key_generation, event.idempotency_key]), [
    ["lost", 1, 0, "inlet:github:github-main:lost"],
    ["failed", 1, 1, "inlet:github:github-main:failed:r1"],
  ]);
  assert.equal(log.written[0]?.key, lost.partition_key, "a redrive stays in its user's partition");
  const outcomes = log.written.filter((write) => write.topic === "inlet.results").map((write) => JSON.parse(write.value) as ResultRecord);
  assert.deepEqual(outcomes.map((result) => [result.event_id, result.status]), [["lost", "redriven"], ["failed", "redriven"]]);
  const eventsIndex = log.written.findIndex((write) => write.topic === "inlet.events");
  const resultsIndex = log.written.findIndex((write) => write.topic === "inlet.results");
  assert.ok(eventsIndex < resultsIndex, "the redrive is written before it is recorded");
});

test("reconcile gives up after max_redrives", async () => {
  const config = parseConfig(kafkaConfig).kafka!.reconcile;
  const now = new Date("2026-10-20T12:00:00Z");
  const exhausted = { ...(await record("tired", "u", new Date(now.getTime() - 120_000))), redrive: 2 };
  const log = new MemoryLog([exhausted], []);

  const summary = await reconcileTopic("inlet.events", log, config, now);
  assert.deepEqual(summary, { checked: 1, ok: 0, redriven: 0, gaveUp: 1 });
  assert.equal(log.written.length, 1);
  assert.equal((JSON.parse(log.written[0]!.value) as ResultRecord).status, "gave_up");
});

class MemoryLog implements ReconcileLog {
  cursor = 0;
  written: Array<{ topic: string; key: string; value: string }> = [];
  constructor(
    private readonly events: EventRecord[],
    private readonly results: ResultRecord[],
  ) {}

  async readOverdue(_topic: string, now: Date) {
    const overdue: EventRecord[] = [];
    let next = this.cursor;
    for (const event of this.events.slice(this.cursor)) {
      if (Date.parse(event.reconcile_after) > now.getTime()) break;
      overdue.push(event);
      next += 1;
    }
    return {
      events: overdue,
      commit: async () => {
        this.cursor = next;
      },
    };
  }

  async readResults() {
    return this.results;
  }

  async write(topic: string, messages: Array<{ key: string; value: string }>) {
    for (const message of messages) this.written.push({ topic, key: message.key, value: message.value });
  }
}

class ScriptedAquifer implements AquiferTransport {
  calls: Array<{ idempotent_key: string; webhook_url?: string }> = [];
  constructor(private readonly respond: (body: { idempotent_key: string }) => AquiferResponse) {}
  async submit(envelope: DeliveryEnvelope): Promise<AquiferResponse> {
    const call: { idempotent_key: string; webhook_url?: string } = { idempotent_key: envelope.idempotencyKey ?? "" };
    if (envelope.completionUrl !== undefined) call.webhook_url = envelope.completionUrl;
    this.calls.push(call);
    return this.respond(call);
  }
}

function accepted(key: string): AquiferResponse {
  return { statusCode: 201, headers: {}, body: { job_id: `job-${key}`, status: "queued" } };
}

function duplicate(key: string): AquiferResponse {
  return { statusCode: 200, headers: {}, body: { job_id: `job-${key}`, status: "queued", duplicate: true } };
}

function envelope(eventId: string, routeId = "github-main", userId = "user-1"): DeliveryEnvelope {
  return {
    version: 1,
    routeId,
    provider: routeId.startsWith("stripe") ? "stripe" : "github",
    eventId,
    eventType: "push",
    userId,
    destination: "https://backend.example/github",
    receivedAt: Date.parse("2026-10-20T11:00:00Z"),
    headers: { "content-type": "application/json", "x-inlet-event-id": eventId },
    bodyBase64: Buffer.from("{}").toString("base64"),
  };
}

async function record(eventId: string, userId: string, writtenAt = new Date()): Promise<EventRecord> {
  return eventRecordFromEnvelope(
    envelope(eventId, "github-main", userId),
    `key-${userId}`,
    { eventsTopic: "inlet.events", resultsTopic: "inlet.results" },
    60,
    writtenAt,
  );
}

function resultOf(event: EventRecord, status: ResultRecord["status"]): ResultRecord {
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
    recorded_at: new Date().toISOString(),
    source: "completion",
  };
}

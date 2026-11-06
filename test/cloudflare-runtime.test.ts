import assert from "node:assert/strict";
import test from "node:test";
import { InletQueueObject } from "../src/runtimes/cloudflare/runtime.js";
import type {
  CloudflareEnv,
  DurableObjectStorageLike,
} from "../src/runtimes/cloudflare/types.js";
import type { DeliveryEnvelope } from "../src/core/types.js";

test("Durable Object keeps FIFO head until Aquifer confirms it", async () => {
  const storage = new MemoryStorage();
  const responses = [
    new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 201 }),
    new Response(JSON.stringify({ job_id: "job-1", status: "queued", duplicate: true }), { status: 200 }),
    new Response(JSON.stringify({ job_id: "job-2", status: "queued" }), { status: 201 }),
    new Response(JSON.stringify({ job_id: "job-2", status: "queued", duplicate: true }), { status: 200 }),
  ];
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses.shift();
    if (!response) throw new Error("unexpected Aquifer request");
    return response;
  };

  try {
    const object = new InletQueueObject({ storage }, env());
    await enqueue(object, envelope("event-1"), "dedup-1");
    await enqueue(object, envelope("event-2"), "dedup-2");

    await object.alarm();
    assert.equal(requests.length, 1, "second event must remain blocked after the first 201");
    assert.ok(await storage.get("message:00000000000000000001"));

    await object.alarm();
    assert.equal(requests.length, 2);
    assert.equal(await storage.get("message:00000000000000000001"), undefined);
    assert.ok(storage.alarm !== null, "the next event should be scheduled after confirmation");

    await object.alarm();
    assert.equal(requests.length, 3);
    assert.equal((requests[2]?.idempotent_key as string).endsWith("event-2"), true);

    await object.alarm();
    assert.equal(requests.length, 4);
    assert.equal(await storage.get("head"), undefined);
    assert.equal(await storage.get("tail"), undefined);
    assert.equal(storage.values.size, 0, "a drained fairness queue should leave no stored state");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Durable Object cleanup preserves an enqueue that arrives during confirmation", async () => {
  const storage = new MemoryStorage();
  const originalFetch = globalThis.fetch;
  let object!: InletQueueObject;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 201 });
    }
    await enqueue(object, envelope("event-2"), "dedup-2");
    return new Response(
      JSON.stringify({ job_id: "job-1", status: "queued", duplicate: true }),
      { status: 200 },
    );
  };

  try {
    object = new InletQueueObject({ storage }, env());
    await enqueue(object, envelope("event-1"), "dedup-1");
    await object.alarm();
    await object.alarm();

    assert.equal(await storage.get("head"), 2);
    assert.equal(await storage.get("tail"), 2);
    assert.ok(await storage.get("message:00000000000000000002"));
    assert.ok(storage.alarm !== null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function enqueue(
  object: InletQueueObject,
  value: DeliveryEnvelope,
  deduplicationId: string,
): Promise<void> {
  const response = await object.fetch(
    new Request("https://inlet.internal/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: value, deduplicationId }),
    }),
  );
  assert.equal(response.status, 202);
}

function env(): CloudflareEnv {
  return {
    INLET_CONFIG: `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: github-main
    path: /webhooks/github
    provider: github
    secret_ref: GITHUB_SECRET
    destination: https://backend.example/github
`,
    INLET_ORDERING: {
      idFromName() { return {}; },
      get() { throw new Error("unused"); },
    },
  };
}

function envelope(eventId: string): DeliveryEnvelope {
  return {
    version: 1,
    routeId: "github-main",
    provider: "github",
    eventId,
    eventType: "push",
    userId: "installation-42",
    destination: "https://backend.example/github",
    receivedAt: 0,
    headers: { "content-type": "application/json" },
    bodyBase64: "e30=",
  };
}

class MemoryStorage implements DurableObjectStorageLike {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(closure: (transaction: DurableObjectStorageLike) => Promise<T>): Promise<T> {
    return closure(this);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }
}

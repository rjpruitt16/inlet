import assert from "node:assert/strict";
import test from "node:test";
import { deliverEnvelope } from "../src/core/delivery.js";
import type {
  AquiferResponse,
  AquiferTransport,
  ConfirmationConfig,
  DeliveryEnvelope,
} from "../src/core/types.js";

const confirmation: ConfirmationConfig = {
  delayMs: 4_000,
  jitterRatio: 0.2,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

test("a new Aquifer job records the first observation for delayed confirmation", async () => {
  const action = await deliverEnvelope(
    envelope(),
    1,
    transport({ statusCode: 201, headers: {}, body: { job_id: "job-1", duplicate: false } }),
    confirmation,
    new Date(0),
    { next: () => 0.5 },
  );
  assert.deepEqual(action, {
    kind: "confirm",
    delayMs: 4_000,
    state: { jobId: "job-1", successes: 1 },
  });
});

test("a duplicate only acknowledges after two observed successes for the same job", async () => {
  const unconfirmed = await deliverEnvelope(
    envelope(),
    2,
    transport({ statusCode: 200, headers: {}, body: { job_id: "job-1", status: "queued", duplicate: true } }),
    confirmation,
    new Date(0),
    { next: () => 0.5 },
  );
  assert.deepEqual(unconfirmed, {
    kind: "confirm",
    delayMs: 4_000,
    state: { jobId: "job-1", successes: 1 },
  });

  const action = await deliverEnvelope(
    envelope(),
    2,
    transport({ statusCode: 200, headers: {}, body: { job_id: "job-1", status: "queued", duplicate: true } }),
    confirmation,
    new Date(),
    undefined,
    { jobId: "job-1", successes: 1 },
  );
  assert.deepEqual(action, { kind: "ack", jobId: "job-1", status: "queued" });
});

test("retryable failures use exponential full jitter and honor Retry-After", async () => {
  const backoff = await deliverEnvelope(
    envelope(),
    3,
    transport({ statusCode: 503, headers: {}, body: {} }),
    confirmation,
    new Date(0),
    { next: () => 0.5 },
  );
  assert.deepEqual(backoff, { kind: "retry", delayMs: 2_000, reason: "aquifer_503" });

  const retryAfter = await deliverEnvelope(
    envelope(),
    3,
    transport({ statusCode: 429, headers: { "Retry-After": "7" }, body: {} }),
    confirmation,
    new Date(0),
    { next: () => 0.5 },
  );
  assert.deepEqual(retryAfter, { kind: "retry", delayMs: 7_500, reason: "aquifer_429" });
});

test("permanent Aquifer rejections dead-letter the message", async () => {
  const action = await deliverEnvelope(
    envelope(),
    1,
    transport({ statusCode: 400, headers: {}, body: { error: "bad destination" } }),
    confirmation,
  );
  assert.deepEqual(action, { kind: "dead-letter", statusCode: 400, reason: "bad destination" });
});

function transport(response: AquiferResponse): AquiferTransport {
  return { async submit() { return response; } };
}

function envelope(): DeliveryEnvelope {
  return {
    version: 1,
    routeId: "github-main",
    provider: "github",
    eventId: "event-1",
    eventType: "push",
    userId: "installation-42",
    destination: "https://backend.example/github",
    receivedAt: 0,
    headers: { "content-type": "application/json" },
    bodyBase64: "e30=",
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { FetchAquiferTransport } from "../src/core/aquifer.js";
import type { DeliveryEnvelope } from "../src/core/types.js";

test("Aquifer transport enables account queues and omits an unused completion webhook", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const transport = new FetchAquiferTransport("http://aquifer.internal:8080/", {
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ job_id: "job-1", status: "queued" }, { status: 201 });
    },
  });

  await transport.submit(envelope());

  assert.equal(capturedUrl, "http://aquifer.internal:8080/jobs");
  assert.equal((capturedInit?.headers as Record<string, string>)["x-aqueduct-account-queue"], "true");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.user_id, "installation-42");
  assert.equal(body.idempotent_key, "inlet:github:github-main:event-1");
  assert.equal(body.body, '{"action":"opened"}');
  assert.equal("webhook_url" in body, false);
});

test("Aquifer transport preserves the global fetch receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown;
  globalThis.fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve(
      new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  } as typeof fetch;

  try {
    const transport = new FetchAquiferTransport("https://aquifer.example");
    await transport.submit(envelope());
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function envelope(): DeliveryEnvelope {
  return {
    version: 1,
    routeId: "github-main",
    provider: "github",
    eventId: "event-1",
    eventType: "issues",
    userId: "installation-42",
    destination: "https://backend.example/github",
    receivedAt: 0,
    headers: { "content-type": "application/json" },
    bodyBase64: "eyJhY3Rpb24iOiJvcGVuZWQifQ==",
  };
}

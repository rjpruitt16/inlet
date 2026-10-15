import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, hmacSha256, utf8 } from "../src/core/encoding.js";
import worker from "../src/runtimes/cloudflare/runtime.js";
import type { CloudflareEnv } from "../src/runtimes/cloudflare/types.js";

test("Cloudflare intake verifies and forwards to the ordered Durable Object", async () => {
  const body = '{"installation":{"id":42},"action":"opened"}';
  const signature = bytesToHex(await hmacSha256(utf8("github-secret"), utf8(body)));
  const queued: unknown[] = [];
  const env: CloudflareEnv = {
    INLET_CONFIG: `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: github-main
    path: /webhooks/github
    provider: github
    secret_ref: GITHUB_SECRET
    destination: https://backend.example/github
`,
    GITHUB_SECRET: "github-secret",
    INLET_ORDERING: {
      idFromName(name) {
        return { name };
      },
      get() {
        return {
          async fetch(_input, init) {
            queued.push(JSON.parse(String(init?.body)) as unknown);
            return Response.json({ queued: true }, { status: 202 });
          },
        };
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://inlet.example/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    }),
    env,
  );

  assert.equal(response.status, 202);
  assert.equal(queued.length, 1);
  const request = queued[0] as { envelope: Record<string, unknown>; deduplicationId: string };
  assert.equal(request.envelope.userId, "42");
  assert.equal(request.envelope.eventId, "delivery-1");
  assert.match(request.deduplicationId, /^[a-f0-9]{64}$/);
});

test("Cloudflare intake completes the WhatsApp verification challenge", async () => {
  const env: CloudflareEnv = {
    INLET_CONFIG: `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: whatsapp-main
    path: /webhooks/whatsapp
    provider: whatsapp
    secret_ref: WHATSAPP_APP_SECRET
    verification_secret_ref: WHATSAPP_VERIFY_TOKEN
    destination: https://backend.example/whatsapp
`,
    WHATSAPP_APP_SECRET: "app-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    INLET_ORDERING: {
      idFromName(name) {
        return { name };
      },
      get() {
        throw new Error("verification challenges must not enter the delivery queue");
      },
    },
  };

  const response = await worker.fetch(
    new Request(
      "https://inlet.example/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-123",
      { method: "GET" },
    ),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "challenge-123");
});

test("Cloudflare intake answers a signed Slack URL challenge without enqueueing", async () => {
  const env: CloudflareEnv = {
    INLET_CONFIG: `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: slack-main
    path: /webhooks/slack
    provider: slack
    secret_ref: SLACK_SIGNING_SECRET
    destination: https://backend.example/slack
`,
    SLACK_SIGNING_SECRET: "slack-secret",
    INLET_ORDERING: {
      idFromName(name) {
        return { name };
      },
      get() {
        throw new Error("Slack URL challenges must not enter the delivery queue");
      },
    },
  };
  const timestamp = Math.floor(Date.now() / 1_000);
  const body = JSON.stringify({ type: "url_verification", challenge: "slack-challenge" });
  const signature = bytesToHex(
    await hmacSha256(utf8("slack-secret"), utf8(`v0:${timestamp}:${body}`)),
  );

  const response = await worker.fetch(
    new Request("https://inlet.example/webhooks/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": `v0=${signature}`,
      },
      body,
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "slack-challenge");
});

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

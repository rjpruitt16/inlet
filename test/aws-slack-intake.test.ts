import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { bytesToHex, hmacSha256, utf8 } from "../src/core/encoding.js";
import { httpHandler } from "../src/runtimes/aws/runtime.js";

test("AWS intake answers a signed Slack URL challenge without enqueueing", async () => {
  process.env.INLET_CONFIG = `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: slack-main
    path: /webhooks/slack
    provider: slack
    secret_ref: SLACK_SIGNING_SECRET
    destination: https://backend.example/slack
`;
  process.env.INLET_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123/inlet.fifo";
  process.env.SLACK_SIGNING_SECRET = "slack-secret";

  const timestamp = Math.floor(Date.now() / 1_000);
  const body = JSON.stringify({ type: "url_verification", challenge: "slack-challenge" });
  const signature = bytesToHex(
    await hmacSha256(utf8("slack-secret"), utf8(`v0:${timestamp}:${body}`)),
  );
  const response = await httpHandler({
    rawPath: "/webhooks/slack",
    rawQueryString: "",
    headers: {
      host: "hooks.example.com",
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
    isBase64Encoded: false,
    requestContext: { http: { method: "POST" } },
  } as unknown as APIGatewayProxyEventV2);

  assert.equal(typeof response, "object");
  assert.equal((response as { statusCode: number }).statusCode, 200);
  assert.equal((response as { body: string }).body, "slack-challenge");
});

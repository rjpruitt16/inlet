import assert from "node:assert/strict";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { bytesToHex, hmacSha256, utf8 } from "../src/core/encoding.js";
import { httpHandler } from "../src/runtimes/aws/runtime.js";

test("AWS intake verifies the raw provider body before enqueueing", async () => {
  process.env.INLET_CONFIG = `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: github-main
    path: /webhooks/github
    provider: github
    secret_ref: GITHUB_SECRET
    destination: https://backend.example/github
`;
  process.env.INLET_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123/inlet.fifo";
  process.env.GITHUB_SECRET = "github-secret";

  const body = '{"installation":{"id":42},"action":"opened"}';
  const signature = bytesToHex(await hmacSha256(utf8("github-secret"), utf8(body)));
  const commands: Array<{ input?: Record<string, unknown> }> = [];
  const originalSend = SQSClient.prototype.send;
  SQSClient.prototype.send = async function send(command): Promise<never> {
    commands.push(command as unknown as { input?: Record<string, unknown> });
    return {} as never;
  };

  try {
    const response = await httpHandler({
      rawPath: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
      isBase64Encoded: false,
      requestContext: { http: { method: "POST" } },
    } as unknown as APIGatewayProxyEventV2);

    assert.equal(typeof response, "object");
    assert.equal((response as { statusCode: number }).statusCode, 202);
    assert.equal(commands.length, 1);
    const input = commands[0]?.input;
    assert.match(String(input?.MessageGroupId), /^[a-f0-9]{64}$/);
    const envelope = JSON.parse(String(input?.MessageBody)) as Record<string, unknown>;
    assert.equal(envelope.userId, "42");
    assert.equal(envelope.eventId, "delivery-1");
  } finally {
    SQSClient.prototype.send = originalSend;
  }
});

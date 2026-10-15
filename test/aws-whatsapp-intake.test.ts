import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { httpHandler } from "../src/runtimes/aws/runtime.js";

test("AWS intake completes the WhatsApp verification challenge", async () => {
  process.env.INLET_CONFIG = `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: whatsapp-main
    path: /webhooks/whatsapp
    provider: whatsapp
    secret_ref: WHATSAPP_APP_SECRET
    verification_secret_ref: WHATSAPP_VERIFY_TOKEN
    destination: https://backend.example/whatsapp
`;
  process.env.INLET_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123/inlet.fifo";
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";

  const response = await httpHandler({
    rawPath: "/webhooks/whatsapp",
    rawQueryString: "hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-123",
    headers: { host: "hooks.example.com", "x-forwarded-proto": "https" },
    body: undefined,
    isBase64Encoded: false,
    requestContext: { http: { method: "GET" } },
  } as unknown as APIGatewayProxyEventV2);

  assert.equal(typeof response, "object");
  assert.equal((response as { statusCode: number }).statusCode, 200);
  assert.equal((response as { body: string }).body, "challenge-123");
});

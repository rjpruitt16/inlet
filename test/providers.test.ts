import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToBase64,
  bytesToHex,
  hmacSha256,
  utf8,
} from "../src/core/encoding.js";
import type { WebhookRequest } from "../src/core/types.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GitHubProvider } from "../src/providers/github.js";
import { ShopifyProvider } from "../src/providers/shopify.js";
import { StripeProvider } from "../src/providers/stripe.js";

test("GitHub verifies the raw body and defaults fairness to installation", async () => {
  const body = utf8('{"installation":{"id":42},"action":"opened"}');
  const signature = bytesToHex(await hmacSha256(utf8("secret"), body));
  const request = webhookRequest(body, {
    "x-hub-signature-256": `sha256=${signature}`,
    "x-github-delivery": "delivery-1",
    "x-github-event": "issues",
  });

  const result = await new GitHubProvider().verify(request, "secret");
  assert.equal(result.eventId, "delivery-1");
  assert.equal(result.defaultUserId, "42");
  await assert.rejects(() => new GitHubProvider().verify(request, "wrong"), /verification failed/);
});

test("Shopify verifies base64 HMAC and uses the shop as fairness identity", async () => {
  const body = utf8('{"id":99}');
  const signature = bytesToBase64(await hmacSha256(utf8("shop-secret"), body));
  const result = await new ShopifyProvider().verify(
    webhookRequest(body, {
      "x-shopify-hmac-sha256": signature,
      "x-shopify-event-id": "event-99",
      "x-shopify-topic": "orders/create",
      "x-shopify-shop-domain": "store.myshopify.com",
    }),
    "shop-secret",
  );

  assert.equal(result.eventId, "event-99");
  assert.equal(result.defaultUserId, "store.myshopify.com");
});

test("Stripe verifies timestamped signatures and uses connected account", async () => {
  const timestamp = 1_800_000_000;
  const text = '{"id":"evt_1","type":"invoice.paid","account":"acct_1"}';
  const signature = bytesToHex(
    await hmacSha256(utf8("whsec_test"), utf8(`${timestamp}.${text}`)),
  );
  const result = await new StripeProvider().verify(
    webhookRequest(utf8(text), { "stripe-signature": `t=${timestamp},v1=${signature}` }),
    "whsec_test",
    new Date(timestamp * 1_000),
  );

  assert.equal(result.eventId, "evt_1");
  assert.equal(result.defaultUserId, "acct_1");
});

test("Anthropic verifies Standard Webhooks signatures", async () => {
  const timestamp = 1_800_000_000;
  const eventId = "msg_1";
  const secretBytes = utf8("anthropic-secret");
  const secret = `whsec_${bytesToBase64(secretBytes)}`;
  const text = '{"type":"message.completed","organization_id":"org_1"}';
  const signature = bytesToBase64(
    await hmacSha256(secretBytes, utf8(`${eventId}.${timestamp}.${text}`)),
  );
  const result = await new AnthropicProvider().verify(
    webhookRequest(utf8(text), {
      "webhook-id": eventId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    }),
    secret,
    new Date(timestamp * 1_000),
  );

  assert.equal(result.eventId, eventId);
  assert.equal(result.defaultUserId, "org_1");
});

function webhookRequest(body: Uint8Array, headers: Record<string, string>): WebhookRequest {
  return { method: "POST", path: "/hook", body, headers };
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToBase64,
  bytesToHex,
  hmacSha1,
  hmacSha256,
  sha256HexBytes,
  utf8,
} from "../src/core/encoding.js";
import type { WebhookRequest } from "../src/core/types.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GitHubProvider } from "../src/providers/github.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { SlackProvider } from "../src/providers/slack.js";
import { ShopifyProvider } from "../src/providers/shopify.js";
import { StripeProvider } from "../src/providers/stripe.js";
import { TelegramProvider } from "../src/providers/telegram.js";
import { TwilioProvider } from "../src/providers/twilio.js";
import { WhatsAppProvider } from "../src/providers/whatsapp.js";

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
      "x-shopify-webhook-id": "delivery-99",
      "x-shopify-topic": "orders/create",
      "x-shopify-shop-domain": "store.myshopify.com",
    }),
    "shop-secret",
  );

  assert.equal(result.eventId, "delivery-99");
  assert.equal(result.defaultUserId, "store.myshopify.com");
});

test("Shopify scopes customer fairness inside the originating shop", async () => {
  const body = utf8(
    '{"id":99,"customer":{"id":42}}',
  );
  const signature = bytesToBase64(await hmacSha256(utf8("shop-secret"), body));
  const result = await new ShopifyProvider().verify(
    webhookRequest(body, {
      "x-shopify-hmac-sha256": signature,
      "x-shopify-webhook-id": "delivery-customer-1",
      "x-shopify-topic": "orders/create",
      "x-shopify-shop-domain": "store.myshopify.com",
    }),
    "shop-secret",
  );

  assert.equal(
    result.defaultUserId,
    "store.myshopify.com:gid://shopify/Customer/42",
  );
});

test("Shopify identifies customer-resource webhook payloads without mistaking order IDs", async () => {
  const body = utf8(
    '{"id":42,"admin_graphql_api_id":"gid://shopify/Customer/42"}',
  );
  const signature = bytesToBase64(await hmacSha256(utf8("shop-secret"), body));
  const result = await new ShopifyProvider().verify(
    webhookRequest(body, {
      "x-shopify-hmac-sha256": signature,
      "x-shopify-webhook-id": "delivery-customer-2",
      "x-shopify-topic": "customers/update",
      "x-shopify-shop-domain": "store.myshopify.com",
    }),
    "shop-secret",
  );

  assert.equal(
    result.defaultUserId,
    "store.myshopify.com:gid://shopify/Customer/42",
  );
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
  const text =
    '{"type":"event","id":"msg_1","data":{"type":"session.status_idled","id":"sesn_1","organization_id":"org_1","workspace_id":"ws_1"}}';
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
  assert.equal(result.eventType, "session.status_idled");
  assert.equal(result.defaultUserId, "sesn_1");
});

test("Twilio verifies form signatures using the public URL and account identity", async () => {
  const url = "https://hooks.example.com/webhooks/twilio";
  const text = "MessageStatus=delivered&AccountSid=AC123&MessageSid=SM123";
  const signed = `${url}AccountSidAC123MessageSidSM123MessageStatusdelivered`;
  const signature = bytesToBase64(await hmacSha1(utf8("twilio-token"), utf8(signed)));
  const request = webhookRequest(utf8(text), {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": signature,
  });
  request.url = url;

  const result = await new TwilioProvider().verify(request, "twilio-token");
  assert.equal(result.eventId, "SM123");
  assert.equal(result.eventType, "delivered");
  assert.equal(result.defaultUserId, "AC123");
  await assert.rejects(
    () => new TwilioProvider().verify(request, "wrong-token"),
    /verification failed/,
  );
});

test("Twilio verifies JSON body hashes before request signatures", async () => {
  const body = utf8('{"EventSid":"VW123","EventType":"voice.insights"}');
  const bodyHash = await sha256HexBytes(body);
  const url = `https://hooks.example.com/twilio?bodySHA256=${bodyHash}`;
  const signature = bytesToBase64(await hmacSha1(utf8("twilio-token"), utf8(url)));
  const request = webhookRequest(body, {
    "content-type": "application/json",
    "x-twilio-signature": signature,
  });
  request.url = url;

  const result = await new TwilioProvider().verify(request, "twilio-token");
  assert.equal(result.eventId, "VW123");
  assert.equal(result.eventType, "voice.insights");
});

test("Telegram verifies its secret token and orders updates by chat", async () => {
  const body = utf8(
    '{"update_id":12345,"message":{"message_id":7,"chat":{"id":99},"text":"hello"}}',
  );
  const request = webhookRequest(body, {
    "x-telegram-bot-api-secret-token": "telegram-secret",
  });

  const result = await new TelegramProvider().verify(request, "telegram-secret");
  assert.equal(result.eventId, "12345");
  assert.equal(result.eventType, "message");
  assert.equal(result.defaultUserId, "99");
  await assert.rejects(
    () => new TelegramProvider().verify(request, "wrong-secret"),
    /verification failed/,
  );
});

test("WhatsApp verifies Meta signatures and extracts message identity", async () => {
  const body = utf8(JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "phone-1" },
          messages: [{ id: "wamid.1", from: "15551234567", type: "text" }],
        },
      }],
    }],
  }));
  const signature = bytesToHex(await hmacSha256(utf8("meta-app-secret"), body));
  const request = webhookRequest(body, { "x-hub-signature-256": `sha256=${signature}` });

  const result = await new WhatsAppProvider().verify(request, "meta-app-secret");
  assert.equal(result.eventId, "wamid.1");
  assert.equal(result.eventType, "messages.text");
  assert.equal(result.defaultUserId, "15551234567");
});

test("WhatsApp answers Meta's verification challenge with a separate token", async () => {
  const request = webhookRequest(new Uint8Array(), {});
  request.method = "GET";
  request.url =
    "https://hooks.example.com/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-123";

  const result = await new WhatsAppProvider().verifyChallenge(request, "verify-me");
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, "challenge-123");

  await assert.rejects(
    () => new WhatsAppProvider().verifyChallenge(request, "wrong-token"),
    /token mismatch/,
  );
});

test("OpenAI verifies Standard Webhooks signatures and uses the delivery ID", async () => {
  const timestamp = 1_800_000_000;
  const eventId = "wh_openai_1";
  const secretBytes = utf8("openai-secret");
  const secret = `whsec_${bytesToBase64(secretBytes)}`;
  const text = JSON.stringify({
    object: "event",
    id: "evt_1",
    type: "response.completed",
    project_id: "proj_1",
    data: { id: "resp_1" },
  });
  const signature = bytesToBase64(
    await hmacSha256(secretBytes, utf8(`${eventId}.${timestamp}.${text}`)),
  );
  const result = await new OpenAIProvider().verify(
    webhookRequest(utf8(text), {
      "webhook-id": eventId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    }),
    secret,
    new Date(timestamp * 1_000),
  );

  assert.equal(result.eventId, eventId);
  assert.equal(result.eventType, "response.completed");
  assert.equal(result.defaultUserId, "proj_1");
  await assert.rejects(
    () => new OpenAIProvider().verify(
      webhookRequest(utf8(text), {
        "webhook-id": eventId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
      }),
      "wrong-secret",
      new Date(timestamp * 1_000),
    ),
    /verification failed/,
  );
});

test("Slack verifies Events API signatures and orders events by workspace", async () => {
  const timestamp = 1_800_000_000;
  const text = JSON.stringify({
    type: "event_callback",
    event_id: "Ev123",
    team_id: "T123",
    event: { type: "message", text: "hello" },
  });
  const signature = bytesToHex(
    await hmacSha256(utf8("slack-secret"), utf8(`v0:${timestamp}:${text}`)),
  );
  const request = webhookRequest(utf8(text), {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": `v0=${signature}`,
  });

  const result = await new SlackProvider().verify(
    request,
    "slack-secret",
    new Date(timestamp * 1_000),
  );
  assert.equal(result.eventId, "Ev123");
  assert.equal(result.eventType, "message");
  assert.equal(result.defaultUserId, "T123");

  await assert.rejects(
    () => new SlackProvider().verify(
      request,
      "slack-secret",
      new Date((timestamp + 301) * 1_000),
    ),
    /outside the tolerance/,
  );
});

test("Slack verifies form-encoded slash commands", async () => {
  const timestamp = 1_800_000_000;
  const text = "team_id=T123&user_id=U123&command=%2Fdeploy&trigger_id=trigger-1";
  const signature = bytesToHex(
    await hmacSha256(utf8("slack-secret"), utf8(`v0:${timestamp}:${text}`)),
  );
  const result = await new SlackProvider().verify(
    webhookRequest(utf8(text), {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    }),
    "slack-secret",
    new Date(timestamp * 1_000),
  );

  assert.equal(result.eventId, "trigger-1");
  assert.equal(result.eventType, "slash_command:/deploy");
  assert.equal(result.defaultUserId, "T123");
});

test("Slack verifies and answers its URL challenge without queueing it", async () => {
  const timestamp = 1_800_000_000;
  const text = JSON.stringify({ type: "url_verification", challenge: "slack-challenge" });
  const signature = bytesToHex(
    await hmacSha256(utf8("slack-secret"), utf8(`v0:${timestamp}:${text}`)),
  );
  const response = await new SlackProvider().respondImmediately(
    webhookRequest(utf8(text), {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    }),
    "slack-secret",
    new Date(timestamp * 1_000),
  );

  assert.equal(response?.statusCode, 200);
  assert.equal(response?.body, "slack-challenge");
  await assert.rejects(
    () => new SlackProvider().respondImmediately(
      webhookRequest(utf8(text), {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": `v0=${signature}`,
      }),
      "wrong-secret",
      new Date(timestamp * 1_000),
    ),
    /verification failed/,
  );
});

function webhookRequest(body: Uint8Array, headers: Record<string, string>): WebhookRequest {
  return { method: "POST", path: "/hook", body, headers };
}

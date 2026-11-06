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
import { defaultProviders } from "../src/providers/index.js";
import { KlaviyoProvider } from "../src/providers/klaviyo.js";
import { MailchimpProvider } from "../src/providers/mailchimp.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { SendGridProvider } from "../src/providers/sendgrid.js";
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

test("SendGrid verifies its official signed Event Webhook fixture", async () => {
  const publicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
  const signature = "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=";
  const timestamp = "1600112502";
  const text = JSON.stringify([{
    email: "hello@world.com",
    event: "dropped",
    reason: "Bounced Address",
    sg_event_id: "ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA",
    sg_message_id: "LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0",
    "smtp-id": "<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>",
    timestamp: 1600112492,
  }]) + "\r\n";
  const request = webhookRequest(utf8(text), {
    "content-type": "application/json",
    "x-twilio-email-event-webhook-signature": signature,
    "x-twilio-email-event-webhook-timestamp": timestamp,
  });

  const result = await new SendGridProvider().verify(request, publicKey);
  assert.equal(result.eventId, "ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA");
  assert.equal(result.eventType, "dropped");
  assert.equal(
    result.defaultUserId,
    "LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0",
  );
  assert.equal(result.forwardedHeaders["x-twilio-email-event-webhook-signature"], signature);

  const tampered = webhookRequest(utf8(text.replace("dropped", "delivered")), request.headers);
  await assert.rejects(
    () => new SendGridProvider().verify(tampered, publicKey),
    /verification failed/,
  );
});

test("SendGrid gives a signed multi-event delivery a deterministic batch identity", async () => {
  const publicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ4LIFtWztlsF7skFqOncjD1lun4H5w8XOhyOArHW9RcIx/FfEzx6cikC/yPfUvwaX/JScE7Fc9CJD2afQ9Ok3Q==";
  const signature = "MEYCIQC/I4o6vCgqRYrTljjoVWB/GRWNtxeePlLMHr3x9ETeRQIhAIpV+03nREPTTHWSW0wIOA0EoMPdcNgXa70yCaqDJlu5";
  const timestamp = "1619651159";
  const messageId = "qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0";
  const events = [
    {
      email: "invalid@gmail.com",
      event: "processed",
      send_at: 0,
      sg_event_id: "cHJvY2Vzc2VkLTE5OTQyMTEyLXFOd0JMZ1BRUWpXNkRKdktRd1NBYnctMA",
      sg_message_id: messageId,
      "smtp-id": "<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>",
      timestamp: 1619651146,
    },
    {
      email: "invalid@gmail.com",
      event: "bounce",
      ip: "167.89.101.76",
      reason: "552 5.2.2 The email account that you tried to reach is over quota and inactive. Please direct the recipient to https://support.google.com/mail/?p=OverQuotaPerm c17si1130468pgv.34 - gsmtp",
      sg_event_id: "Ym91bmNlLTAtMTk5NDIxMTItcU53QkxnUFFRalc2REp2S1F3U0Fidy0w",
      sg_message_id: messageId,
      "smtp-id": "<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>",
      status: "5.2.2",
      timestamp: 1619651147,
      tls: 1,
      type: "blocked",
    },
  ];
  const text = JSON.stringify(events).split("},{").join("},\r\n{") + "\r\n";
  const request = webhookRequest(utf8(text), {
    "x-twilio-email-event-webhook-signature": signature,
    "x-twilio-email-event-webhook-timestamp": timestamp,
  });

  const result = await new SendGridProvider().verify(request, publicKey);
  assert.match(result.eventId, /^batch-[a-f0-9]{64}$/);
  assert.equal(result.eventType, "batch");
  assert.equal(result.defaultUserId, messageId);
});

test("Klaviyo verifies signed batches and groups a common profile", async () => {
  const timestamp = "Thu, 04 Jan 2024 18:05:25 GMT";
  const webhookId = "webhook-1";
  const body = {
    data: [
      {
        external_id: "event-1",
        topic: "event:klaviyo.received_email",
        payload: { data: { relationships: { profile: { data: { id: "profile-1" } } } } },
      },
      {
        external_id: "event-2",
        topic: "event:klaviyo.opened_email",
        payload: { data: { relationships: { profile: { data: { id: "profile-1" } } } } },
      },
    ],
    meta: {
      klaviyo_account_id: "account-1",
      klaviyo_webhook_id: webhookId,
      timestamp: "2024-01-04T18:05:25Z",
    },
  };
  const text = JSON.stringify(body);
  const signed = utf8(`${text}${timestamp}`);
  const signature = bytesToHex(await hmacSha256(utf8("klaviyo-secret"), signed));
  const request = webhookRequest(utf8(text), {
    "klaviyo-signature": signature,
    "klaviyo-timestamp": timestamp,
    "klaviyo-webhook-id": webhookId,
  });

  const result = await new KlaviyoProvider().verify(request, "klaviyo-secret");
  assert.match(result.eventId, /^batch-[a-f0-9]{64}$/);
  assert.equal(result.eventType, "batch");
  assert.equal(result.defaultUserId, "profile-1");

  await assert.rejects(
    () => new KlaviyoProvider().verify(
      webhookRequest(request.body, { ...request.headers, "klaviyo-webhook-id": "wrong" }),
      "klaviyo-secret",
    ),
    /webhook ID does not match/,
  );
});

test("Mailchimp verifies signed Marketing webhooks and rejects replays", async () => {
  const timestamp = 1_800_000_000;
  const text = "type=subscribe&fired_at=2027-01-15+08%3A00%3A00&data%5Bid%5D=member-1&data%5Blist_id%5D=list-1&data%5Bemail%5D=user%40example.com";
  const signature = bytesToHex(
    await hmacSha256(utf8("mailchimp-secret"), utf8(`${timestamp}.${text}`)),
  );
  const request = webhookRequest(utf8(text), {
    "content-type": "application/x-www-form-urlencoded",
    "x-mailchimp-signature": `t=${timestamp},v1=${signature}`,
  });

  const result = await new MailchimpProvider().verify(
    request,
    "mailchimp-secret",
    new Date(timestamp * 1_000),
  );
  assert.match(result.eventId, /^body-[a-f0-9]{64}$/);
  assert.equal(result.eventType, "subscribe");
  assert.equal(result.defaultUserId, "member-1");

  await assert.rejects(
    () => new MailchimpProvider().verify(
      request,
      "mailchimp-secret",
      new Date((timestamp + 301) * 1_000),
    ),
    /outside the tolerance/,
  );
});

test("Mailchimp rejects form keys that can traverse object prototypes", async () => {
  const timestamp = 1_800_000_000;
  const text = "type=subscribe&__proto__%5Binlet_polluted%5D=yes";
  const signature = bytesToHex(
    await hmacSha256(utf8("mailchimp-secret"), utf8(`${timestamp}.${text}`)),
  );
  const request = webhookRequest(utf8(text), {
    "content-type": "application/x-www-form-urlencoded",
    "x-mailchimp-signature": `t=${timestamp},v1=${signature}`,
  });

  await assert.rejects(
    () => new MailchimpProvider().verify(
      request,
      "mailchimp-secret",
      new Date(timestamp * 1_000),
    ),
    /unsafe form field/,
  );
  assert.equal((Object.prototype as Record<string, unknown>).inlet_polluted, undefined);
});

test("the default provider registry includes email integrations", () => {
  const providers = defaultProviders();
  assert.equal(providers.get("sendgrid")?.name, "sendgrid");
  assert.equal(providers.get("klaviyo")?.name, "klaviyo");
  assert.equal(providers.get("mailchimp")?.name, "mailchimp");
});

function webhookRequest(body: Uint8Array, headers: Record<string, string>): WebhookRequest {
  return { method: "POST", path: "/hook", body, headers };
}

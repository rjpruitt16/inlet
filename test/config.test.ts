import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/core/config.js";

test("parseConfig applies confirmation defaults and route options", () => {
  const config = parseConfig(`
aquifer_url: http://aquifer.internal:8080/
routes:
  - id: github-main
    path: /webhooks/github
    provider: github
    secret_ref: env:GITHUB_SECRET
    destination: https://backend.example/github
    fairness_key: body:/installation/id
    max_retries: -1
`);

  assert.equal(config.aquiferUrl, "http://aquifer.internal:8080");
  assert.equal(config.confirmation.delayMs, 4_000);
  assert.equal(config.confirmation.maxBackoffMs, 60_000);
  assert.equal(config.routes[0]?.fairnessKey, "body:/installation/id");
  assert.equal(config.routes[0]?.maxRetries, -1);
});

test("parseConfig rejects duplicate paths", () => {
  assert.throws(
    () =>
      parseConfig(`
aquifer_url: http://aquifer:8080
routes:
  - { id: one, path: /hook, provider: github, secret_ref: A, destination: https://one.example/hook }
  - { id: two, path: /hook, provider: stripe, secret_ref: B, destination: https://two.example/hook }
`),
    /duplicate route path/,
  );
});

test("parseConfig accepts new providers and WhatsApp verification settings", () => {
  const config = parseConfig(`
aquifer_url: http://aquifer:8080
routes:
  - id: twilio-main
    path: /twilio
    provider: twilio
    secret_ref: TWILIO_AUTH_TOKEN
    public_url: https://hooks.example.com/twilio
    destination: https://backend.example/twilio
  - id: telegram-main
    path: /telegram
    provider: telegram
    secret_ref: TELEGRAM_WEBHOOK_SECRET
    destination: https://backend.example/telegram
  - id: whatsapp-main
    path: /whatsapp
    provider: whatsapp
    secret_ref: WHATSAPP_APP_SECRET
    verification_secret_ref: WHATSAPP_VERIFY_TOKEN
    destination: https://backend.example/whatsapp
  - id: openai-main
    path: /openai
    provider: openai
    secret_ref: OPENAI_WEBHOOK_SECRET
    destination: https://backend.example/openai
  - id: slack-main
    path: /slack
    provider: slack
    secret_ref: SLACK_SIGNING_SECRET
    destination: https://backend.example/slack
`);

  assert.equal(config.routes[0]?.publicUrl, "https://hooks.example.com/twilio");
  assert.equal(config.routes[2]?.verificationSecretRef, "WHATSAPP_VERIFY_TOKEN");
  assert.equal(config.routes[3]?.provider, "openai");
  assert.equal(config.routes[4]?.provider, "slack");
});

test("parseConfig requires a separate WhatsApp verification token", () => {
  assert.throws(
    () => parseConfig(`
aquifer_url: http://aquifer:8080
routes:
  - id: whatsapp-main
    path: /whatsapp
    provider: whatsapp
    secret_ref: WHATSAPP_APP_SECRET
    destination: https://backend.example/whatsapp
`),
    /verification_secret_ref is required/,
  );
});

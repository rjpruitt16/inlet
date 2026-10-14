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

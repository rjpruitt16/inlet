import assert from "node:assert/strict";
import test from "node:test";
import { awsTemplate } from "../src/cli/aws-template.js";
import { awsSecretNames, generatedSecrets, parseInletFile } from "../src/cli/deploy-config.js";
import { parseConfig } from "../src/core/config.js";
import { recordWebSocketBatch, type WebSocketRecord } from "../src/core/kafka/websocket.js";

const config = parseConfig(`
aquifer_url: https://aquifer.example.com
delivery: kafka
kafka:
  websocket_topic: chat.transcripts
routes:
  - { id: github-main, path: /webhooks/github, provider: github, secret_ref: GH, destination: https://backend.example/github }
`);

const batch = (events: unknown[]) =>
  new TextEncoder().encode(JSON.stringify({ schema: "aquifer.websocket_batch.v1", node_id: "aquifer-1", events }));

const event = (session: string, stream: string, extra: Record<string, unknown> = {}) => ({
  session_id: session,
  stream_id: stream,
  direction: "client",
  type: "command",
  message_id: `m-${stream}`,
  payload: { action: "subscribe" },
  recorded_at: 1792541234567,
  ...extra,
});

function memoryWriter() {
  const writes: Array<{ topic: string; key: string; record: WebSocketRecord }> = [];
  return {
    writes,
    async write(topic: string, messages: Array<{ key: string; value: string }>) {
      for (const message of messages) writes.push({ topic, key: message.key, record: JSON.parse(message.value) });
    },
  };
}

test("an authorized batch is written to the WebSocket topic, keyed by session", async () => {
  const writer = memoryWriter();
  const written = await recordWebSocketBatch(
    { Authorization: "Bearer tok" },
    batch([event("s1", "1-0"), event("s2", "2-0"), event("s1", "3-0")]),
    "tok",
    config,
    writer,
  );
  assert.equal(written, 3);
  assert.deepEqual(writer.writes.map((w) => [w.topic, w.key, w.record.stream_id]), [
    ["chat.transcripts", "s1", "1-0"],
    ["chat.transcripts", "s2", "2-0"],
    ["chat.transcripts", "s1", "3-0"],
  ]);
  assert.equal(writer.writes[0]?.record.schema, "inlet.websocket.v1");
  assert.equal(writer.writes[0]?.record.node_id, "aquifer-1");
  assert.deepEqual(writer.writes[0]?.record.payload, { action: "subscribe" });
});

test("a batch with a wrong or missing token, or a bad event, is refused and nothing is written", async () => {
  const writer = memoryWriter();
  await assert.rejects(recordWebSocketBatch({ authorization: "Bearer nope" }, batch([event("s1", "1-0")]), "tok", config, writer), /token is invalid/);
  await assert.rejects(recordWebSocketBatch({}, batch([event("s1", "1-0")]), "tok", config, writer), /token is invalid/);
  await assert.rejects(
    recordWebSocketBatch({ authorization: "Bearer tok" }, batch([event("s1", "1-0"), { session_id: "s2" }]), "tok", config, writer),
    /every event needs/,
  );
  await assert.rejects(
    recordWebSocketBatch({ authorization: "Bearer tok" }, new TextEncoder().encode('{"events":[]}'), "tok", config, writer),
    /aquifer.websocket_batch.v1/,
  );
  assert.equal(writer.writes.length, 0, "a partly bad batch writes nothing, so Aquifer's retry can't double it");
});

const kafkaFile = (websocketExport: boolean) => `
aquifer_url: https://aquifer.example.com
delivery: kafka
routes:
  - { id: a, path: /a, provider: github, secret_ref: aws-secrets:a-secret, destination: https://b.example/a }
deploy:
  platform: aws
  name: inlet-ws
  kafka:
    brokers: k.example.com:9093
    credentials_secret: k-creds
    websocket_export: ${websocketExport}
`;

test("websocket_export adds a generated token, its grant and INLET_WS_EXPORT_TOKEN_REF", () => {
  const on = parseInletFile(kafkaFile(true));
  assert.deepEqual(generatedSecrets(on).map((secret) => secret.name), ["inlet-ws-completion-key", "inlet-ws-ws-export-token"]);
  const names = [...awsSecretNames(on), ...generatedSecrets(on).map((secret) => secret.name)];
  const arns = new Map(names.map((name) => [name, `arn:aws:secretsmanager:us-east-2:123456789012:secret:${name}-AbCdEf`]));
  const resources = (awsTemplate(on, arns) as { Resources: Record<string, any> }).Resources;
  assert.match(resources.HttpFunction.Properties.Environment.Variables.INLET_WS_EXPORT_TOKEN_REF, /secret:inlet-ws-ws-export-token-/);
  assert.ok(
    JSON.stringify(resources.Role.Properties.Policies[0].PolicyDocument.Statement[0].Resource).includes("inlet-ws-ws-export-token"),
    "the functions may read the token",
  );

  const off = parseInletFile(kafkaFile(false));
  assert.deepEqual(generatedSecrets(off).map((secret) => secret.name), ["inlet-ws-completion-key"]);
  const offArns = new Map(
    [...awsSecretNames(off), "inlet-ws-completion-key"].map((name) => [name, `arn:aws:secretsmanager:us-east-2:1:secret:${name}-x`]),
  );
  const offResources = (awsTemplate(off, offArns) as { Resources: Record<string, any> }).Resources;
  assert.equal(offResources.HttpFunction.Properties.Environment.Variables.INLET_WS_EXPORT_TOKEN_REF, undefined);
});

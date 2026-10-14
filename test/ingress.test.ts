import assert from "node:assert/strict";
import test from "node:test";
import { utf8 } from "../src/core/encoding.js";
import { InletIntake } from "../src/core/ingress.js";
import type {
  DeliveryEnvelope,
  InletConfig,
  OrderedQueue,
  ProviderAdapter,
  SecretResolver,
} from "../src/core/types.js";

test("intake maps provider identity into an ordered queue group", async () => {
  const queue = new RecordingQueue();
  const provider: ProviderAdapter = {
    name: "github",
    async verify() {
      return {
        provider: "github",
        eventId: "event-1",
        eventType: "push",
        defaultUserId: "installation-42",
        body: { installation: { id: 42 } },
        forwardedHeaders: { "content-type": "application/json" },
      };
    },
  };
  const config: InletConfig = {
    aquiferUrl: "http://aquifer:8080",
    confirmation: { delayMs: 4_000, jitterRatio: 0.2, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
    routes: [
      {
        id: "github-main",
        path: "/hooks/github",
        provider: "github",
        secretRef: "GITHUB_SECRET",
        destination: "https://backend.example/github",
      },
    ],
  };
  const secrets: SecretResolver = { async resolve() { return "secret"; } };
  const intake = new InletIntake(config, new Map([["github", provider]]), secrets, queue);

  const result = await intake.accept({
    method: "POST",
    path: "/hooks/github",
    headers: { "Content-Type": "application/json" },
    body: utf8("{}"),
  });

  assert.equal(result.userId, "installation-42");
  assert.equal(queue.messages.length, 1);
  assert.equal(queue.messages[0]?.envelope.userId, "installation-42");
  assert.match(queue.messages[0]?.groupId ?? "", /^[a-f0-9]{64}$/);
  assert.match(queue.messages[0]?.deduplicationId ?? "", /^[a-f0-9]{64}$/);
});

class RecordingQueue implements OrderedQueue {
  readonly messages: Array<{
    envelope: DeliveryEnvelope;
    groupId: string;
    deduplicationId: string;
  }> = [];

  async send(envelope: DeliveryEnvelope, groupId: string, deduplicationId: string): Promise<void> {
    this.messages.push({ envelope, groupId, deduplicationId });
  }
}

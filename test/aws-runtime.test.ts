import assert from "node:assert/strict";
import test from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { queueHandler } from "../src/runtimes/aws/runtime.js";
import type { DeliveryEnvelope } from "../src/core/types.js";

test("AWS FIFO handler blocks later messages in a group until confirmation", async () => {
  process.env.INLET_CONFIG = `
aquifer_url: http://aquifer.internal:8080
routes:
  - id: github-main
    path: /webhooks/github
    provider: github
    secret_ref: GITHUB_SECRET
    destination: https://backend.example/github
confirmation:
  delay_ms: 1
  jitter_ratio: 0
`;
  process.env.INLET_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123/inlet.fifo";
  process.env.INLET_DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123/inlet-dlq.fifo";

  const originalFetch = globalThis.fetch;
  const originalSend = SQSClient.prototype.send;
  let aquiferRequests = 0;
  const sqsCommands: string[] = [];
  const aquiferResponses = [
    new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), { status: 201 }),
    new Response(JSON.stringify({ error: "busy" }), { status: 503 }),
  ];
  globalThis.fetch = async () => {
    aquiferRequests += 1;
    const response = aquiferResponses.shift();
    if (!response) throw new Error("unexpected Aquifer request");
    return response;
  };
  SQSClient.prototype.send = async function send(command): Promise<never> {
    sqsCommands.push(command.constructor.name);
    return {} as never;
  };

  try {
    const response = await queueHandler({
      Records: [record("message-1", "group-a", envelope("event-1")), record("message-2", "group-a", envelope("event-2"))],
    } as SQSEvent);

    assert.equal(aquiferRequests, 2, "the second same-group event must not overtake a failed confirmation");
    assert.deepEqual(response.batchItemFailures, [
      { itemIdentifier: "message-1" },
      { itemIdentifier: "message-2" },
    ]);
    assert.deepEqual(sqsCommands, ["ChangeMessageVisibilityCommand"]);
  } finally {
    globalThis.fetch = originalFetch;
    SQSClient.prototype.send = originalSend;
  }
});

test("AWS sends malformed queue messages to the configured dead-letter queue", async () => {
  process.env.INLET_DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123/inlet-dlq.fifo";
  const originalSend = SQSClient.prototype.send;
  const commands: Array<{ constructor: { name: string }; input?: { MessageBody?: string } }> = [];
  SQSClient.prototype.send = async function send(command): Promise<never> {
    commands.push(command as unknown as { constructor: { name: string }; input?: { MessageBody?: string } });
    return {} as never;
  };

  try {
    const malformed = record("message-bad", "group-b", envelope("unused"));
    malformed.body = "not-json";
    const response = await queueHandler({ Records: [malformed] } as SQSEvent);

    assert.deepEqual(response.batchItemFailures, []);
    assert.equal(commands[0]?.constructor.name, "SendMessageCommand");
    const deadLetter = JSON.parse(String(commands[0]?.input?.MessageBody)) as {
      envelope: { raw_body: string };
    };
    assert.equal(deadLetter.envelope.raw_body, "not-json");
  } finally {
    SQSClient.prototype.send = originalSend;
  }
});

function record(messageId: string, groupId: string, body: DeliveryEnvelope): SQSRecord {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "0",
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: "0",
      MessageGroupId: groupId,
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123:inlet.fifo",
    awsRegion: "us-east-1",
  };
}

function envelope(eventId: string): DeliveryEnvelope {
  return {
    version: 1,
    routeId: "github-main",
    provider: "github",
    eventId,
    eventType: "push",
    userId: "installation-42",
    destination: "https://backend.example/github",
    receivedAt: 0,
    headers: { "content-type": "application/json" },
    bodyBase64: "e30=",
  };
}

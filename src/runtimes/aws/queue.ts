import { SendMessageCommand, SQSClient, type SQSClientConfig } from "@aws-sdk/client-sqs";
import type { DeliveryEnvelope, OrderedQueue } from "../../core/types.js";

export class SqsFifoQueue implements OrderedQueue {
  readonly client: SQSClient;

  constructor(
    readonly queueUrl: string,
    config: SQSClientConfig = {},
  ) {
    this.client = new SQSClient(config);
  }

  async send(envelope: DeliveryEnvelope, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }
}

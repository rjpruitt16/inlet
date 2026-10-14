import type { DeliveryEnvelope, OrderedQueue } from "../../core/types.js";
import type { DurableObjectNamespaceLike } from "./types.js";

export class CloudflareDurableQueue implements OrderedQueue {
  constructor(private readonly namespace: DurableObjectNamespaceLike) {}

  async send(envelope: DeliveryEnvelope, groupId: string, deduplicationId: string): Promise<void> {
    const id = this.namespace.idFromName(groupId);
    const response = await this.namespace.get(id).fetch("https://inlet.internal/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope, deduplicationId }),
    });
    if (!response.ok) {
      throw new Error(`ordered queue rejected the event with ${response.status}`);
    }
  }
}

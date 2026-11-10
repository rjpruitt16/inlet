import { bytesToHex, constantTimeEqual, hmacSha256, utf8 } from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = ["x-alchemy-signature"] as const;

export class AlchemyProvider implements ProviderAdapter {
  readonly name = "alchemy" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const signature = requiredHeader(request, "x-alchemy-signature");
    const expected = bytesToHex(await hmacSha256(utf8(secret), request.body));
    if (!constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected))) {
      throw new VerificationError("Alchemy signature verification failed");
    }

    const body = parseJsonBody(request);
    const eventId = stringAt(body, "id");
    const eventType = stringAt(body, "type");
    if (!eventId || !eventType) {
      throw new VerificationError("Alchemy event is missing id or type", "missing_event_metadata");
    }

    const defaultUserId =
      stringAt(body, "webhookId")
      ?? stringAt(body, "webhook_id")
      ?? stringAt(body, "event", "appId")
      ?? stringAt(body, "event", "network");
    const result: VerifiedWebhook = {
      provider: this.name,
      eventId,
      eventType,
      body,
      forwardedHeaders: forwarded(request.headers, forwardedHeaders),
    };
    if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
    return result;
  }
}

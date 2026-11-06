import {
  bytesToHex,
  constantTimeEqual,
  hmacSha256,
  sha256Hex,
  utf8,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = [
  "klaviyo-signature",
  "klaviyo-timestamp",
  "klaviyo-webhook-id",
] as const;

export class KlaviyoProvider implements ProviderAdapter {
  readonly name = "klaviyo" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const signature = requiredHeader(request, "klaviyo-signature");
    const timestamp = requiredHeader(request, "klaviyo-timestamp");
    const webhookId = requiredHeader(request, "klaviyo-webhook-id");
    const timestampBytes = utf8(timestamp);
    const signed = new Uint8Array(request.body.length + timestampBytes.length);
    signed.set(request.body);
    signed.set(timestampBytes, request.body.length);

    const expected = bytesToHex(await hmacSha256(utf8(secret), signed));
    if (!constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected))) {
      throw new VerificationError("Klaviyo signature verification failed");
    }

    const body = parseJsonBody(request);
    const bodyWebhookId = stringAt(body, "meta", "klaviyo_webhook_id");
    if (!bodyWebhookId || bodyWebhookId !== webhookId) {
      throw new VerificationError("Klaviyo webhook ID does not match the signed payload");
    }
    const events = body.data;
    if (
      !Array.isArray(events)
      || events.length === 0
      || events.some((event) => typeof event !== "object" || event === null || Array.isArray(event))
    ) {
      throw new PayloadError("Klaviyo webhook data must be a non-empty array");
    }

    const records = events as Record<string, unknown>[];
    const eventIds = records.map((event) => stringAt(event, "external_id"));
    const topics = records.map((event) => stringAt(event, "topic"));
    if (eventIds.some((value) => value === undefined) || topics.some((value) => value === undefined)) {
      throw new PayloadError("Klaviyo event is missing external_id or topic", "missing_event_metadata");
    }

    const ids = eventIds as string[];
    const eventTypes = topics as string[];
    const eventId = ids.length === 1
      ? ids[0]!
      : `batch-${await sha256Hex([...ids].sort().join("\n"))}`;
    const eventType = eventTypes.every((value) => value === eventTypes[0])
      ? eventTypes[0]!
      : "batch";
    const defaultUserId = commonProfile(records) ?? stringAt(body, "meta", "klaviyo_account_id");

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

function commonProfile(events: Record<string, unknown>[]): string | undefined {
  const profiles = events.map((event) =>
    stringAt(event, "payload", "data", "relationships", "profile", "data", "id")
  );
  const first = profiles[0];
  return first !== undefined && profiles.every((profile) => profile === first)
    ? first
    : undefined;
}

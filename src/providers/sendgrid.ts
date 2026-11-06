import {
  base64ToBytes,
  ecdsaP256Sha256Verify,
  sha256Hex,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = [
  "x-twilio-email-event-webhook-signature",
  "x-twilio-email-event-webhook-timestamp",
] as const;

export class SendGridProvider implements ProviderAdapter {
  readonly name = "sendgrid" as const;

  async verify(request: WebhookRequest, publicKey: string): Promise<VerifiedWebhook> {
    const timestamp = requiredHeader(request, "x-twilio-email-event-webhook-timestamp");
    const signature = requiredHeader(request, "x-twilio-email-event-webhook-signature");
    if (!/^\d+$/.test(timestamp)) {
      throw new VerificationError("invalid SendGrid webhook timestamp");
    }

    const timestampBytes = utf8(timestamp);
    const signed = new Uint8Array(timestampBytes.length + request.body.length);
    signed.set(timestampBytes);
    signed.set(request.body, timestampBytes.length);

    let valid = false;
    try {
      valid = await ecdsaP256Sha256Verify(
        decodePublicKey(publicKey),
        base64ToBytes(signature.replace(/\s+/g, "")),
        signed,
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new VerificationError("SendGrid signature verification failed");
    }

    const events = parseEvents(request);
    const eventIds = events.map((event) => stringAt(event, "sg_event_id"));
    const eventTypes = events.map((event) => stringAt(event, "event"));
    if (eventIds.some((value) => value === undefined) || eventTypes.some((value) => value === undefined)) {
      throw new PayloadError("SendGrid event is missing sg_event_id or event", "missing_event_metadata");
    }

    const ids = eventIds as string[];
    const types = eventTypes as string[];
    const eventId = ids.length === 1
      ? ids[0]!
      : `batch-${await sha256Hex([...ids].sort().join("\n"))}`;
    const eventType = types.every((value) => value === types[0]) ? types[0]! : "batch";
    const defaultUserId = commonIdentity(events);

    const result: VerifiedWebhook = {
      provider: this.name,
      eventId,
      eventType,
      body: events,
      forwardedHeaders: forwarded(request.headers, forwardedHeaders),
    };
    if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
    return result;
  }
}

function decodePublicKey(value: string): Uint8Array {
  const encoded = value
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  if (encoded.length === 0) throw new Error("empty SendGrid public key");
  return base64ToBytes(encoded);
}

function parseEvents(request: WebhookRequest): Record<string, unknown>[] {
  let body: unknown;
  try {
    body = JSON.parse(utf8String(request.body));
  } catch {
    throw new PayloadError("SendGrid webhook body must be a JSON array");
  }
  if (
    !Array.isArray(body)
    || body.length === 0
    || body.some((event) => typeof event !== "object" || event === null || Array.isArray(event))
  ) {
    throw new PayloadError("SendGrid webhook body must be a non-empty array of events");
  }
  return body as Record<string, unknown>[];
}

function commonIdentity(events: Record<string, unknown>[]): string | undefined {
  const identities = events.map(eventIdentity);
  const first = identities[0];
  return first !== undefined && identities.every((identity) => identity === first)
    ? first
    : undefined;
}

function eventIdentity(event: Record<string, unknown>): string | undefined {
  return stringAt(event, "aqueduct_user_id")
    ?? stringAt(event, "tenant_id")
    ?? stringAt(event, "account_id")
    ?? stringAt(event, "user_id")
    ?? stringAt(event, "sg_message_id")
    ?? stringAt(event, "email")
    ?? stringAt(event, "asm_group_id");
}

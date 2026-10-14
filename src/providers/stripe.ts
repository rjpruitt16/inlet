import { bytesToHex, constantTimeEqual, hmacSha256, utf8, utf8String } from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = ["stripe-signature", "stripe-account", "stripe-context"] as const;

export class StripeProvider implements ProviderAdapter {
  readonly name = "stripe" as const;

  constructor(private readonly toleranceSeconds = 300) {}

  async verify(request: WebhookRequest, secret: string, now = new Date()): Promise<VerifiedWebhook> {
    const signatureHeader = requiredHeader(request, "stripe-signature");
    const fields = parseStripeSignature(signatureHeader);
    const timestamp = Number(fields.timestamp);
    if (!Number.isSafeInteger(timestamp)) {
      throw new VerificationError("invalid Stripe signature timestamp");
    }
    if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > this.toleranceSeconds) {
      throw new VerificationError("Stripe signature timestamp is outside the tolerance");
    }

    const signed = utf8(`${fields.timestamp}.${utf8String(request.body)}`);
    const expected = bytesToHex(await hmacSha256(utf8(secret), signed));
    if (!fields.signatures.some((signature) => constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected)))) {
      throw new VerificationError("Stripe signature verification failed");
    }

    const body = parseJsonBody(request);
    const eventId = stringAt(body, "id");
    const eventType = stringAt(body, "type");
    if (!eventId || !eventType) {
      throw new VerificationError("Stripe event is missing id or type", "missing_event_metadata");
    }
    const defaultUserId =
      stringAt(body, "account") ?? request.headers["stripe-account"] ?? request.headers["stripe-context"];

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

function parseStripeSignature(value: string): { timestamp: string; signatures: string[] } {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const field = part.slice(separator + 1).trim();
    if (key === "t") timestamp = field;
    if (key === "v1") signatures.push(field);
  }
  if (!timestamp || signatures.length === 0) {
    throw new VerificationError("invalid Stripe signature format");
  }
  return { timestamp, signatures };
}

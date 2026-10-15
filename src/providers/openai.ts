import {
  base64ToBytes,
  bytesToBase64,
  constantTimeEqual,
  hmacSha256,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = ["webhook-id", "webhook-signature", "webhook-timestamp"] as const;

export class OpenAIProvider implements ProviderAdapter {
  readonly name = "openai" as const;

  constructor(private readonly toleranceSeconds = 300) {}

  async verify(request: WebhookRequest, secret: string, now = new Date()): Promise<VerifiedWebhook> {
    const eventId = requiredHeader(request, "webhook-id");
    const timestampText = requiredHeader(request, "webhook-timestamp");
    const signatureHeader = requiredHeader(request, "webhook-signature");
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp)) {
      throw new VerificationError("invalid OpenAI webhook timestamp");
    }
    if (Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) > this.toleranceSeconds) {
      throw new VerificationError("OpenAI webhook timestamp is outside the tolerance");
    }

    const secretBytes = secret.startsWith("whsec_") ? base64ToBytes(secret.slice(6)) : utf8(secret);
    const signed = utf8(`${eventId}.${timestampText}.${utf8String(request.body)}`);
    const expected = bytesToBase64(await hmacSha256(secretBytes, signed));
    const signatures = signatureHeader
      .split(" ")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("v1,"))
      .map((part) => part.slice(3));
    if (!signatures.some((signature) => constantTimeEqual(utf8(signature), utf8(expected)))) {
      throw new VerificationError("OpenAI signature verification failed");
    }

    const body = parseJsonBody(request);
    const eventType = stringAt(body, "type");
    if (!eventType) {
      throw new VerificationError("OpenAI event is missing type", "missing_event_metadata");
    }
    const defaultUserId =
      stringAt(body, "project_id")
      ?? stringAt(body, "organization_id")
      ?? stringAt(body, "data", "project_id")
      ?? stringAt(body, "data", "organization_id");

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

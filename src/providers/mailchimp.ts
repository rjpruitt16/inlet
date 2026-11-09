import {
  bytesToHex,
  constantTimeEqual,
  hmacSha256,
  sha256HexBytes,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = ["content-type", "x-mailchimp-signature"] as const;

export class MailchimpProvider implements ProviderAdapter {
  readonly name = "mailchimp" as const;

  constructor(private readonly toleranceSeconds = 300) {}

  /** Verifies Mailchimp's timestamped HMAC before parsing its nested form body. */
  async verify(request: WebhookRequest, secret: string, now = new Date()): Promise<VerifiedWebhook> {
    const signatureHeader = requiredHeader(request, "x-mailchimp-signature");
    const { timestamp, signatures } = parseSignature(signatureHeader);
    if (Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) > this.toleranceSeconds) {
      throw new VerificationError("Mailchimp webhook timestamp is outside the tolerance");
    }

    const signed = utf8(`${timestamp}.${utf8String(request.body)}`);
    const expected = bytesToHex(await hmacSha256(utf8(secret), signed));
    if (!signatures.some((signature) =>
      constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected)))) {
      throw new VerificationError("Mailchimp signature verification failed");
    }

    const body = parseFormBody(request);
    const eventType = stringAt(body, "type");
    if (!eventType) {
      throw new PayloadError("Mailchimp webhook is missing type", "missing_event_metadata");
    }
    const defaultUserId =
      stringAt(body, "data", "id")
      ?? stringAt(body, "data", "list_id")
      ?? stringAt(body, "data", "campaign_id")
      ?? stringAt(body, "data", "email");

    const result: VerifiedWebhook = {
      provider: this.name,
      eventId: `body-${await sha256HexBytes(request.body)}`,
      eventType,
      body,
      forwardedHeaders: forwarded(request.headers, forwardedHeaders),
    };
    if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
    return result;
  }
}

/** Parses Mailchimp's comma-separated timestamp and signature versions. */
function parseSignature(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const [name, value] = item.trim().split("=", 2);
    if (name === "t" && value !== undefined && /^\d+$/.test(value)) {
      timestamp = Number(value);
    } else if (name === "v1" && value !== undefined && /^[a-f0-9]{64}$/i.test(value)) {
      signatures.push(value);
    }
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) {
    throw new VerificationError("invalid Mailchimp signature header");
  }
  return { timestamp: timestamp as number, signatures };
}

/** Parses Mailchimp bracket notation without exposing inherited object properties. */
function parseFormBody(request: WebhookRequest): Record<string, unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new PayloadError("Mailchimp webhooks must use application/x-www-form-urlencoded");
  }

  const body = Object.create(null) as Record<string, unknown>;
  const params = new URLSearchParams(utf8String(request.body));
  for (const [name, value] of params) {
    setFormValue(body, name.replace(/\]/g, "").split("["), value);
  }
  return body;
}

/** Writes one nested form value while rejecting prototype traversal segments. */
function setFormValue(target: Record<string, unknown>, path: string[], value: string): void {
  if (path.some(isUnsafeFormSegment)) {
    throw new PayloadError("Mailchimp webhook contains an unsafe form field");
  }

  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const nested = Object.create(null) as Record<string, unknown>;
      current[segment] = nested;
      current = nested;
    }
  }
  const last = path.at(-1);
  if (last !== undefined && last.length > 0) current[last] = value;
}

/** Identifies property names that can escape a nested form-data container. */
function isUnsafeFormSegment(segment: string): boolean {
  return segment === "__proto__" || segment === "prototype" || segment === "constructor";
}

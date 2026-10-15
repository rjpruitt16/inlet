import {
  bytesToHex,
  constantTimeEqual,
  hmacSha256,
  sha256HexBytes,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type {
  ProviderAdapter,
  ProviderChallengeResponse,
  VerifiedWebhook,
  WebhookRequest,
} from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = [
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

export class SlackProvider implements ProviderAdapter {
  readonly name = "slack" as const;

  constructor(private readonly toleranceSeconds = 300) {}

  async verify(request: WebhookRequest, secret: string, now = new Date()): Promise<VerifiedWebhook> {
    await this.verifySignature(request, secret, now);
    const body = parseSlackBody(request);
    if (stringAt(body, "type") === "url_verification") {
      throw new PayloadError(
        "Slack URL verification must be answered immediately",
        "unexpected_verification_challenge",
      );
    }

    const eventId =
      stringAt(body, "event_id")
      ?? stringAt(body, "trigger_id")
      ?? `body-${await sha256HexBytes(request.body)}`;
    const outerType = stringAt(body, "type");
    const eventType =
      (outerType === "event_callback" ? stringAt(body, "event", "type") : outerType)
      ?? (stringAt(body, "command") ? `slash_command:${stringAt(body, "command")}` : undefined);
    if (!eventType) {
      throw new VerificationError("Slack event is missing type", "missing_event_metadata");
    }
    const defaultUserId =
      stringAt(body, "team_id")
      ?? stringAt(body, "team", "id")
      ?? stringAt(body, "context_team_id")
      ?? stringAt(body, "enterprise_id")
      ?? stringAt(body, "enterprise", "id");

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

  async respondImmediately(
    request: WebhookRequest,
    secret: string,
    now = new Date(),
  ): Promise<ProviderChallengeResponse | undefined> {
    const contentType = contentTypeOf(request);
    if (contentType !== "application/json") return undefined;

    const body = parseJsonBody(request);
    if (stringAt(body, "type") !== "url_verification") return undefined;
    await this.verifySignature(request, secret, now);

    const challenge = stringAt(body, "challenge");
    if (!challenge) {
      throw new PayloadError("Slack URL verification is missing challenge");
    }
    return {
      statusCode: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: challenge,
    };
  }

  private async verifySignature(
    request: WebhookRequest,
    secret: string,
    now: Date,
  ): Promise<void> {
    const timestampText = requiredHeader(request, "x-slack-request-timestamp");
    const signature = requiredHeader(request, "x-slack-signature");
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp)) {
      throw new VerificationError("invalid Slack request timestamp");
    }
    if (Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) > this.toleranceSeconds) {
      throw new VerificationError("Slack request timestamp is outside the tolerance");
    }

    const base = utf8(`v0:${timestampText}:${utf8String(request.body)}`);
    const expected = `v0=${bytesToHex(await hmacSha256(utf8(secret), base))}`;
    if (!constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected))) {
      throw new VerificationError("Slack signature verification failed");
    }
  }
}

function parseSlackBody(request: WebhookRequest): Record<string, unknown> {
  const contentType = contentTypeOf(request);
  if (contentType === "application/json") return parseJsonBody(request);
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new PayloadError(
      "Slack webhooks must use application/json or application/x-www-form-urlencoded",
    );
  }

  const params = new URLSearchParams(utf8String(request.body));
  const payload = params.get("payload");
  if (payload !== null) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new PayloadError("Slack payload field must contain a JSON object");
    }
    throw new PayloadError("Slack payload field must contain a JSON object");
  }

  const body: Record<string, unknown> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    body[name] = values.length === 1 ? values[0] : values;
  }
  return body;
}

function contentTypeOf(request: WebhookRequest): string | undefined {
  return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
}

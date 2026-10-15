import {
  bytesToBase64,
  constantTimeEqual,
  hmacSha1,
  sha256HexBytes,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = [
  "x-twilio-signature",
  "x-twilio-webhooks-signature-settings",
] as const;

export class TwilioProvider implements ProviderAdapter {
  readonly name = "twilio" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const signature = requiredHeader(request, "x-twilio-signature");
    if (!request.url) {
      throw new VerificationError(
        "Twilio verification requires the externally visible request URL",
        "missing_request_url",
      );
    }

    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    let body: Record<string, unknown>;
    let signedValue: string;

    if (contentType === "application/x-www-form-urlencoded") {
      const params = new URLSearchParams(utf8String(request.body));
      body = formBody(params);
      signedValue = formSignedValue(request.url, params);
    } else if (contentType === "application/json") {
      const expectedBodyHash = new URL(request.url).searchParams.get("bodySHA256");
      if (!expectedBodyHash) {
        throw new VerificationError(
          "Twilio JSON webhook URL is missing bodySHA256",
          "missing_body_hash",
        );
      }
      const actualBodyHash = await sha256HexBytes(request.body);
      if (!constantTimeEqual(utf8(expectedBodyHash.toLowerCase()), utf8(actualBodyHash))) {
        throw new VerificationError("Twilio webhook body hash verification failed");
      }
      body = parseJsonBody(request);
      signedValue = request.url;
    } else {
      throw new PayloadError(
        "Twilio webhooks must use application/x-www-form-urlencoded or application/json",
      );
    }

    const expected = bytesToBase64(await hmacSha1(utf8(secret), utf8(signedValue)));
    if (!constantTimeEqual(utf8(signature), utf8(expected))) {
      throw new VerificationError("Twilio signature verification failed");
    }

    const eventId =
      firstString(body, [
        "EventSid",
        "MessageSid",
        "SmsSid",
        "CallSid",
        "VerificationSid",
        "ConversationSid",
        "Sid",
      ]) ?? `body-${await sha256HexBytes(request.body)}`;
    const eventType =
      firstString(body, ["EventType", "MessageStatus", "SmsStatus", "CallStatus", "Status"])
      ?? "twilio.webhook";
    const defaultUserId = firstString(body, ["AccountSid", "MessagingServiceSid", "ServiceSid"]);

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

function formSignedValue(url: string, params: URLSearchParams): string {
  const names = Array.from(new Set(params.keys())).sort();
  return names.reduce((value, name) => {
    const fields = Array.from(new Set(params.getAll(name))).sort();
    return fields.reduce((current, field) => current + name + field, value);
  }, url);
}

function formBody(params: URLSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    body[name] = values.length === 1 ? values[0] : values;
  }
  return body;
}

function firstString(body: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = stringAt(body, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

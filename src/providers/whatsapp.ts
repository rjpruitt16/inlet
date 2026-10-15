import {
  bytesToHex,
  constantTimeEqual,
  hmacSha256,
  sha256HexBytes,
  utf8,
} from "../core/encoding.js";
import { InletError, VerificationError } from "../core/errors.js";
import type {
  ProviderAdapter,
  ProviderChallengeResponse,
  VerifiedWebhook,
  WebhookRequest,
} from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = ["x-hub-signature-256"] as const;

export class WhatsAppProvider implements ProviderAdapter {
  readonly name = "whatsapp" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const signature = requiredHeader(request, "x-hub-signature-256");
    if (!signature.startsWith("sha256=")) {
      throw new VerificationError("invalid WhatsApp signature format");
    }

    const expected = bytesToHex(await hmacSha256(utf8(secret), request.body));
    if (!constantTimeEqual(utf8(signature.slice(7).toLowerCase()), utf8(expected))) {
      throw new VerificationError("WhatsApp signature verification failed");
    }

    const body = parseJsonBody(request);
    const metadata = whatsappMetadata(body);
    const eventIds = metadata.eventIds;
    const eventId =
      eventIds.length === 1
        ? eventIds[0]!
        : `body-${await sha256HexBytes(request.body)}`;

    const result: VerifiedWebhook = {
      provider: this.name,
      eventId,
      eventType: metadata.eventType,
      body,
      forwardedHeaders: forwarded(request.headers, forwardedHeaders),
    };
    if (metadata.defaultUserId !== undefined) result.defaultUserId = metadata.defaultUserId;
    return result;
  }

  async verifyChallenge(
    request: WebhookRequest,
    verificationSecret: string,
  ): Promise<ProviderChallengeResponse> {
    if (!request.url) {
      throw new InletError("WhatsApp verification URL is unavailable", 400, "missing_request_url");
    }
    const query = new URL(request.url).searchParams;
    const mode = query.get("hub.mode");
    const token = query.get("hub.verify_token");
    const challenge = query.get("hub.challenge");
    if (
      mode !== "subscribe"
      || token === null
      || challenge === null
      || !constantTimeEqual(utf8(token), utf8(verificationSecret))
    ) {
      throw new InletError(
        "WhatsApp verification token mismatch",
        403,
        "invalid_verification_token",
      );
    }
    return {
      statusCode: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: challenge,
    };
  }
}

function whatsappMetadata(body: Record<string, unknown>): {
  eventIds: string[];
  eventType: string;
  defaultUserId?: string;
} {
  const eventIds: string[] = [];
  let eventType = "whatsapp.webhook";
  let defaultUserId: string | undefined;

  const entries = arrayRecords(body.entry);
  for (const entry of entries) {
    for (const change of arrayRecords(entry.changes)) {
      const value = recordAt(change, "value");
      if (!value) continue;

      const messages = arrayRecords(value.messages);
      const statuses = arrayRecords(value.statuses);
      for (const message of messages) {
        const id = stringAt(message, "id");
        if (id) eventIds.push(id);
      }
      for (const status of statuses) {
        const id = stringAt(status, "id");
        if (id) eventIds.push(id);
      }

      if (eventType === "whatsapp.webhook") {
        const messageType = messages[0] ? stringAt(messages[0], "type") : undefined;
        const statusType = statuses[0] ? stringAt(statuses[0], "status") : undefined;
        const field = stringAt(change, "field") ?? "webhook";
        eventType = messageType
          ? `${field}.${messageType}`
          : statusType
            ? `${field}.status.${statusType}`
            : field;
      }

      defaultUserId ??=
        (messages[0] ? stringAt(messages[0], "from") : undefined)
        ?? (statuses[0] ? stringAt(statuses[0], "recipient_id") : undefined)
        ?? (arrayRecords(value.contacts)[0]
          ? stringAt(arrayRecords(value.contacts)[0], "wa_id")
          : undefined)
        ?? stringAt(value, "metadata", "phone_number_id")
        ?? stringAt(entry, "id");
    }
  }

  const result: {
    eventIds: string[];
    eventType: string;
    defaultUserId?: string;
  } = { eventIds, eventType };
  if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
  return result;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate as Record<string, unknown>;
}

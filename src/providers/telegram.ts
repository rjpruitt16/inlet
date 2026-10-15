import { constantTimeEqual, utf8 } from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = ["x-telegram-bot-api-secret-token"] as const;

export class TelegramProvider implements ProviderAdapter {
  readonly name = "telegram" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const supplied = requiredHeader(request, "x-telegram-bot-api-secret-token");
    if (!constantTimeEqual(utf8(supplied), utf8(secret))) {
      throw new VerificationError("Telegram secret token verification failed");
    }

    const body = parseJsonBody(request);
    const eventId = stringAt(body, "update_id");
    if (!eventId) {
      throw new VerificationError("Telegram update is missing update_id", "missing_event_metadata");
    }

    const eventType = Object.keys(body).find((key) => key !== "update_id");
    if (!eventType) {
      throw new VerificationError("Telegram update is missing an event", "missing_event_metadata");
    }

    const defaultUserId = telegramIdentity(body, eventType);
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

function telegramIdentity(body: Record<string, unknown>, eventType: string): string | undefined {
  return (
    stringAt(body, eventType, "chat", "id") ??
    stringAt(body, eventType, "message", "chat", "id") ??
    stringAt(body, eventType, "from", "id") ??
    stringAt(body, eventType, "user", "id")
  );
}

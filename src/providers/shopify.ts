import { bytesToBase64, constantTimeEqual, hmacSha256, utf8 } from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader } from "./shared.js";

const forwardedHeaders = [
  "x-shopify-api-version",
  "x-shopify-event-id",
  "x-shopify-hmac-sha256",
  "x-shopify-shop-domain",
  "x-shopify-topic",
  "x-shopify-triggered-at",
  "x-shopify-webhook-id",
] as const;

export class ShopifyProvider implements ProviderAdapter {
  readonly name = "shopify" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const signature = requiredHeader(request, "x-shopify-hmac-sha256");
    const expected = bytesToBase64(await hmacSha256(utf8(secret), request.body));
    if (!constantTimeEqual(utf8(signature), utf8(expected))) {
      throw new VerificationError("Shopify signature verification failed");
    }

    const body = parseJsonBody(request);
    const eventId = request.headers["x-shopify-event-id"] ?? request.headers["x-shopify-webhook-id"];
    if (!eventId) {
      throw new VerificationError("missing Shopify event ID", "missing_event_id");
    }

    const result: VerifiedWebhook = {
      provider: this.name,
      eventId,
      eventType: requiredHeader(request, "x-shopify-topic"),
      body,
      forwardedHeaders: forwarded(request.headers, forwardedHeaders),
    };
    const shop = request.headers["x-shopify-shop-domain"];
    if (shop) result.defaultUserId = shop;
    return result;
  }
}

import { bytesToBase64, constantTimeEqual, hmacSha256, utf8 } from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

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
    const eventId = requiredHeader(request, "x-shopify-webhook-id");

    const shop = request.headers["x-shopify-shop-domain"];
    const defaultUserId = shopifyIdentity(
      body,
      request.headers["x-shopify-topic"],
      shop,
    );
    const result: VerifiedWebhook = {
      provider: this.name,
      eventId,
      eventType: requiredHeader(request, "x-shopify-topic"),
      body,
      forwardedHeaders: forwarded(request.headers, forwardedHeaders),
    };
    if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
    return result;
  }
}

function shopifyIdentity(
  body: Record<string, unknown>,
  topic: string | undefined,
  shop: string | undefined,
): string | undefined {
  const customerId =
    stringAt(body, "customer", "admin_graphql_api_id")
    ?? stringAt(body, "data", "customer", "id")
    ?? stringAt(body, "query_variables", "customerId")
    ?? stringAt(body, "customer", "id")
    ?? stringAt(body, "customer_id")
    ?? stringAt(body, "customerId")
    ?? customerResourceId(body, topic);

  if (customerId === undefined) return shop;
  const normalizedCustomerId = normalizeCustomerId(customerId);
  return shop === undefined ? normalizedCustomerId : `${shop}:${normalizedCustomerId}`;
}

function customerResourceId(
  body: Record<string, unknown>,
  topic: string | undefined,
): string | undefined {
  const normalizedTopic = topic?.toLowerCase();
  if (normalizedTopic !== "customer" && !normalizedTopic?.startsWith("customers/")) {
    return undefined;
  }
  return stringAt(body, "admin_graphql_api_id") ?? stringAt(body, "id");
}

function normalizeCustomerId(customerId: string): string {
  return /^\d+$/.test(customerId)
    ? `gid://shopify/Customer/${customerId}`
    : customerId;
}

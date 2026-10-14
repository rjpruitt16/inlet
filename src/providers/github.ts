import { bytesToHex, constantTimeEqual, hmacSha256, utf8 } from "../core/encoding.js";
import { VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = [
  "x-github-delivery",
  "x-github-event",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
  "x-hub-signature-256",
] as const;

export class GitHubProvider implements ProviderAdapter {
  readonly name = "github" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const signature = requiredHeader(request, "x-hub-signature-256");
    if (!signature.startsWith("sha256=")) {
      throw new VerificationError("invalid GitHub signature format");
    }

    const expected = bytesToHex(await hmacSha256(utf8(secret), request.body));
    if (!constantTimeEqual(utf8(signature.slice(7).toLowerCase()), utf8(expected))) {
      throw new VerificationError("GitHub signature verification failed");
    }

    const body = parseJsonBody(request);
    const eventId = requiredHeader(request, "x-github-delivery");
    const eventType = requiredHeader(request, "x-github-event");
    const defaultUserId =
      stringAt(body, "installation", "id") ??
      stringAt(body, "organization", "id") ??
      stringAt(body, "repository", "owner", "id") ??
      stringAt(body, "sender", "id");

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

import {
  bytesToHex,
  constantTimeEqual,
  hmacSha256,
  utf8,
  utf8String,
} from "../core/encoding.js";
import { PayloadError, VerificationError } from "../core/errors.js";
import type { ProviderAdapter, VerifiedWebhook, WebhookRequest } from "../core/types.js";
import { forwarded, parseJsonBody, requiredHeader, stringAt } from "./shared.js";

const forwardedHeaders = [
  "x-qn-nonce",
  "x-qn-signature",
  "x-qn-timestamp",
  "content-encoding",
  "stream-id",
  "stream-name",
  "stream-network",
  "stream-dataset",
  "batch-start-range",
  "batch-end-range",
] as const;

export class QuickNodeProvider implements ProviderAdapter {
  readonly name = "quicknode" as const;

  async verify(request: WebhookRequest, secret: string): Promise<VerifiedWebhook> {
    const nonce = requiredHeader(request, "x-qn-nonce");
    const timestamp = requiredHeader(request, "x-qn-timestamp");
    const signature = requiredHeader(request, "x-qn-signature");
    const payload = await decodedPayload(request);
    const signed = utf8(`${nonce}${timestamp}${utf8String(payload)}`);
    const expected = bytesToHex(await hmacSha256(utf8(secret), signed));
    if (!constantTimeEqual(utf8(signature.toLowerCase()), utf8(expected))) {
      throw new VerificationError("QuickNode signature verification failed");
    }

    const body = parseJsonBody({ ...request, body: payload });
    const network = stringAt(body, "metadata", "network") ?? request.headers["stream-network"];
    const dataset = stringAt(body, "metadata", "dataset") ?? request.headers["stream-dataset"];
    const defaultUserId =
      stringAt(body, "metadata", "stream_id")
      ?? stringAt(body, "metadata", "webhook_id")
      ?? request.headers["stream-id"];
    const forwardedHeadersForDelivery = forwarded(request.headers, forwardedHeaders);
    if (isGzipEncoded(request) && !hasGzipHeader(request.body)) {
      delete forwardedHeadersForDelivery["content-encoding"];
    }

    const result: VerifiedWebhook = {
      provider: this.name,
      eventId: nonce,
      eventType: eventType(network, dataset),
      body,
      forwardedHeaders: forwardedHeadersForDelivery,
    };
    if (defaultUserId !== undefined) result.defaultUserId = defaultUserId;
    return result;
  }
}

function eventType(network: string | undefined, dataset: string | undefined): string {
  if (network && dataset) return `${network}:${dataset}`;
  return dataset ?? network ?? "stream.delivery";
}

async function decodedPayload(request: WebhookRequest): Promise<Uint8Array> {
  if (!isGzipEncoded(request)) return request.body;

  // Some HTTP frameworks retain the gzip header after inflating the body.
  if (!hasGzipHeader(request.body)) return request.body;

  try {
    const stream = new Blob([Uint8Array.from(request.body)])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new PayloadError("QuickNode webhook body is not valid gzip");
  }
}

function isGzipEncoded(request: WebhookRequest): boolean {
  return request.headers["content-encoding"]
    ?.split(",")
    .some((encoding) => encoding.trim().toLowerCase() === "gzip") ?? false;
}

function hasGzipHeader(body: Uint8Array): boolean {
  return body[0] === 0x1f && body[1] === 0x8b;
}

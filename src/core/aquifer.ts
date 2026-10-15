import { base64ToBytes, utf8String } from "./encoding.js";
import type { AquiferResponse, AquiferTransport, DeliveryEnvelope, HeadersRecord } from "./types.js";

export interface FetchAquiferOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class FetchAquiferTransport implements AquiferTransport {
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly aquiferUrl: string,
    options: FetchAquiferOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImplementation =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async submit(envelope: DeliveryEnvelope): Promise<AquiferResponse> {
    const body: Record<string, unknown> = {
      user_id: envelope.userId,
      idempotent_key: `inlet:${envelope.provider}:${envelope.routeId}:${envelope.eventId}`,
      url: envelope.destination,
      method: "POST",
      headers: envelope.headers,
      body: utf8String(base64ToBytes(envelope.bodyBase64)),
    };
    if (envelope.completionUrl !== undefined) body.webhook_url = envelope.completionUrl;
    if (envelope.maxRetries !== undefined) body.max_retries = envelope.maxRetries;
    if (envelope.executeBefore !== undefined) body.execute_before = envelope.executeBefore;

    const response = await this.fetchImplementation(`${this.aquiferUrl.replace(/\/$/, "")}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // "enabled", not "true": Aquifer before account-queue precedence
        // (aquifer#71) only read "enabled" as on, and any other value
        // switched the destination to one shared queue.
        "x-aqueduct-account-queue": "enabled",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let responseBody: unknown;
    const text = await response.text();
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = { message: text };
      }
    }

    const headers: HeadersRecord = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return { statusCode: response.status, headers, body: responseBody };
  }
}

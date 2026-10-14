import { PayloadError, VerificationError } from "../core/errors.js";
import { utf8String } from "../core/encoding.js";
import type { HeadersRecord, WebhookRequest } from "../core/types.js";

export function requiredHeader(request: WebhookRequest, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (!value) {
    throw new VerificationError(`missing ${name} header`, "missing_signature_header");
  }
  return value;
}

export function parseJsonBody(request: WebhookRequest): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(utf8String(request.body));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new PayloadError("webhook body must be a JSON object");
  }
}

export function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string" && current.length > 0) return current;
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return undefined;
}

export function forwarded(headers: HeadersRecord, names: readonly string[]): HeadersRecord {
  const result: HeadersRecord = { "content-type": headers["content-type"] ?? "application/json" };
  for (const name of names) {
    const value = headers[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

import { PayloadError } from "./errors.js";
import type { HeadersRecord, RouteConfig, VerifiedWebhook } from "./types.js";

export function resolveUserId(
  route: RouteConfig,
  webhook: VerifiedWebhook,
  headers: HeadersRecord,
): string {
  const selector = route.fairnessKey;
  if (selector === undefined || selector === "provider") {
    return webhook.defaultUserId ?? `route:${route.id}`;
  }

  let value: unknown;
  if (selector.startsWith("header:")) {
    value = headers[selector.slice("header:".length).toLowerCase()];
  } else if (selector.startsWith("body:")) {
    value = jsonPointer(webhook.body, selector.slice("body:".length));
  } else if (selector.startsWith("literal:")) {
    value = selector.slice("literal:".length);
  } else {
    throw new PayloadError(
      `route ${route.id} has an invalid fairness_key; use provider, header:<name>, body:</json/pointer>, or literal:<value>`,
      "invalid_fairness_key",
    );
  }

  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new PayloadError(`fairness key ${selector} did not resolve to a value`, "missing_fairness_key");
  }
  return String(value);
}

function jsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) {
    throw new PayloadError("body fairness keys must use JSON Pointer syntax", "invalid_fairness_key");
  }

  let current = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

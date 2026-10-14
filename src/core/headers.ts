import type { HeadersRecord } from "./types.js";

export function normalizeHeaders(headers: HeadersRecord): HeadersRecord {
  const normalized: HeadersRecord = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

export function selectHeaders(headers: HeadersRecord, names: readonly string[]): HeadersRecord {
  const normalized = normalizeHeaders(headers);
  const selected: HeadersRecord = {};
  for (const name of names) {
    const value = normalized[name.toLowerCase()];
    if (value !== undefined) {
      selected[name.toLowerCase()] = value;
    }
  }
  return selected;
}

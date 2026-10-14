import type { ConfirmationConfig, HeadersRecord, RandomSource } from "./types.js";

export const systemRandom: RandomSource = { next: () => Math.random() };

export function confirmationDelay(
  config: ConfirmationConfig,
  random: RandomSource = systemRandom,
): number {
  const spread = config.delayMs * config.jitterRatio;
  return Math.max(1, Math.round(config.delayMs - spread + random.next() * spread * 2));
}

export function retryDelay(
  attempt: number,
  headers: HeadersRecord,
  config: ConfirmationConfig,
  now = new Date(),
  random: RandomSource = systemRandom,
): number {
  const retryAfter = parseRetryAfter(headers["retry-after"], now);
  if (retryAfter !== undefined) {
    return retryAfter + Math.round(random.next() * config.baseBackoffMs);
  }

  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const ceiling = Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** exponent);
  return Math.max(1, Math.round(random.next() * ceiling));
}

function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now.getTime());
  }
  return undefined;
}

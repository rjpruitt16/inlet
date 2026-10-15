import { parse } from "yaml";
import { ConfigurationError } from "./errors.js";
import type { ConfirmationConfig, InletConfig, ProviderName, RouteConfig } from "./types.js";

const providers = new Set<ProviderName>([
  "github",
  "shopify",
  "stripe",
  "anthropic",
  "twilio",
  "telegram",
  "whatsapp",
  "openai",
  "slack",
]);

const confirmationDefaults: ConfirmationConfig = {
  delayMs: 4_000,
  jitterRatio: 0.2,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

export function parseConfig(source: string): InletConfig {
  const raw: unknown = parse(source);
  if (!isRecord(raw)) {
    throw new ConfigurationError("configuration must be a YAML object");
  }

  const aquifer = requireString(raw, "aquifer_url");
  requireHttpUrl(aquifer, "aquifer_url");

  if (!Array.isArray(raw.routes) || raw.routes.length === 0) {
    throw new ConfigurationError("routes must be a non-empty array");
  }

  const routeIds = new Set<string>();
  const routePaths = new Set<string>();
  const routes = raw.routes.map((value, index) => {
    if (!isRecord(value)) {
      throw new ConfigurationError(`routes[${index}] must be an object`);
    }
    const route = parseRoute(value, index);
    if (routeIds.has(route.id)) {
      throw new ConfigurationError(`duplicate route id: ${route.id}`);
    }
    if (routePaths.has(route.path)) {
      throw new ConfigurationError(`duplicate route path: ${route.path}`);
    }
    routeIds.add(route.id);
    routePaths.add(route.path);
    return route;
  });

  const confirmation = parseConfirmation(raw.confirmation);
  return { aquiferUrl: aquifer.replace(/\/$/, ""), routes, confirmation };
}

function parseRoute(raw: Record<string, unknown>, index: number): RouteConfig {
  const id = requireString(raw, "id", `routes[${index}]`);
  const path = requireString(raw, "path", `routes[${index}]`);
  const provider = requireString(raw, "provider", `routes[${index}]`) as ProviderName;
  if (!providers.has(provider)) {
    throw new ConfigurationError(`routes[${index}].provider is unsupported: ${provider}`);
  }
  if (!path.startsWith("/")) {
    throw new ConfigurationError(`routes[${index}].path must start with /`);
  }

  const destination = requireString(raw, "destination", `routes[${index}]`);
  requireHttpUrl(destination, `routes[${index}].destination`);

  const route: RouteConfig = {
    id,
    path,
    provider,
    secretRef: requireString(raw, "secret_ref", `routes[${index}]`),
    destination,
  };

  assignOptionalString(route, "fairnessKey", raw.fairness_key, `routes[${index}].fairness_key`);
  assignOptionalString(route, "completionUrl", raw.completion_url, `routes[${index}].completion_url`);
  assignOptionalString(
    route,
    "verificationSecretRef",
    raw.verification_secret_ref,
    `routes[${index}].verification_secret_ref`,
  );
  assignOptionalString(route, "publicUrl", raw.public_url, `routes[${index}].public_url`);
  assignOptionalInteger(route, "maxRetries", raw.max_retries, `routes[${index}].max_retries`, -1, 100);
  assignOptionalInteger(route, "executeWithinSeconds", raw.execute_within_seconds, `routes[${index}].execute_within_seconds`, 1);

  if (route.completionUrl !== undefined) {
    requireHttpUrl(route.completionUrl, `routes[${index}].completion_url`);
  }
  if (route.publicUrl !== undefined) {
    requireHttpUrl(route.publicUrl, `routes[${index}].public_url`);
  }
  if (route.provider === "whatsapp" && route.verificationSecretRef === undefined) {
    throw new ConfigurationError(
      `routes[${index}].verification_secret_ref is required for WhatsApp`,
    );
  }
  return route;
}

function parseConfirmation(value: unknown): ConfirmationConfig {
  if (value === undefined) {
    return { ...confirmationDefaults };
  }
  if (!isRecord(value)) {
    throw new ConfigurationError("confirmation must be an object");
  }

  return {
    delayMs: optionalNumber(value.delay_ms, confirmationDefaults.delayMs, "confirmation.delay_ms", 1),
    jitterRatio: optionalNumber(value.jitter_ratio, confirmationDefaults.jitterRatio, "confirmation.jitter_ratio", 0, 1),
    baseBackoffMs: optionalNumber(value.base_backoff_ms, confirmationDefaults.baseBackoffMs, "confirmation.base_backoff_ms", 1),
    maxBackoffMs: optionalNumber(value.max_backoff_ms, confirmationDefaults.maxBackoffMs, "confirmation.max_backoff_ms", 1),
  };
}

function assignOptionalString<
  K extends "fairnessKey" | "completionUrl" | "verificationSecretRef" | "publicUrl"
>(
  route: RouteConfig,
  key: K,
  value: unknown,
  field: string,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty string`);
  }
  route[key] = value;
}

function assignOptionalInteger<K extends "maxRetries" | "executeWithinSeconds">(
  route: RouteConfig,
  key: K,
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ConfigurationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  route[key] = value as number;
}

function requireString(raw: Record<string, unknown>, key: string, prefix?: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${prefix ? `${prefix}.` : ""}${key} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(value: unknown, fallback: number, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireHttpUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${field} must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(`${field} must use http or https`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

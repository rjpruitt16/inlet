import { parse } from "yaml";
import { ConfigurationError } from "./errors.js";
import type {
  ConfirmationConfig,
  DeliveryMode,
  InletConfig,
  KafkaConfig,
  ProviderName,
  RouteConfig,
} from "./types.js";

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

const kafkaDefaults: KafkaConfig = {
  eventsTopic: "inlet.events",
  resultsTopic: "inlet.results",
  reconcile: { afterSeconds: 1_800, searchWindowSeconds: 3_600, maxRedrives: 3 },
};

// Kafka topic names: letters, digits, '.', '_' and '-', at most 249.
const topicName = /^[A-Za-z0-9._-]{1,249}$/;

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
  const delivery = parseDelivery(raw.delivery);
  const config: InletConfig = { aquiferUrl: aquifer.replace(/\/$/, ""), routes, confirmation, delivery };
  if (delivery === "kafka") {
    config.kafka = parseKafka(raw.kafka);
    routes.forEach((route, index) => {
      if (route.completionUrl !== undefined) {
        throw new ConfigurationError(
          `routes[${index}].completion_url can't be used with delivery: kafka; Inlet receives completions itself and writes them to the results topic`,
        );
      }
    });
  } else if (raw.kafka !== undefined) {
    throw new ConfigurationError("kafka settings require delivery: kafka");
  } else {
    routes.forEach((route, index) => {
      if (route.eventsTopic !== undefined || route.resultsTopic !== undefined) {
        throw new ConfigurationError(`routes[${index}] topics require delivery: kafka`);
      }
    });
  }
  return config;
}

function parseDelivery(value: unknown): DeliveryMode {
  if (value === undefined) return "sqs";
  if (value === "sqs" || value === "kafka") return value;
  throw new ConfigurationError("delivery must be sqs or kafka");
}

function parseKafka(value: unknown): KafkaConfig {
  if (value === undefined) {
    return { ...kafkaDefaults, reconcile: { ...kafkaDefaults.reconcile } };
  }
  if (!isRecord(value)) {
    throw new ConfigurationError("kafka must be an object");
  }
  const reconcile = value.reconcile;
  if (reconcile !== undefined && !isRecord(reconcile)) {
    throw new ConfigurationError("kafka.reconcile must be an object");
  }
  const r = reconcile ?? {};
  const defaults = kafkaDefaults.reconcile;
  const parsed: KafkaConfig = {
    eventsTopic: optionalTopic(value.events_topic, kafkaDefaults.eventsTopic, "kafka.events_topic"),
    resultsTopic: optionalTopic(value.results_topic, kafkaDefaults.resultsTopic, "kafka.results_topic"),
    reconcile: {
      afterSeconds: optionalInteger(r.after_seconds, defaults.afterSeconds, "kafka.reconcile.after_seconds", 1),
      searchWindowSeconds: optionalInteger(
        r.search_window_seconds,
        defaults.searchWindowSeconds,
        "kafka.reconcile.search_window_seconds",
        1,
      ),
      maxRedrives: optionalInteger(r.max_redrives, defaults.maxRedrives, "kafka.reconcile.max_redrives", 0, 100),
    },
  };
  if (parsed.reconcile.searchWindowSeconds < parsed.reconcile.afterSeconds) {
    // A result can arrive up to after_seconds late and still count.
    throw new ConfigurationError("kafka.reconcile.search_window_seconds must be at least after_seconds");
  }
  return parsed;
}

function optionalTopic(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !topicName.test(value)) {
    throw new ConfigurationError(`${field} must be a Kafka topic name (letters, digits, . _ -)`);
  }
  return value;
}

function optionalInteger(value: unknown, fallback: number, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ConfigurationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
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
  if (raw.events_topic !== undefined) {
    route.eventsTopic = optionalTopic(raw.events_topic, "", `routes[${index}].events_topic`);
  }
  if (raw.results_topic !== undefined) {
    route.resultsTopic = optionalTopic(raw.results_topic, "", `routes[${index}].results_topic`);
  }
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

import { access, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import type { ProviderName } from "../core/types.js";
import { parseInletFile } from "./deploy-config.js";
import { ask, choose, CliError, log, run } from "./util.js";

export const providers: readonly ProviderName[] = [
  "github",
  "shopify",
  "stripe",
  "anthropic",
  "openai",
  "slack",
  "twilio",
  "telegram",
  "whatsapp",
];

export type Options = Record<string, string | true>;

/** Writes inlet.yml from options, asking for whatever wasn't passed. */
export async function init(options: Options): Promise<void> {
  const path = typeof options.file === "string" ? options.file : "inlet.yml";
  if (!options.force && (await exists(path))) {
    throw new CliError(`${path} already exists; pass --force to replace it`);
  }

  const platform = await pick(options, "platform", "Where should Inlet run?", ["aws", "cloudflare"] as const, "aws");
  const delivery =
    platform === "aws"
      ? await pick(options, "delivery", "Delivery: SQS (simplest) or your own Kafka (history + redrive)?", ["sqs", "kafka"] as const, "sqs")
      : "sqs";
  const provider = await pick(options, "provider", "Webhook provider", providers, "github");
  const name = await text(options, "name", "Deployment name (stack or Worker)", `inlet-${provider}`);
  const routePath = await text(options, "path", "Webhook path", `/webhooks/${provider}/main`);
  const destination = await text(options, "destination", "Your backend URL that should receive the webhooks");
  const aquiferUrl = await text(options, "aquifer-url", "Aquifer URL, reachable from Inlet");

  const route: Record<string, unknown> = {
    id: `${provider}-main`,
    path: routePath,
    provider,
    secret_ref: platform === "aws" ? `aws-secrets:${name}-webhook-secret` : `${provider.toUpperCase()}_WEBHOOK_SECRET`,
    destination,
  };
  if (provider === "whatsapp") {
    route.verification_secret_ref = platform === "aws" ? `aws-secrets:${name}-verify-token` : "WHATSAPP_VERIFY_TOKEN";
  }

  const deploy: Record<string, unknown> = { platform, name };
  if (platform === "aws") {
    const configured = process.env.AWS_REGION ?? (await run("aws", ["configure", "get", "region"]).catch(() => "")).trim();
    deploy.region = await text(options, "region", "AWS region", configured || "us-east-1");
  }

  const document: Record<string, unknown> = { aquifer_url: aquiferUrl };
  if (delivery === "kafka") {
    document.delivery = "kafka";
    document.kafka = {
      events_topic: "inlet.events",
      results_topic: "inlet.results",
      reconcile: { after_seconds: 1800, search_window_seconds: 3600, max_redrives: 3 },
    };
    deploy.kafka = {
      brokers: await text(options, "kafka-brokers", "Kafka bootstrap servers (host:port, comma-separated; reachable over TLS)"),
      sasl_mechanism: await pick(
        options,
        "kafka-sasl",
        "Kafka SASL mechanism",
        ["scram-sha-512", "scram-sha-256", "plain"] as const,
        "scram-sha-512",
      ),
      credentials_secret: await text(options, "kafka-secret", "Secrets Manager name for the Kafka username and password", `${name}-kafka`),
      partitions: 6,
    };
  }
  document.routes = [route];
  document.deploy = deploy;

  const yaml = `# Inlet configuration. Deploy with: npx @aqueduct/inlet deploy
# Everything except deploy: is passed to Inlet as INLET_CONFIG; see the README.
${stringify(document)}`;
  parseInletFile(yaml);
  await writeFile(path, yaml);
  log(`\nWrote ${path}. Next: npx @aqueduct/inlet deploy${path === "inlet.yml" ? "" : ` --file ${path}`}`);
}

async function text(options: Options, key: string, question: string, fallback?: string): Promise<string> {
  const value = options[key];
  if (typeof value === "string" && value.length > 0) return value;
  return ask(question, fallback);
}

async function pick<T extends string>(
  options: Options,
  key: string,
  question: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  const value = options[key];
  if (typeof value === "string") {
    if (!(choices as readonly string[]).includes(value)) {
      throw new CliError(`--${key} must be one of: ${choices.join(", ")}`);
    }
    return value as T;
  }
  return choose(question, choices, fallback);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

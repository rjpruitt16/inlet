import { parse, stringify } from "yaml";
import { parseConfig } from "../core/config.js";
import { ConfigurationError } from "../core/errors.js";
import type { InletConfig } from "../core/types.js";

/**
 * The deploy: block of inlet.yml. The runtime never sees it: the CLI strips
 * it before passing the rest of the file to the functions as INLET_CONFIG.
 *
 *   deploy:
 *     platform: aws            # aws | cloudflare
 *     name: inlet-github       # CloudFormation stack or Worker name
 *     region: us-east-2        # aws only; defaults to AWS_REGION
 *     kafka:                   # delivery: kafka only
 *       brokers: broker-1.example.com:9093
 *       sasl_mechanism: scram-sha-512
 *       credentials_secret: inlet-kafka   # Secrets Manager name: {"username","password"}
 *       partitions: 6
 */
export interface DeploySettings {
  platform: "aws" | "cloudflare";
  name: string;
  region?: string;
  kafka?: KafkaDeploySettings;
}

export interface KafkaDeploySettings {
  brokers: string[];
  saslMechanism: "scram-sha-512" | "scram-sha-256" | "plain";
  credentialsSecret: string;
  partitions: number;
}

export interface InletFile {
  deploy: DeploySettings;
  /** inlet.yml without the deploy block, as the runtime reads it. */
  runtimeYaml: string;
  config: InletConfig;
}

const stackName = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;

export function parseInletFile(source: string): InletFile {
  const raw: unknown = parse(source);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigurationError("inlet.yml must be a YAML object");
  }
  const { deploy: rawDeploy, ...rest } = raw as Record<string, unknown>;
  const runtimeYaml = stringify(rest);
  const config = parseConfig(runtimeYaml);
  const deploy = parseDeploy(rawDeploy, config);
  return { deploy, runtimeYaml, config };
}

function parseDeploy(value: unknown, config: InletConfig): DeploySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError("inlet.yml needs a deploy: block (run inlet init to write one)");
  }
  const raw = value as Record<string, unknown>;
  if (raw.platform !== "aws" && raw.platform !== "cloudflare") {
    throw new ConfigurationError("deploy.platform must be aws or cloudflare");
  }
  if (typeof raw.name !== "string" || !stackName.test(raw.name)) {
    throw new ConfigurationError(
      "deploy.name must start with a letter and use only letters, digits and hyphens (at most 63)",
    );
  }
  const deploy: DeploySettings = { platform: raw.platform, name: raw.name };
  if (raw.region !== undefined) {
    if (typeof raw.region !== "string" || raw.region.length === 0) {
      throw new ConfigurationError("deploy.region must be a region name such as us-east-2");
    }
    if (raw.platform !== "aws") throw new ConfigurationError("deploy.region only applies to platform: aws");
    deploy.region = raw.region;
  }

  if (config.delivery === "kafka") {
    if (raw.platform === "cloudflare") {
      throw new ConfigurationError("delivery: kafka isn't available on Cloudflare yet; use platform: aws");
    }
    deploy.kafka = parseKafka(raw.kafka);
  } else if (raw.kafka !== undefined) {
    throw new ConfigurationError("deploy.kafka requires delivery: kafka");
  }

  for (const route of config.routes) {
    const refs: Array<[string, string | undefined]> = [
      ["secret_ref", route.secretRef],
      ["verification_secret_ref", route.verificationSecretRef],
    ];
    for (const [field, ref] of refs) {
      if (ref === undefined) continue;
      if (raw.platform === "aws" && !ref.startsWith("aws-secrets:")) {
        throw new ConfigurationError(
          `route ${route.id}: on AWS, set ${field} to aws-secrets:<name> so inlet deploy can create and grant it`,
        );
      }
      if (raw.platform === "cloudflare" && ref.includes(":") && !ref.startsWith("binding:")) {
        throw new ConfigurationError(`route ${route.id}: on Cloudflare, ${field} is a Worker secret name`);
      }
    }
  }
  return deploy;
}

function parseKafka(value: unknown): KafkaDeploySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError("delivery: kafka needs deploy.kafka with brokers and credentials_secret");
  }
  const raw = value as Record<string, unknown>;
  const brokers = (Array.isArray(raw.brokers) ? raw.brokers : String(raw.brokers ?? "").split(","))
    .map((broker) => String(broker).trim())
    .filter(Boolean);
  if (brokers.length === 0 || brokers.some((broker) => !/^[^\s:]+:\d+$/.test(broker))) {
    throw new ConfigurationError("deploy.kafka.brokers must be host:port, comma-separated or a list");
  }
  const mechanism = raw.sasl_mechanism ?? "scram-sha-512";
  if (mechanism !== "scram-sha-512" && mechanism !== "scram-sha-256" && mechanism !== "plain") {
    throw new ConfigurationError("deploy.kafka.sasl_mechanism must be scram-sha-512, scram-sha-256 or plain");
  }
  if (typeof raw.credentials_secret !== "string" || raw.credentials_secret.length === 0) {
    throw new ConfigurationError(
      'deploy.kafka.credentials_secret must name a Secrets Manager secret holding {"username","password"}',
    );
  }
  const partitions = raw.partitions ?? 6;
  if (!Number.isInteger(partitions) || (partitions as number) < 1 || (partitions as number) > 1000) {
    throw new ConfigurationError("deploy.kafka.partitions must be an integer from 1 to 1000");
  }
  return {
    brokers,
    saslMechanism: mechanism,
    credentialsSecret: raw.credentials_secret,
    partitions: partitions as number,
  };
}

/** Secrets Manager names the routes use, from aws-secrets:<name>. */
export function awsSecretNames(file: InletFile): string[] {
  const names = new Set<string>();
  for (const route of file.config.routes) {
    names.add(route.secretRef.slice("aws-secrets:".length));
    if (route.verificationSecretRef?.startsWith("aws-secrets:")) {
      names.add(route.verificationSecretRef.slice("aws-secrets:".length));
    }
  }
  if (file.deploy.kafka) names.add(file.deploy.kafka.credentialsSecret);
  return Array.from(names);
}

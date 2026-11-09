import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Kafka, logLevel, type SASLOptions } from "kafkajs";
import { awsTemplate, eventsTopics, functionNames, resultsTopics } from "./aws-template.js";
import { bundleAwsHandlers } from "./bundle.js";
import { awsSecretNames, generatedSecrets, websocketExportSecretName, type InletFile } from "./deploy-config.js";
import { ask, CliError, log, run, secretValue, step } from "./util.js";

export interface AwsDeployResult {
  webhookBaseUrl: string;
  createdSecrets: string[];
  /** Set when deploy.kafka.websocket_export is on: what to give Aquifer. */
  websocketExport?: { url: string; tokenSecret: string; region: string };
}

export async function deployAws(file: InletFile, workDir: string): Promise<AwsDeployResult> {
  const region = await awsRegion(file);
  const stack = file.deploy.name;
  await aws(["sts", "get-caller-identity"], region).catch((error: unknown) => {
    throw new CliError(`AWS credentials aren't working (${error instanceof Error ? error.message : error}). Run aws login or aws configure.`);
  });

  step(`Secrets in ${region}`);
  const { arns, created } = await ensureSecrets(file, region);

  if (file.deploy.kafka) {
    step("Kafka topics");
    await ensureTopics(file, region, arns);
  }

  step("Bundling the Lambda code");
  await mkdir(join(workDir, "aws"), { recursive: true });
  const zip = await bundleAwsHandlers(workDir);
  const zipPath = join(workDir, "aws", "inlet.zip");
  await writeFile(zipPath, zip);
  log(`  ${(zip.length / 1024).toFixed(0)} KB`);

  step(`CloudFormation stack ${stack}`);
  const templatePath = join(workDir, "aws", `${stack}.template.json`);
  await writeFile(templatePath, JSON.stringify(awsTemplate(file, arns), null, 2));
  await aws(
    [
      "cloudformation",
      "deploy",
      "--template-file",
      templatePath,
      "--stack-name",
      stack,
      "--capabilities",
      "CAPABILITY_IAM",
      "--no-fail-on-empty-changeset",
    ],
    region,
    { inherit: true },
  );

  step("Uploading the code");
  const names = functionNames(file);
  for (const name of [names.http, names.delivery, names.reconcile].filter((n): n is string => n !== undefined)) {
    await aws(["lambda", "update-function-code", "--function-name", name, "--zip-file", `fileb://${zipPath}`], region);
    await aws(["lambda", "wait", "function-updated-v2", "--function-name", name], region);
    log(`  ${name}`);
  }

  const outputs = JSON.parse(
    await aws(["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs"], region),
  ) as Array<{ OutputKey: string; OutputValue: string }>;
  const webhookBaseUrl = outputs.find((output) => output.OutputKey === "WebhookBaseUrl")?.OutputValue;
  if (!webhookBaseUrl) throw new CliError("the stack has no WebhookBaseUrl output");
  const result: AwsDeployResult = { webhookBaseUrl, createdSecrets: created };
  const tokenSecret = websocketExportSecretName(file);
  if (tokenSecret) result.websocketExport = { url: `${webhookBaseUrl}/_inlet/websocket-events`, tokenSecret, region };
  return result;
}

export async function destroyAws(file: InletFile, deleteSecrets: boolean): Promise<void> {
  const region = await awsRegion(file);
  const stack = file.deploy.name;
  step(`Deleting stack ${stack} in ${region}`);
  await aws(["cloudformation", "delete-stack", "--stack-name", stack], region);
  await aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stack], region);
  log("  deleted (functions, API, queues or Kafka triggers, schedule, logs)");

  if (deleteSecrets) {
    step("Deleting secrets");
    for (const name of [...awsSecretNames(file), ...generatedSecrets(file).map((secret) => secret.name)]) {
      try {
        await aws(["secretsmanager", "delete-secret", "--secret-id", name, "--force-delete-without-recovery"], region);
        log(`  ${name}`);
      } catch (error) {
        if (!String(error).includes("ResourceNotFoundException")) throw error;
      }
    }
  } else {
    log("\nSecrets were kept. inlet destroy --delete-secrets also removes them.");
  }
  if (file.deploy.kafka) {
    log("Kafka topics were kept: they hold your event history.");
  }
}

async function ensureSecrets(
  file: InletFile,
  region: string,
): Promise<{ arns: Map<string, string>; created: string[] }> {
  const arns = new Map<string, string>();
  const created: string[] = [];
  for (const name of awsSecretNames(file)) {
    const existing = await secretArn(name, region);
    if (existing) {
      arns.set(name, existing);
      log(`  ${name}: exists`);
      continue;
    }
    let value: string;
    if (name === file.deploy.kafka?.credentialsSecret) {
      const username = process.env.INLET_KAFKA_USERNAME ?? (await ask(`Kafka username for ${name}`));
      const password = await secretValue(name, `Kafka password for ${username}`);
      value = JSON.stringify({ username, password });
    } else {
      value = await secretValue(name, `Value for secret ${name} (the provider's webhook signing secret)`);
    }
    const arn = (
      await aws(["secretsmanager", "create-secret", "--name", name, "--secret-string", "file:///dev/stdin", "--query", "ARN", "--output", "text"], region, { input: value })
    ).trim();
    arns.set(name, arn);
    created.push(name);
    log(`  ${name}: created`);
  }

  for (const { name, description } of generatedSecrets(file)) {
    let arn = await secretArn(name, region);
    if (arn) {
      log(`  ${name}: exists`);
    } else {
      const key = randomBytes(32).toString("hex");
      arn = (
        await aws(["secretsmanager", "create-secret", "--name", name, "--description", description, "--secret-string", "file:///dev/stdin", "--query", "ARN", "--output", "text"], region, { input: key })
      ).trim();
      created.push(name);
      log(`  ${name}: created (generated)`);
    }
    arns.set(name, arn);
  }
  return { arns, created };
}

async function secretArn(name: string, region: string): Promise<string | undefined> {
  try {
    return (await aws(["secretsmanager", "describe-secret", "--secret-id", name, "--query", "ARN", "--output", "text"], region)).trim();
  } catch (error) {
    if (String(error).includes("ResourceNotFoundException")) return undefined;
    throw error;
  }
}

async function ensureTopics(file: InletFile, region: string, arns: Map<string, string>): Promise<void> {
  const settings = file.deploy.kafka!;
  const secret = JSON.parse(
    await aws(["secretsmanager", "get-secret-value", "--secret-id", arns.get(settings.credentialsSecret)!, "--query", "SecretString", "--output", "text"], region),
  ) as { username?: string; password?: string };
  if (!secret.username || !secret.password) {
    throw new CliError(`${settings.credentialsSecret} must be JSON with username and password`);
  }
  const kafka = new Kafka({
    clientId: "inlet-deploy",
    brokers: settings.brokers,
    ssl: true,
    sasl: { mechanism: settings.saslMechanism, username: secret.username, password: secret.password } as SASLOptions,
    logLevel: logLevel.NOTHING,
    retry: { retries: 2 },
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
  } catch (error) {
    throw new CliError(
      `couldn't connect to Kafka at ${settings.brokers.join(",")} over TLS with ${settings.saslMechanism}: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    const existing = new Set(await admin.listTopics());
    const wanted = [
      ...eventsTopics(file),
      ...resultsTopics(file),
      ...(settings.websocketExport ? [file.config.kafka!.websocketTopic] : []),
    ];
    const missing = wanted.filter((topic) => !existing.has(topic));
    for (const topic of wanted.filter((topic) => existing.has(topic))) log(`  ${topic}: exists`);
    if (missing.length > 0) {
      await admin.createTopics({
        waitForLeaders: true,
        topics: missing.map((topic) => ({ topic, numPartitions: settings.partitions })),
      });
      for (const topic of missing) log(`  ${topic}: created with ${settings.partitions} partitions`);
    }
  } finally {
    await admin.disconnect();
  }
}

async function awsRegion(file: InletFile): Promise<string> {
  if (file.deploy.region) return file.deploy.region;
  if (process.env.AWS_REGION) return process.env.AWS_REGION;
  const configured = (await run("aws", ["configure", "get", "region"]).catch(() => "")).trim();
  if (configured) return configured;
  throw new CliError("no AWS region: set deploy.region in inlet.yml or AWS_REGION");
}

function aws(args: string[], region: string, options: { inherit?: boolean; input?: string } = {}): Promise<string> {
  return run("aws", [...args, "--region", region], options);
}

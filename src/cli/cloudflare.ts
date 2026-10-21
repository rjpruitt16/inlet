import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimePath } from "./bundle.js";
import type { InletFile } from "./deploy-config.js";
import { CliError, log, run, secretValue, step } from "./util.js";

const wranglerPackage = "wrangler@4";

export function deadLetterQueue(file: InletFile): string {
  return `${file.deploy.name}-dead-letter`;
}

/** The Worker's secret names: route secret_ref values, without binding:. */
export function workerSecretNames(file: InletFile): string[] {
  const names = new Set<string>();
  for (const route of file.config.routes) {
    for (const ref of [route.secretRef, route.verificationSecretRef]) {
      if (ref !== undefined) names.add(ref.startsWith("binding:") ? ref.slice("binding:".length) : ref);
    }
  }
  return Array.from(names);
}

export function wranglerConfig(file: InletFile): Record<string, unknown> {
  return {
    name: file.deploy.name,
    main: runtimePath("cloudflare", "runtime.js"),
    compatibility_date: "2026-10-14",
    vars: { INLET_CONFIG: file.runtimeYaml, INLET_AQUIFER_TIMEOUT_MS: "5000" },
    durable_objects: { bindings: [{ name: "INLET_ORDERING", class_name: "InletQueueObject" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["InletQueueObject"] }],
    queues: { producers: [{ binding: "INLET_DLQ", queue: deadLetterQueue(file) }] },
  };
}

export async function deployCloudflare(file: InletFile, workDir: string): Promise<{ workerUrl: string }> {
  await wrangler(["whoami"]).catch(() => {
    throw new CliError("Cloudflare isn't logged in. Run npx wrangler login first.");
  });

  const dir = join(workDir, "cloudflare");
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, "wrangler.json");
  await writeFile(configPath, JSON.stringify(wranglerConfig(file), null, 2));

  step(`Dead-letter queue ${deadLetterQueue(file)}`);
  try {
    await wrangler(["queues", "create", deadLetterQueue(file)]);
    log("  created");
  } catch (error) {
    if (!/already (exists|taken)|11009/i.test(String(error))) throw error;
    log("  exists");
  }

  step("Worker secrets");
  const existing = await existingSecrets(file.deploy.name);
  const secrets: Record<string, string> = {};
  for (const name of workerSecretNames(file)) {
    if (existing.has(name)) {
      log(`  ${name}: set`);
      continue;
    }
    secrets[name] = await secretValue(name, `Value for Worker secret ${name} (the provider's webhook signing secret)`);
  }

  step(`Worker ${file.deploy.name}`);
  const args = ["deploy", "--config", configPath];
  const secretsPath = join(dir, "secrets.json");
  if (Object.keys(secrets).length > 0) {
    // Uploaded with the version, so the Worker is never live without them.
    await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    args.push("--secrets-file", secretsPath);
  }
  let output: string;
  try {
    output = await wrangler(args);
  } finally {
    await rm(secretsPath, { force: true });
  }
  for (const name of Object.keys(secrets)) log(`  ${name}: uploaded`);
  const workerUrl = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!workerUrl) {
    throw new CliError(`deployed, but couldn't find the workers.dev URL in wrangler's output:\n${output}`);
  }
  return { workerUrl };
}

export async function destroyCloudflare(file: InletFile): Promise<void> {
  step(`Deleting Worker ${file.deploy.name}`);
  try {
    await wrangler(["delete", "--name", file.deploy.name], { CI: "true" });
    log("  deleted, with its secrets and Durable Object data");
  } catch (error) {
    if (!/not found|10007/i.test(String(error))) throw error;
    log("  not found");
  }
  step(`Deleting queue ${deadLetterQueue(file)}`);
  try {
    await wrangler(["queues", "delete", deadLetterQueue(file)], { CI: "true" });
    log("  deleted");
  } catch (error) {
    if (!/not found|does not exist|11000/i.test(String(error))) throw error;
    log("  not found");
  }
}

async function existingSecrets(worker: string): Promise<Set<string>> {
  try {
    const listed = JSON.parse(await wrangler(["secret", "list", "--name", worker, "--format", "json"])) as Array<{ name: string }>;
    return new Set(listed.map((secret) => secret.name));
  } catch {
    // The Worker doesn't exist yet.
    return new Set();
  }
}

function wrangler(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return run("npx", ["--yes", wranglerPackage, ...args], { env, input: "" });
}

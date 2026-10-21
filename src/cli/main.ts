import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ConfigurationError } from "../core/errors.js";
import { deployAws, destroyAws } from "./aws.js";
import { deployCloudflare, destroyCloudflare } from "./cloudflare.js";
import { parseInletFile, type InletFile } from "./deploy-config.js";
import { init, type Options } from "./init.js";
import { CliError, log } from "./util.js";

const usage = `Usage: inlet <command> [options]

Commands:
  init      Write inlet.yml by answering a few questions
  deploy    Create or update the deployment described by inlet.yml
  destroy   Delete the deployment (keeps secrets and Kafka topics)

Options:
  --file <path>        Config file (default inlet.yml)
  --force              init: replace an existing file
  --delete-secrets     destroy: also delete the secrets inlet deploy created or used

init options (asked for when missing):
  --platform aws|cloudflare   --delivery sqs|kafka   --provider <name>
  --name <stack-or-worker>    --path <webhook path>  --destination <url>
  --aquifer-url <url>         --region <aws region>
  --kafka-brokers <host:port,...>  --kafka-sasl scram-sha-512|scram-sha-256|plain
  --kafka-secret <Secrets Manager name>

Secrets are asked for on the terminal, or read from INLET_SECRET_<NAME>
(and INLET_KAFKA_USERNAME) when running without one.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  try {
    switch (command) {
      case "init":
        await init(options);
        return 0;
      case "deploy":
        await deploy(await load(options));
        return 0;
      case "destroy":
        await destroy(await load(options), options["delete-secrets"] === true);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        log(usage);
        return command === undefined ? 1 : 0;
      default:
        log(`Unknown command: ${command}\n\n${usage}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof ConfigurationError) {
      log(`\nError: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function deploy(file: InletFile): Promise<void> {
  const workDir = workDirFor(file);
  const routes = file.config.routes;
  if (file.deploy.platform === "aws") {
    const result = await deployAws(file, workDir);
    log(`\nDeployed ${file.deploy.name}. Point your provider's webhooks at:`);
    for (const route of routes) log(`  ${route.id}: ${result.webhookBaseUrl}${route.path}`);
  } else {
    const result = await deployCloudflare(file, workDir);
    log(`\nDeployed ${file.deploy.name}. Point your provider's webhooks at:`);
    for (const route of routes) log(`  ${route.id}: ${result.workerUrl}${route.path}`);
  }
}

async function destroy(file: InletFile, deleteSecrets: boolean): Promise<void> {
  if (file.deploy.platform === "aws") await destroyAws(file, deleteSecrets);
  else await destroyCloudflare(file);
  log(`\nDestroyed ${file.deploy.name}.`);
}

let configDir = process.cwd();

async function load(options: Options): Promise<InletFile> {
  const path = resolve(typeof options.file === "string" ? options.file : "inlet.yml");
  configDir = dirname(path);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new CliError(`can't read ${path}; run inlet init to create it`);
  }
  return parseInletFile(source);
}

/** Generated files (templates, bundles) go next to inlet.yml in .inlet/. */
function workDirFor(file: InletFile): string {
  return join(configDir, ".inlet", file.deploy.name);
}

export function parseOptions(args: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new CliError(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) {
      options[key] = inline;
    } else if (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
      options[key] = args[index + 1]!;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

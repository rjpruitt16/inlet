import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface RunOptions {
  /** Written to the command's stdin. */
  input?: string;
  /** Print the command's output as it runs instead of capturing it. */
  inherit?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Runs a command and returns its stdout. Throws CliError with stderr on failure. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "inherit" : "pipe", options.inherit ? "inherit" : "pipe", options.inherit ? "inherit" : "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        new CliError(
          error.code === "ENOENT" ? `${command} isn't installed or isn't on PATH` : `${command}: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new CliError(`${command} ${args.slice(0, 3).join(" ")} failed:\n${(err || out).trim()}`));
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export function log(message: string): void {
  stdout.write(`${message}\n`);
}

export function step(message: string): void {
  stdout.write(`\n» ${message}\n`);
}

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** Asks a question; returns the default when there's no terminal. */
export async function ask(question: string, fallback?: string): Promise<string> {
  if (!isInteractive()) {
    if (fallback !== undefined) return fallback;
    throw new CliError(`${question} (no terminal to ask on; pass it as an option)`);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
    return answer || fallback || (await ask(question, fallback));
  } finally {
    rl.close();
  }
}

export async function choose<T extends string>(question: string, choices: readonly T[], fallback: T): Promise<T> {
  for (;;) {
    const answer = await ask(`${question} (${choices.join("/")})`, fallback);
    if ((choices as readonly string[]).includes(answer)) return answer as T;
    log(`  choose one of: ${choices.join(", ")}`);
  }
}

/** Asks for a secret without echoing it. */
export async function askSecret(question: string): Promise<string> {
  if (!isInteractive()) {
    throw new CliError(`${question} (no terminal to ask on)`);
  }
  stdout.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          finish();
          if (value.length === 0) reject(new CliError("a value is required"));
          else resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new CliError("cancelled"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}

/**
 * A secret's value: INLET_SECRET_<NAME> from the environment if set (for CI),
 * otherwise asked for on the terminal.
 */
export async function secretValue(name: string, question: string): Promise<string> {
  const variable = `INLET_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const fromEnv = process.env[variable];
  if (fromEnv) return fromEnv;
  if (!isInteractive()) {
    throw new CliError(`${question}: set ${variable} or run inlet deploy in a terminal`);
  }
  return askSecret(question);
}

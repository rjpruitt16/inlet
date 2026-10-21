import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";

/** This package's compiled runtimes, next to the compiled CLI. */
export function runtimePath(...segments: string[]): string {
  return fileURLToPath(new URL(join("..", "runtimes", ...segments), import.meta.url));
}

/**
 * Bundles the AWS handlers into one CommonJS index.js and zips it, so a
 * deploy needs neither Docker nor an S3 bucket. The AWS SDK is left out:
 * the Lambda Node.js runtime provides it.
 */
export async function bundleAwsHandlers(workDir: string): Promise<Uint8Array> {
  const outfile = join(workDir, "aws", "index.js");
  await build({
    entryPoints: [runtimePath("aws", "index.js")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["@aws-sdk/*"],
    legalComments: "none",
    logLevel: "error",
  });
  const code = await readFile(outfile);
  return zipSync({ "index.js": new Uint8Array(code) }, { level: 6 });
}

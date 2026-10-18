// Bundles each plugin with esbuild (Inlet's encoding.ts swapped for
// ./encoding.ts) and compiles it to WebAssembly with extism-js.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(here, "../../dist/canalis");
const plugins = ["shopify", "github", "stripe", "anthropic"];
mkdirSync(out, { recursive: true });

for (const name of plugins) {
  const js = path.join(out, `${name}.js`);
  await build({
    entryPoints: [path.join(here, `${name}.ts`)],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    outfile: js,
    logLevel: "warning",
    plugins: [
      {
        name: "canalis-encoding",
        setup(b) {
          b.onResolve({ filter: /core\/encoding\.js$/ }, () => ({ path: path.join(here, "encoding.ts") }));
        },
      },
    ],
  });
  execFileSync("extism-js", [js, "-i", path.join(here, "interface.d.ts"), "-o", path.join(out, `${name}.wasm`)], { stdio: "inherit" });
  console.log(`built dist/canalis/${name}.wasm`);
}

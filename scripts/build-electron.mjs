import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distElectronDir = path.join(
  rootDir,
  "apps",
  "operator-web",
  "dist-electron"
);

async function buildTarget(entryPoint, outfile, extra = {}) {
  await build({
    bundle: true,
    entryPoints: [entryPoint],
    external: ["electron"],
    format: "esm",
    logLevel: "info",
    outfile,
    packages: "external",
    platform: "node",
    sourcemap: false,
    target: "node20",
    ...extra,
  });
}

await rm(distElectronDir, { recursive: true, force: true });
await Promise.all([
  mkdir(path.join(distElectronDir, "main"), { recursive: true }),
  mkdir(path.join(distElectronDir, "preload"), { recursive: true }),
  mkdir(path.join(distElectronDir, "runner"), { recursive: true }),
]);

await buildTarget(
  path.join(rootDir, "electron", "main", "index.ts"),
  path.join(distElectronDir, "main", "index.js")
);

await buildTarget(
  path.join(rootDir, "electron", "preload", "index.ts"),
  path.join(distElectronDir, "preload", "index.mjs")
);

await buildTarget(
  path.join(rootDir, "apps", "runner", "src", "index.ts"),
  path.join(distElectronDir, "runner", "index.js")
);

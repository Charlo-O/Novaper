import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";
import kill from "tree-kill";

const killTree = promisify(kill);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const nodeBinary = process.execPath;
const buildScript = path.join(rootDir, "scripts", "build-electron.mjs");
const viteCli = path.join(
  rootDir,
  "apps",
  "operator-web",
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);
const electronBinary = path.join(
  rootDir,
  "node_modules",
  "electron",
  "dist",
  isWindows ? "electron.exe" : "electron",
);
const electronEntry = path.join(
  rootDir,
  "apps",
  "operator-web",
  "dist-electron",
  "main",
  "index.js",
);
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:3000";
const isDryRun = process.argv.includes("--dry-run");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnChild(command, args, extra = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extra.env },
    ...extra,
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return child;
}

async function runBuild() {
  await new Promise((resolve, reject) => {
    const child = spawnChild(nodeBinary, [buildScript]);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`build:electron exited with code ${code ?? "unknown"}`));
    });
  });
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const target = new URL(url);
  const requestImpl = target.protocol === "https:" ? https : http;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = requestImpl.request(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname || "/",
            method: "GET",
            timeout: 2_000,
          },
          (res) => {
            res.resume();
            if ((res.statusCode ?? 500) < 500) {
              resolve();
              return;
            }
            reject(new Error(`HTTP ${res.statusCode}`));
          },
        );

        req.on("timeout", () => req.destroy(new Error("request timed out")));
        req.on("error", reject);
        req.end();
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(
    `Timed out waiting for renderer at ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function main() {
  if (!existsSync(electronBinary)) {
    throw new Error(`Electron binary not found at ${electronBinary}`);
  }
  if (!existsSync(viteCli)) {
    throw new Error(`Vite CLI not found at ${viteCli}`);
  }

  if (isDryRun) {
    console.log(JSON.stringify({
      nodeBinary,
      buildScript,
      viteCli,
      electronBinary,
      electronEntry,
      devServerUrl,
    }, null, 2));
    return;
  }

  await runBuild();

  let shuttingDown = false;
  let viteProcess;
  let electronProcess;

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const tasks = [];
    if (electronProcess?.pid) {
      tasks.push(killTree(electronProcess.pid).catch(() => undefined));
    }
    if (viteProcess?.pid) {
      tasks.push(killTree(viteProcess.pid).catch(() => undefined));
    }
    await Promise.all(tasks);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });

  viteProcess = spawnChild(
    nodeBinary,
    [viteCli, "--host", "127.0.0.1", "--port", "3000"],
    {
      cwd: path.join(rootDir, "apps", "operator-web"),
      env: {
        ELECTRON: "1",
      },
    },
  );

  viteProcess.on("error", async (error) => {
    console.error(`[electron:dev] Failed to start Vite: ${error.message}`);
    await shutdown(1);
  });

  viteProcess.on("exit", async (code) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[electron:dev] Vite exited early with code ${code ?? "unknown"}`);
    await shutdown(code ?? 1);
  });

  await waitForUrl(devServerUrl);

  electronProcess = spawnChild(
    electronBinary,
    [electronEntry],
    {
      env: {
        ELECTRON: "1",
        VITE_DEV_SERVER_URL: devServerUrl,
      },
    },
  );

  electronProcess.on("error", async (error) => {
    console.error(`[electron:dev] Failed to start Electron: ${error.message}`);
    await shutdown(1);
  });

  electronProcess.on("exit", async (code) => {
    await shutdown(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[electron:dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

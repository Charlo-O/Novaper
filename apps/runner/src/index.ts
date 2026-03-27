import path from "node:path";
import { createServer } from "./server.js";
import { configureNetworkProxy } from "./networkProxy.js";

/**
 * Boot the Express server and return the listening instance.
 * Called by Electron main process when running as a desktop app,
 * or directly when running standalone via `tsx`.
 */
export async function bootServer(opts?: {
  port?: number;
  host?: string;
  rootDir?: string;
  userDataDir?: string;
  browserRuntimeMode?: "electron" | "playwright" | "external_cdp";
  webViewDebugBridge?: unknown;
  webViewManager?: unknown;
}) {
  const port = opts?.port ?? Number(process.env.PORT ?? 3333);
  const host = opts?.host ?? process.env.HOST ?? "127.0.0.1";
  const model = process.env.OPENAI_MODEL ?? "gpt-5.4";

  // When running inside Electron, rootDir comes from app.getPath('userData');
  // otherwise, use current working directory.
  let rootDir: string;
  if (opts?.rootDir) {
    rootDir = opts.rootDir;
  } else if (process.versions.electron) {
    // Fallback for Electron without explicit rootDir
    rootDir = path.resolve(process.cwd());
  } else {
    rootDir = path.resolve(process.cwd());
  }

  const proxy = configureNetworkProxy();

  const app = await createServer({
    rootDir,
    port,
    host,
    model,
    openAIApiKey: process.env.OPENAI_API_KEY,
    browserRuntimeMode: opts?.browserRuntimeMode,
    webViewDebugBridge: opts?.webViewDebugBridge,
    webViewManager: opts?.webViewManager,
  });

  return new Promise<typeof app>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`Novaper Runner listening on http://${host}:${port}`);
      if (proxy.enabled) {
        console.log(`Novaper Runner proxy enabled via ${proxy.source}: ${proxy.url}`);
      } else {
        console.log("Novaper Runner proxy disabled.");
      }
      resolve(app);
    });
    server.on("error", reject);
  });
}

// Auto-start when running standalone (not imported by Electron)
const isElectron = !!process.versions.electron;
if (!isElectron) {
  bootServer();
}

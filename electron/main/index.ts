import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  dialog,
} from "electron";
import log from "electron-log";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWindowManager } from "./windowManager.js";
import { WebViewManager } from "./webviewManager.js";
import { ProfileManager } from "./profileManager.js";
import {
  DEFAULT_REMOTE_DEBUG_PORT,
  WebViewDebugBridge,
} from "./webviewDebugBridge.js";

// ==================== paths ====================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DIST = path.join(__dirname, "../..");
const RENDERER_DIST = path.join(MAIN_DIST, "dist");
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// ==================== state ====================
let win: BrowserWindow | null = null;
let webViewManager: WebViewManager | null = null;
let webViewDebugBridge: WebViewDebugBridge | null = null;
const profileManager = new ProfileManager(path.join(app.getPath("userData"), "novaper-data"));
let backendPort: number = 3333;
const userData = app.getPath("userData");
const novaperDataDir = path.join(userData, "novaper-data");
const RENDERER_LOAD_RETRY_MS = 500;
const RENDERER_LOAD_MAX_ATTEMPTS = 60;
const sessionDataBootstrapPromise = profileManager.prepareSessionData();
const configuredRemoteDebuggingPort = Number(
  process.env.NOVAPER_REMOTE_DEBUG_PORT ?? DEFAULT_REMOTE_DEBUG_PORT
);
const remoteDebuggingPort =
  Number.isFinite(configuredRemoteDebuggingPort) &&
  configuredRemoteDebuggingPort > 0
    ? configuredRemoteDebuggingPort
    : DEFAULT_REMOTE_DEBUG_PORT;

app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
app.commandLine.appendSwitch(
  "remote-debugging-port",
  String(remoteDebuggingPort)
);

app.setPath("sessionData", profileManager.getSessionDataDir());

// ==================== logging ====================
log.transports.file.level = "info";
log.transports.console.level = "debug";

// ==================== single instance ====================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Handle protocol URL from second instance
    const protocolUrl = commandLine.find((arg) => arg.startsWith("novaper://"));
    if (protocolUrl) {
      handleProtocolUrl(protocolUrl);
    }
  });
}

// ==================== protocol handler ====================
if ((process as any).defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("novaper", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("novaper");
}

function handleProtocolUrl(url: string) {
  log.info(`[Protocol] Received URL: ${url}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send("protocol-url", url);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== port finding ====================
async function findAvailablePort(
  startPort: number = 3333,
  maxAttempts: number = 50
): Promise<number> {
  const net = await import("node:net");
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
      server.on("error", () => resolve(false));
    });
    if (available) return port;
  }
  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts}`
  );
}

// ==================== backend startup ====================
async function bootBackend(): Promise<number> {
  const port = await findAvailablePort(3333);
  backendPort = port;
  log.info(`[Backend] Booting Express server on port ${port}`);

  // Set env vars before importing the runner
  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";

  try {
    // Dynamic import of the runner module.
    // The runner's bootServer() starts Express in-process.
    // Path computed at runtime from PROJECT_ROOT.
    // Relative import — resolved by the bundler at build time
    const runnerEntry = path.join(
      MAIN_DIST,
      "dist-electron",
      "runner",
      "index.js"
    );
    const { bootServer } = await import(pathToFileURL(runnerEntry).href);
    await bootServer({
      port,
      host: "127.0.0.1",
      rootDir: app.isPackaged
        ? path.join((process as any).resourcesPath, "app")
        : path.resolve(MAIN_DIST, "../.."),
      userDataDir: novaperDataDir,
      browserRuntimeMode:
        process.env.NOVAPER_BROWSER_RUNTIME === "electron" ? "electron" : "external_cdp",
      webViewDebugBridge: webViewDebugBridge ?? undefined,
      webViewManager: webViewManager ?? undefined,
    });
    log.info(`[Backend] Express server ready on port ${port}`);
  } catch (err) {
    log.error(`[Backend] Failed to boot Express server:`, err);
    throw err;
  }

  return port;
}

// ==================== user-agent stripping ====================
function setupUserAgentStripping() {
  const chromeVersion = process.versions.chrome || "131.0.0.0";
  const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders["User-Agent"] = cleanUA;
    callback({ requestHeaders: details.requestHeaders });
  });
}

// ==================== window creation ====================
async function createWindow() {
  const windowManager = createWindowManager();

  win = windowManager.createMainWindow({
    preload: path.join(__dirname, "../preload/index.mjs"),
    rendererUrl: VITE_DEV_SERVER_URL || RENDERER_DIST,
  });

  let didShowWindow = false;
  const showMainWindow = () => {
    if (!win || win.isDestroyed() || didShowWindow) {
      return;
    }
    didShowWindow = true;
    win.show();
  };

  webViewManager = new WebViewManager(win);
  webViewDebugBridge = new WebViewDebugBridge(webViewManager, {
    remoteDebuggingPort,
  });

  // Register visibility hooks before loading content so we don't miss
  // ready-to-show on fast renderer startups.
  win.once("ready-to-show", showMainWindow);
  win.webContents.once("did-finish-load", showMainWindow);
  setTimeout(showMainWindow, 2000);

  // Load content
  if (VITE_DEV_SERVER_URL) {
    let loaded = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= RENDERER_LOAD_MAX_ATTEMPTS; attempt++) {
      try {
        await win.loadURL(VITE_DEV_SERVER_URL);
        loaded = true;
        break;
      } catch (error) {
        lastError = error;
        log.warn(
          `[Renderer] Failed to load ${VITE_DEV_SERVER_URL} (attempt ${attempt}/${RENDERER_LOAD_MAX_ATTEMPTS}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (attempt < RENDERER_LOAD_MAX_ATTEMPTS) {
          await sleep(RENDERER_LOAD_RETRY_MS);
        }
      }
    }
    if (!loaded) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to load renderer from ${VITE_DEV_SERVER_URL}`);
    }
  } else {
    await win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  // Open external links in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
    webViewManager?.destroy();
    webViewManager = null;
    webViewDebugBridge = null;
  });
}

// ==================== IPC handlers ====================
function registerIpcHandlers() {
  // Window control
  ipcMain.on("window-close", () => win?.close());
  ipcMain.on("window-minimize", () => win?.minimize());
  ipcMain.on("window-toggle-maximize", () => {
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.handle("is-fullscreen", () => win?.isFullScreen() ?? false);

  // App info
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-backend-port", () => backendPort);

  // File dialogs
  ipcMain.handle("select-file", async (_event, options) => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      ...options,
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("read-file", async (_event, filePath: string) => {
    const fs = await import("node:fs/promises");
    return fs.readFile(filePath, "utf-8");
  });
  ipcMain.handle("open-external-url", async (_event, url: string) =>
    shell.openExternal(url)
  );

  // Log export
  ipcMain.handle("export-log", async () => {
    const logPath = log.transports.file.getFile().path;
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: "novaper.log",
      filters: [{ name: "Log Files", extensions: ["log"] }],
    });
    if (!result.canceled && result.filePath) {
      const fs = await import("node:fs/promises");
      await fs.copyFile(logPath, result.filePath);
      return result.filePath;
    }
    return null;
  });

  // WebView IPC (Phase 2 will populate these)
  ipcMain.handle("create-webview", (_event, id: string, url: string) =>
    webViewManager?.createWebview(id, url)
  );
  ipcMain.handle("show-webview", (_event, id: string) =>
    webViewManager?.showWebview(id)
  );
  ipcMain.handle("hide-webview", (_event, id: string) =>
    webViewManager?.hideWebview(id)
  );
  ipcMain.handle("hide-all-webview", () =>
    webViewManager?.hideAllWebview()
  );
  ipcMain.handle("change-view-size", (_event, id: string, size: any) =>
    webViewManager?.changeViewSize(id, size)
  );
  ipcMain.handle("get-active-webview", () =>
    webViewManager?.getActiveWebview()
  );
  ipcMain.handle("capture-webview", (_event, id: string) =>
    webViewManager?.captureWebview(id)
  );
  ipcMain.handle("webview-destroy", (_event, id: string) =>
    webViewManager?.destroyWebview(id)
  );
  ipcMain.handle("set-size", (_event, size: any) =>
    webViewManager?.setSize(size)
  );
  ipcMain.handle("get-show-webview", () =>
    webViewManager?.getShowWebview()
  );
  ipcMain.handle("get-webview-state", (_event, id: string) =>
    webViewManager?.getWebviewState(id)
  );
  ipcMain.handle("navigate-webview", (_event, id: string, url: string) =>
    webViewManager?.navigateWebview(id, url)
  );
  ipcMain.handle("go-back-webview", (_event, id: string) =>
    webViewManager?.goBackWebview(id)
  );
  ipcMain.handle("go-forward-webview", (_event, id: string) =>
    webViewManager?.goForwardWebview(id)
  );
  ipcMain.handle("reload-webview", (_event, id: string) =>
    webViewManager?.reloadWebview(id)
  );
  ipcMain.handle("get-browser-debug-status", () =>
    webViewDebugBridge?.getStatus() ?? {
      bridgeEnabled: false,
      defaultTargetId: null,
      inspectBaseUrl: `http://127.0.0.1:${remoteDebuggingPort}`,
      inspectTargetsUrl: `http://127.0.0.1:${remoteDebuggingPort}/json`,
      remoteDebuggingPort,
      targetCount: 0,
      targets: [],
      transport: "electron-debugger",
    }
  );
  ipcMain.handle("open-browser-devtools", (_event, id?: string) =>
    webViewDebugBridge?.openDevTools(id)
  );

  // Profile IPC (Phase 2)
  ipcMain.handle("list-browser-profiles", () =>
    profileManager?.listProfiles()
  );
  ipcMain.handle("import-browser-profile", (_event, browserKey: string, profileDir: string) =>
    profileManager?.importProfile(browserKey, profileDir)
  );
  ipcMain.handle("switch-browser-profile", (_event, profileName: string) =>
    profileManager?.switchProfile(profileName)
  );

  // Skills IPC
  ipcMain.handle("get-skills-dir", () =>
    path.join(novaperDataDir, "plugins", "skills")
  );
  ipcMain.handle("skills-scan", async () => {
    const fs = await import("node:fs/promises");
    const skillsDir = path.join(novaperDataDir, "plugins", "skills");
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
          try {
            const content = await fs.readFile(skillMdPath, "utf-8");
            skills.push({ name: entry.name, content });
          } catch {
            // Skip dirs without SKILL.md
          }
        }
      }
      return skills;
    } catch {
      return [];
    }
  });
  ipcMain.handle("skill-write", async (_event, skillDirName: string, content: string) => {
    const fs = await import("node:fs/promises");
    const skillDir = path.join(novaperDataDir, "plugins", "skills", skillDirName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
    return { success: true };
  });
  ipcMain.handle("skill-delete", async (_event, skillDirName: string) => {
    const fs = await import("node:fs/promises");
    const skillDir = path.join(novaperDataDir, "plugins", "skills", skillDirName);
    await fs.rm(skillDir, { recursive: true, force: true });
    return { success: true };
  });

  // Recording
  ipcMain.handle("start-recording", (_event, webviewId: string) =>
    webViewManager?.startRecording(webviewId)
  );
  ipcMain.handle("stop-recording", (_event, webviewId: string) =>
    webViewManager?.stopRecording(webviewId)
  );
  ipcMain.handle("capture-action-screenshot", async (_event, webviewId: string, _actionSeq: number, _workflowUuid: string) =>
    webViewManager?.captureActionScreenshot(webviewId)
  );

  // System
  ipcMain.handle("restart-app", () => {
    app.relaunch();
    app.exit(0);
  });
}

// ==================== app lifecycle ====================
app.whenReady().then(async () => {
  log.info("[App] Novaper starting...");
  log.info(
    `[Browser] Remote debugging enabled at http://127.0.0.1:${remoteDebuggingPort}/json`
  );

  try {
    const prepared = await sessionDataBootstrapPromise;
    log.info(
      `[Browser] Embedded session data ready at ${prepared.sessionDataDir} using partition ${prepared.partitionName}.`
    );
    if (prepared.activeProfile) {
      log.info(
        `[Browser] Active embedded browser profile: ${prepared.activeProfile}.`
      );
    }
    if (
      prepared.cookies?.sourceHadCookies &&
      !prepared.cookies.partitionHasCookies
    ) {
      log.warn(
        "[Browser] Source browser has a Cookies database, but it could not be copied into the embedded Electron session. Close the source browser once and restart Novaper for a full login-state sync."
      );
    }
  } catch (error) {
    log.warn("[Browser] Failed to prepare embedded browser session data:", error);
  }

  setupUserAgentStripping();
  registerIpcHandlers();

  await createWindow();

  try {
    await bootBackend();
  } catch (err) {
    log.error("[App] Backend boot failed, continuing with UI only:", err);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  webViewManager?.destroy();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  log.info("[App] Shutting down...");
});

// Handle protocol URLs on macOS
app.on("open-url", (_event, url) => {
  handleProtocolUrl(url);
});

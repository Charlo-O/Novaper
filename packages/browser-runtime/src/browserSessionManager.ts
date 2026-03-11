import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type ElementHandle, type Page } from "playwright-core";
import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
  isActive: boolean;
}

export interface BrowserSnapshotElement {
  selector: string;
  tag: string;
  role: string | null;
  text: string;
  ariaLabel: string | null;
  name: string | null;
  placeholder: string | null;
  type: string | null;
  href: string | null;
  disabled: boolean;
  valuePreview?: string;
}

interface BrowserResultMeta {
  strategy: "playwright" | "visual";
  browser: "chrome" | "edge" | "brave";
  browserLabel: string;
  profileMode: "persistent_copy";
}

export interface BrowserSnapshotResult extends BrowserResultMeta {
  title: string;
  url: string;
  readyState: string;
  viewport: {
    width: number;
    height: number;
  };
  tabs: BrowserTabInfo[];
  elements: BrowserSnapshotElement[];
  textPreview?: string;
  requiresDesktopActions?: boolean;
  fallbackReason?: string;
  note?: string;
}

interface BrowserSnapshotDomResult {
  title: string;
  url: string;
  readyState: string;
  viewport: {
    width: number;
    height: number;
  };
  elements: BrowserSnapshotElement[];
  textPreview?: string;
}

interface BrowserInstall {
  key: "chrome" | "edge" | "brave";
  label: string;
  processName: string;
  executablePath: string;
  userDataRoot?: string;
}

interface BrowserProfileState {
  browserKey: BrowserInstall["key"];
  profileDirectory: string;
  seedUserDataDir: string;
  runtimeUserDataDir: string;
  seededFromLocal: boolean;
  sourceUserDataRoot?: string;
}

interface PersistedProfileMetadata {
  version: number;
  browserKey: BrowserInstall["key"];
  profileDirectory: string;
  seededFromLocal: boolean;
  sourceUserDataRoot?: string;
  seededAt: string;
  lastSyncedAt?: string;
}

interface PlaywrightSessionState {
  strategy: "playwright";
  browser: BrowserInstall;
  profile: BrowserProfileState;
  context: BrowserContext;
  activePage: Page;
}

interface VisualSessionState {
  strategy: "visual";
  browser: BrowserInstall;
  profile: BrowserProfileState;
  fallbackReason: string;
  processId?: number;
}

type BrowserSessionState = PlaywrightSessionState | VisualSessionState;

const PROFILE_METADATA_FILE = ".novaper-profile.json";
const COPY_SKIP_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Crashpad",
  "DawnCache",
  "Component CRX Cache",
  "BrowserMetrics",
  "Service Worker",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

function sanitizeSessionId(sessionId: string) {
  return sessionId.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 48) || "session";
}

function nowIso() {
  return new Date().toISOString();
}

function trimText(value: string | null | undefined, maxLength = 160) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

async function pathExists(filePath: string) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function findWindowsBrowserInstall(): BrowserInstall | null {
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

  const installs: BrowserInstall[] = [
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "chrome",
      executablePath: path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      userDataRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "chrome",
      executablePath: path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      userDataRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "chrome",
      executablePath: path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      userDataRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      key: "edge",
      label: "Microsoft Edge",
      processName: "msedge",
      executablePath: path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      userDataRoot: path.join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      key: "edge",
      label: "Microsoft Edge",
      processName: "msedge",
      executablePath: path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      userDataRoot: path.join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      key: "brave",
      label: "Brave",
      processName: "brave",
      executablePath: path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      userDataRoot: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    },
    {
      key: "brave",
      label: "Brave",
      processName: "brave",
      executablePath: path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      userDataRoot: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    },
  ];

  for (const install of installs) {
    if (fs.existsSync(install.executablePath)) {
      return install;
    }
  }

  for (const fallback of [
    { key: "chrome" as const, label: "Google Chrome", processName: "chrome", executable: "chrome.exe" },
    { key: "edge" as const, label: "Microsoft Edge", processName: "msedge", executable: "msedge.exe" },
    { key: "brave" as const, label: "Brave", processName: "brave", executable: "brave.exe" },
  ]) {
    try {
      const result = execFileSync("where", [fallback.executable], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && fs.existsSync(line));
      if (match) {
        return {
          key: fallback.key,
          label: fallback.label,
          processName: fallback.processName,
          executablePath: match,
          userDataRoot:
            fallback.key === "chrome"
              ? path.join(localAppData, "Google", "Chrome", "User Data")
              : fallback.key === "edge"
                ? path.join(localAppData, "Microsoft", "Edge", "User Data")
                : path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
        };
      }
    } catch {
      // Try the next browser.
    }
  }

  return null;
}

function findPosixBrowserInstall(): BrowserInstall | null {
  const homeDir = os.homedir();
  const installs: BrowserInstall[] = [
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "google-chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      userDataRoot: path.join(homeDir, "Library", "Application Support", "Google", "Chrome"),
    },
    {
      key: "edge",
      label: "Microsoft Edge",
      processName: "Microsoft Edge",
      executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      userDataRoot: path.join(homeDir, "Library", "Application Support", "Microsoft Edge"),
    },
    {
      key: "brave",
      label: "Brave",
      processName: "Brave Browser",
      executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      userDataRoot: path.join(homeDir, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    },
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "google-chrome",
      executablePath: "/usr/bin/google-chrome",
      userDataRoot: path.join(homeDir, ".config", "google-chrome"),
    },
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "google-chrome",
      executablePath: "/usr/bin/google-chrome-stable",
      userDataRoot: path.join(homeDir, ".config", "google-chrome"),
    },
    {
      key: "edge",
      label: "Microsoft Edge",
      processName: "microsoft-edge",
      executablePath: "/usr/bin/microsoft-edge",
      userDataRoot: path.join(homeDir, ".config", "microsoft-edge"),
    },
    {
      key: "brave",
      label: "Brave",
      processName: "brave-browser",
      executablePath: "/usr/bin/brave-browser",
      userDataRoot: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
    },
  ];

  for (const install of installs) {
    if (fs.existsSync(install.executablePath)) {
      return install;
    }
  }

  return null;
}

function findInstalledBrowser() {
  return process.platform === "win32" ? findWindowsBrowserInstall() : findPosixBrowserInstall();
}

function normalizeBrowserKey(key: string): string {
  const upper = key.trim().toUpperCase();
  switch (upper) {
    case "CTRL":
      return "Control";
    case "CMD":
    case "COMMAND":
    case "META":
    case "WIN":
    case "WINDOWS":
      return "Meta";
    case "ALT":
      return "Alt";
    case "SHIFT":
      return "Shift";
    case "ESC":
      return "Escape";
    case "RETURN":
      return "Enter";
    case "SPACE":
      return " ";
    case "PAGEUP":
      return "PageUp";
    case "PAGEDOWN":
      return "PageDown";
    case "UP":
      return "ArrowUp";
    case "DOWN":
      return "ArrowDown";
    case "LEFT":
      return "ArrowLeft";
    case "RIGHT":
      return "ArrowRight";
    default:
      return key.length === 1 ? key : key[0].toUpperCase() + key.slice(1);
  }
}

async function ensureDirectory(dirPath: string) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function copyFileBestEffort(sourcePath: string, destinationPath: string) {
  try {
    await ensureDirectory(path.dirname(destinationPath));
    await fsp.copyFile(sourcePath, destinationPath);
  } catch {
    // Ignore locked files from the user's active browser.
  }
}

async function copyDirectoryBestEffort(sourceDir: string, destinationDir: string) {
  try {
    await ensureDirectory(destinationDir);
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (COPY_SKIP_NAMES.has(entry.name)) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationDir, entry.name);

      if (entry.isDirectory()) {
        await copyDirectoryBestEffort(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        await copyFileBestEffort(sourcePath, destinationPath);
      }
    }
  } catch {
    // Best effort seed copy.
  }
}

async function removeDirectoryContents(targetDir: string) {
  await fsp.rm(targetDir, { recursive: true, force: true });
  await ensureDirectory(targetDir);
}

function readProfileMetadata(seedUserDataDir: string) {
  return readJsonFile<PersistedProfileMetadata>(path.join(seedUserDataDir, PROFILE_METADATA_FILE));
}

function detectPreferredProfileDirectory(userDataRoot?: string) {
  if (!userDataRoot) {
    return "Default";
  }

  const localStatePath = path.join(userDataRoot, "Local State");
  const localState = readJsonFile<Record<string, unknown>>(localStatePath);
  const profileRecord = typeof localState?.profile === "object" && localState.profile ? (localState.profile as Record<string, unknown>) : undefined;
  const lastUsed = typeof profileRecord?.last_used === "string" ? profileRecord.last_used.trim() : "";
  if (lastUsed) {
    return lastUsed;
  }

  const infoCache = typeof profileRecord?.info_cache === "object" && profileRecord.info_cache ? Object.keys(profileRecord.info_cache as Record<string, unknown>) : [];
  if (infoCache.length > 0) {
    return infoCache[0];
  }

  return "Default";
}

async function writeProfileMetadata(profile: BrowserProfileState, synced = false) {
  const metadata: PersistedProfileMetadata = {
    version: 1,
    browserKey: profile.browserKey,
    profileDirectory: profile.profileDirectory,
    seededFromLocal: profile.seededFromLocal,
    sourceUserDataRoot: profile.sourceUserDataRoot,
    seededAt: nowIso(),
    lastSyncedAt: synced ? nowIso() : undefined,
  };
  await ensureDirectory(profile.seedUserDataDir);
  await fsp.writeFile(path.join(profile.seedUserDataDir, PROFILE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function safePageTitle(page: Page) {
  try {
    return trimText(await page.title(), 120) || "Untitled";
  } catch {
    return "Untitled";
  }
}

async function settlePage(page: Page) {
  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: 5000 }),
    page.waitForLoadState("networkidle", { timeout: 5000 }),
  ]);
}

function buildFallbackNote(reason: string) {
  return `Playwright browser automation switched to visual fallback: ${reason}. Continue with desktop_actions against the attached desktop screenshot.`;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly profileRootDir: string;

  constructor(
    private readonly options: {
      rootDir: string;
      sidecar: DesktopSidecar;
    },
  ) {
    this.profileRootDir = path.join(options.rootDir, "data", "browser-profiles");
  }

  private buildResultMeta(state: BrowserSessionState): BrowserResultMeta {
    return {
      strategy: state.strategy,
      browser: state.browser.key,
      browserLabel: state.browser.label,
      profileMode: "persistent_copy",
    };
  }

  private async ensureSeedProfile(browser: BrowserInstall): Promise<Omit<BrowserProfileState, "runtimeUserDataDir">> {
    const seedUserDataDir = path.join(this.profileRootDir, "seeds", browser.key);
    const existingMetadata = readProfileMetadata(seedUserDataDir);
    if (existingMetadata) {
      return {
        browserKey: existingMetadata.browserKey,
        profileDirectory: existingMetadata.profileDirectory,
        seedUserDataDir,
        seededFromLocal: existingMetadata.seededFromLocal,
        sourceUserDataRoot: existingMetadata.sourceUserDataRoot,
      };
    }

    await removeDirectoryContents(seedUserDataDir);
    const profileDirectory = detectPreferredProfileDirectory(browser.userDataRoot);
    const sourceUserDataRoot = browser.userDataRoot;
    const localStatePath = sourceUserDataRoot ? path.join(sourceUserDataRoot, "Local State") : undefined;

    if (localStatePath && fs.existsSync(localStatePath)) {
      await copyFileBestEffort(localStatePath, path.join(seedUserDataDir, "Local State"));
    }

    if (sourceUserDataRoot) {
      const sourceProfileDir = path.join(sourceUserDataRoot, profileDirectory);
      if (fs.existsSync(sourceProfileDir)) {
        await copyDirectoryBestEffort(sourceProfileDir, path.join(seedUserDataDir, profileDirectory));
      }
    }

    await ensureDirectory(path.join(seedUserDataDir, profileDirectory));

    const profileState: Omit<BrowserProfileState, "runtimeUserDataDir"> = {
      browserKey: browser.key,
      profileDirectory,
      seedUserDataDir,
      seededFromLocal: Boolean(sourceUserDataRoot && fs.existsSync(path.join(seedUserDataDir, profileDirectory))),
      sourceUserDataRoot,
    };
    await writeProfileMetadata({ ...profileState, runtimeUserDataDir: "" });
    return profileState;
  }

  private async prepareProfile(browser: BrowserInstall, sessionId: string): Promise<BrowserProfileState> {
    const seedProfile = await this.ensureSeedProfile(browser);
    const runtimeUserDataDir = path.join(this.profileRootDir, "runtime", browser.key, sanitizeSessionId(sessionId));
    await removeDirectoryContents(runtimeUserDataDir);
    await copyDirectoryBestEffort(seedProfile.seedUserDataDir, runtimeUserDataDir);
    await ensureDirectory(path.join(runtimeUserDataDir, seedProfile.profileDirectory));
    return {
      ...seedProfile,
      runtimeUserDataDir,
    };
  }

  private async syncRuntimeProfile(profile: BrowserProfileState) {
    if (!(await pathExists(profile.runtimeUserDataDir))) {
      return;
    }

    await removeDirectoryContents(profile.seedUserDataDir);
    await copyDirectoryBestEffort(profile.runtimeUserDataDir, profile.seedUserDataDir);
    await writeProfileMetadata(profile, true);
  }

  private async cleanupRuntimeProfile(profile: BrowserProfileState) {
    await fsp.rm(profile.runtimeUserDataDir, { recursive: true, force: true });
  }

  private async focusVisualWindow(state: VisualSessionState) {
    const windows = await this.options.sidecar.listWindows();
    const match =
      windows.find((window) => window.processName.toLowerCase() === state.browser.processName.toLowerCase()) ??
      windows.find((window) => window.title.includes(state.browser.label));
    if (match) {
      await this.options.sidecar.focusWindow({ handle: match.handle });
    }
    return match;
  }

  private async ensureVisualBrowser(state: VisualSessionState, url?: string) {
    const existing = await this.focusVisualWindow(state);
    if (existing) {
      if (url) {
        await this.performVisualNavigation(url);
      }
      return existing;
    }

    const launchArgs = [
      `--user-data-dir=${state.profile.runtimeUserDataDir}`,
      `--profile-directory=${state.profile.profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
      ...(url ? [url] : ["about:blank"]),
    ];
    const launched = await this.options.sidecar.launchProcess({
      command: state.browser.executablePath,
      args: launchArgs,
    });
    state.processId = launched.pid;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return this.focusVisualWindow(state);
  }

  private async performVisualNavigation(url: string) {
    await this.options.sidecar.execActions({
      actions: [
        { type: "keypress", keys: ["CTRL", "L"] },
        { type: "wait", duration_ms: 120 },
        { type: "type", text: url },
        { type: "keypress", keys: ["ENTER"] },
        { type: "wait", duration_ms: 1200 },
      ],
    });
  }

  private buildVisualFallbackResult<T extends Record<string, unknown>>(state: VisualSessionState, overrides: T) {
    return {
      ...this.buildResultMeta(state),
      requiresDesktopActions: true,
      fallbackReason: state.fallbackReason,
      note: buildFallbackNote(state.fallbackReason),
      ...overrides,
    };
  }

  private async launchPlaywrightSession(sessionId: string): Promise<BrowserSessionState> {
    const browser = findInstalledBrowser();
    if (!browser) {
      throw new Error("No supported Chromium browser found. Install Google Chrome, Microsoft Edge, or Brave.");
    }

    const profile = await this.prepareProfile(browser, sessionId);

    try {
      const context = await chromium.launchPersistentContext(profile.runtimeUserDataDir, {
        executablePath: browser.executablePath,
        headless: false,
        viewport: null,
        ignoreHTTPSErrors: true,
        args: [
          `--profile-directory=${profile.profileDirectory}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });

      let activePage = context
        .pages()
        .find((page) => !page.isClosed() && !page.url().startsWith("devtools://"));
      if (!activePage) {
        activePage = await context.newPage();
      }
      await activePage.bringToFront();
      await settlePage(activePage);

      const state: PlaywrightSessionState = {
        strategy: "playwright",
        browser,
        profile,
        context,
        activePage,
      };

      context.on("close", async () => {
        const current = this.sessions.get(sessionId);
        if (current && current.strategy === "playwright" && current.context === context) {
          this.sessions.delete(sessionId);
          await this.syncRuntimeProfile(profile).catch(() => undefined);
          await this.cleanupRuntimeProfile(profile).catch(() => undefined);
        }
      });

      this.sessions.set(sessionId, state);
      return state;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Failed to launch Playwright browser session.";
      return this.activateVisualFallback(sessionId, browser, profile, reason, undefined);
    }
  }

  private async activateVisualFallback(
    sessionId: string,
    browser: BrowserInstall,
    profile: BrowserProfileState,
    fallbackReason: string,
    url?: string,
  ): Promise<VisualSessionState> {
    const state: VisualSessionState = {
      strategy: "visual",
      browser,
      profile,
      fallbackReason,
    };
    this.sessions.set(sessionId, state);
    await this.ensureVisualBrowser(state, url).catch(() => undefined);
    return state;
  }

  private async getSession(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.strategy === "playwright") {
        if (!existing.activePage.isClosed()) {
          return existing;
        }
      } else {
        return existing;
      }
    }

    if (existing) {
      this.sessions.delete(sessionId);
      await this.syncRuntimeProfile(existing.profile).catch(() => undefined);
      await this.cleanupRuntimeProfile(existing.profile).catch(() => undefined);
    }

    return this.launchPlaywrightSession(sessionId);
  }

  private async listPages(state: PlaywrightSessionState) {
    return state.context.pages().filter((page) => !page.isClosed() && !page.url().startsWith("devtools://"));
  }

  private async ensurePage(state: PlaywrightSessionState) {
    const pages = await this.listPages(state);
    if (pages.length === 0) {
      const page = await state.context.newPage();
      state.activePage = page;
      return page;
    }

    if (!state.activePage.isClosed() && pages.includes(state.activePage)) {
      return state.activePage;
    }

    state.activePage = pages[0];
    return state.activePage;
  }

  private async getTabs(state: PlaywrightSessionState) {
    const pages = await this.listPages(state);
    return Promise.all(
      pages.map(async (page, index) => ({
        index,
        title: await safePageTitle(page),
        url: page.url(),
        isActive: page === state.activePage,
      })),
    );
  }

  private async getVisualPseudoTabs(state: VisualSessionState) {
    const window = await this.focusVisualWindow(state);
    return [
      {
        index: 0,
        title: trimText(window?.title, 120) || state.browser.label,
        url: "visual-fallback://desktop-browser",
        isActive: true,
      },
    ];
  }

  private async withPlaywrightFallback<T>(
    sessionId: string,
    state: PlaywrightSessionState,
    action: (page: Page, state: PlaywrightSessionState) => Promise<T>,
  ): Promise<T | VisualSessionState> {
    try {
      const page = await this.ensurePage(state);
      return await action(page, state);
    } catch (error) {
      const visualState = await this.activateVisualFallback(
        sessionId,
        state.browser,
        state.profile,
        error instanceof Error ? error.message : "Playwright browser automation failed.",
      );
      try {
        await state.context.close();
      } catch {
        // Best effort shutdown.
      }
      return visualState;
    }
  }

  async open(sessionId: string, args: { url?: string; newTab?: boolean } = {}) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state, args.url);
      return this.buildVisualFallbackResult(state, {
        opened: true,
        title: state.browser.label,
        url: args.url ?? "visual-fallback://desktop-browser",
        tabs: await this.getVisualPseudoTabs(state),
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (_page, currentState) => {
      const targetPage = args.newTab ? await currentState.context.newPage() : await this.ensurePage(currentState);
      currentState.activePage = targetPage;
      await targetPage.bringToFront();

      if (args.url) {
        await targetPage.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await settlePage(targetPage);
      }

      return {
        ...this.buildResultMeta(currentState),
        opened: true,
        title: await safePageTitle(targetPage),
        url: targetPage.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        opened: true,
        title: result.browser.label,
        url: args.url ?? "visual-fallback://desktop-browser",
        tabs: await this.getVisualPseudoTabs(result),
      });
    }

    return result;
  }

  async navigate(sessionId: string, args: { url: string }) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state);
      await this.performVisualNavigation(args.url);
      return this.buildVisualFallbackResult(state, {
        navigated: true,
        title: state.browser.label,
        url: args.url,
        tabs: await this.getVisualPseudoTabs(state),
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settlePage(page);
      return {
        ...this.buildResultMeta(currentState),
        navigated: true,
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      await this.performVisualNavigation(args.url);
      return this.buildVisualFallbackResult(result, {
        navigated: true,
        title: result.browser.label,
        url: args.url,
        tabs: await this.getVisualPseudoTabs(result),
      });
    }

    return result;
  }

  async tabs(sessionId: string, args: { action: "list" | "switch" | "new" | "close"; index?: number; url?: string }) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      if (args.action === "new" && args.url) {
        await this.ensureVisualBrowser(state, args.url);
      }
      return this.buildVisualFallbackResult(state, {
        tabs: await this.getVisualPseudoTabs(state),
        browserClosed: false,
        switched: false,
        closed: false,
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (_page, currentState) => {
      const pages = await this.listPages(currentState);

      switch (args.action) {
        case "list":
          return {
            ...this.buildResultMeta(currentState),
            tabs: await this.getTabs(currentState),
          };
        case "new": {
          const page = await currentState.context.newPage();
          currentState.activePage = page;
          await page.bringToFront();
          if (args.url) {
            await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await settlePage(page);
          }
          return {
            ...this.buildResultMeta(currentState),
            opened: true,
            index: (await this.listPages(currentState)).findIndex((entry) => entry === page),
            url: page.url(),
            tabs: await this.getTabs(currentState),
          };
        }
        case "switch": {
          if (typeof args.index !== "number" || args.index < 0 || args.index >= pages.length) {
            throw new Error("browser_tabs switch requires a valid tab index.");
          }
          currentState.activePage = pages[args.index];
          await currentState.activePage.bringToFront();
          return {
            ...this.buildResultMeta(currentState),
            switched: true,
            index: args.index,
            title: await safePageTitle(currentState.activePage),
            url: currentState.activePage.url(),
            tabs: await this.getTabs(currentState),
          };
        }
        case "close": {
          const targetIndex = typeof args.index === "number" ? args.index : pages.findIndex((page) => page === currentState.activePage);
          if (targetIndex < 0 || targetIndex >= pages.length) {
            throw new Error("browser_tabs close requires a valid tab index.");
          }

          await pages[targetIndex].close({ runBeforeUnload: true });
          const remaining = await this.listPages(currentState);
          if (remaining.length === 0) {
            await currentState.context.close().catch(() => undefined);
            this.sessions.delete(sessionId);
            await this.syncRuntimeProfile(currentState.profile).catch(() => undefined);
            await this.cleanupRuntimeProfile(currentState.profile).catch(() => undefined);
            return {
              ...this.buildResultMeta(currentState),
              closed: true,
              browserClosed: true,
              tabs: [],
            };
          }

          currentState.activePage = remaining[Math.max(0, Math.min(targetIndex, remaining.length - 1))];
          await currentState.activePage.bringToFront();
          return {
            ...this.buildResultMeta(currentState),
            closed: true,
            browserClosed: false,
            tabs: await this.getTabs(currentState),
          };
        }
        default:
          throw new Error(`Unsupported browser tab action: ${String(args.action)}`);
      }
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        tabs: await this.getVisualPseudoTabs(result),
      });
    }

    return result;
  }

  async snapshot(sessionId: string, args: { maxElements?: number; includeText?: boolean; textLimit?: number } = {}): Promise<BrowserSnapshotResult> {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      return this.buildVisualFallbackResult(state, {
        title: state.browser.label,
        url: "visual-fallback://desktop-browser",
        readyState: "visual_fallback",
        viewport: { width: 0, height: 0 },
        tabs: await this.getVisualPseudoTabs(state),
        elements: [],
        textPreview: "Playwright is unavailable for this session. Use the desktop screenshot and desktop_actions for browser interaction.",
      }) as BrowserSnapshotResult;
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      const maxElements = Math.max(1, Math.min(100, Math.trunc(args.maxElements ?? 40)));
      const textLimit = Math.max(200, Math.min(5000, Math.trunc(args.textLimit ?? 1200)));

      const domResult = (await page.evaluate(
        ({ maxElements: limit, includeText, textLimit: maxTextLength }) => {
          const visible = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };

          const shorten = (value: string | null | undefined, maxLength = 160) => {
            const normalized = (value ?? "").replace(/\s+/g, " ").trim();
            return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
          };

          const escapeSelector = (value: string) => {
            if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
              return CSS.escape(value);
            }
            return value.replace(/([ !\"#$%&'()*+,./:;<=>?@[\\\\\\]^`{|}~])/g, "\\$1");
          };

          const buildSelector = (element: Element): string => {
            if (element.id) {
              return `#${escapeSelector(element.id)}`;
            }

            const htmlElement = element as HTMLElement;
            for (const [attribute, value] of [
              ["data-testid", htmlElement.getAttribute("data-testid")],
              ["aria-label", htmlElement.getAttribute("aria-label")],
              ["name", htmlElement.getAttribute("name")],
              ["placeholder", htmlElement.getAttribute("placeholder")],
            ]) {
              if (!value) {
                continue;
              }

              const selector = `${element.tagName.toLowerCase()}[${attribute}="${escapeSelector(value)}"]`;
              if (document.querySelectorAll(selector).length === 1) {
                return selector;
              }
            }

            const segments: string[] = [];
            let current: Element | null = element;
            while (current && current !== document.body && segments.length < 6) {
              const parentElement: Element | null = current.parentElement;
              let segment = current.tagName.toLowerCase();
              if (parentElement) {
                const siblings = (Array.from(parentElement.children) as Element[]).filter((child: Element) => child.tagName === current?.tagName);
                if (siblings.length > 1) {
                  segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                }
              }
              segments.unshift(segment);
              const selector = segments.join(" > ");
              if (document.querySelectorAll(selector).length === 1) {
                return selector;
              }
              current = parentElement;
            }

            return segments.join(" > ") || element.tagName.toLowerCase();
          };

          const actionableSelector =
            "a, button, input, textarea, select, option, [role='button'], [role='link'], [role='tab'], [role='checkbox'], [contenteditable='true']";
          const candidates = Array.from(document.querySelectorAll(actionableSelector)).filter(visible).slice(0, limit);
          const elements = candidates.map((element) => {
            const htmlElement = element as HTMLElement & {
              href?: string;
              disabled?: boolean;
              value?: string;
              type?: string;
              name?: string;
              placeholder?: string;
            };

            const type = typeof htmlElement.type === "string" ? htmlElement.type : null;
            const valuePreview =
              type && type.toLowerCase() === "password"
                ? undefined
                : shorten(typeof htmlElement.value === "string" ? htmlElement.value : undefined, 80);

            return {
              selector: buildSelector(element),
              tag: element.tagName.toLowerCase(),
              role: htmlElement.getAttribute("role"),
              text: shorten(htmlElement.innerText || element.textContent || htmlElement.getAttribute("aria-label") || "", 160),
              ariaLabel: htmlElement.getAttribute("aria-label"),
              name: typeof htmlElement.name === "string" && htmlElement.name.length > 0 ? htmlElement.name : null,
              placeholder: typeof htmlElement.placeholder === "string" && htmlElement.placeholder.length > 0 ? htmlElement.placeholder : null,
              type,
              href: typeof htmlElement.href === "string" ? htmlElement.href : null,
              disabled: Boolean(htmlElement.disabled),
              valuePreview: valuePreview && valuePreview.length > 0 ? valuePreview : undefined,
            };
          });

          return {
            title: document.title || "Untitled",
            url: location.href,
            readyState: document.readyState,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
            elements,
            textPreview: includeText ? shorten(document.body?.innerText || "", maxTextLength) : undefined,
          };
        },
        {
          maxElements,
          includeText: args.includeText !== false,
          textLimit,
        },
      )) as BrowserSnapshotDomResult;

      return {
        ...this.buildResultMeta(currentState),
        ...domResult,
        title: trimText(domResult.title, 120) || "Untitled",
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        title: result.browser.label,
        url: "visual-fallback://desktop-browser",
        readyState: "visual_fallback",
        viewport: { width: 0, height: 0 },
        tabs: await this.getVisualPseudoTabs(result),
        elements: [],
        textPreview: "Playwright failed during snapshot. Continue with desktop_actions and the latest desktop screenshot.",
      }) as BrowserSnapshotResult;
    }

    return result;
  }

  async click(
    sessionId: string,
    args: {
      selector?: string;
      text?: string;
      index?: number;
      button?: "left" | "right";
      x?: number;
      y?: number;
    },
  ) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      return this.buildVisualFallbackResult(state, {
        clicked: false,
        note: `${buildFallbackNote(state.fallbackReason)} browser_click is no longer using DOM selectors in this session.`,
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      const button = args.button === "right" ? "right" : "left";

      if (typeof args.x === "number" && typeof args.y === "number") {
        await page.mouse.click(args.x, args.y, { button });
      } else if (args.selector) {
        const locator = page.locator(args.selector).first();
        await locator.waitFor({ state: "visible", timeout: 15000 });
        await locator.scrollIntoViewIfNeeded();
        await locator.click({ button, timeout: 15000 });
      } else if (args.text) {
        const handle = await page.evaluateHandle(
          ({ text, index }) => {
            const visible = (element: Element) => {
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            };

            const selector =
              "a, button, input, textarea, select, option, [role='button'], [role='link'], [role='tab'], [contenteditable='true']";
            const matches = Array.from(document.querySelectorAll(selector)).filter((element) => {
              if (!visible(element)) {
                return false;
              }

              const content = `${(element as HTMLElement).innerText || element.textContent || ""} ${(element as HTMLElement).getAttribute("aria-label") || ""}`
                .replace(/\s+/g, " ")
                .trim();
              return content.includes(text);
            });

            return matches[index ?? 0] ?? null;
          },
          { text: args.text, index: args.index ?? 0 },
        );

        const element = handle.asElement() as ElementHandle<Element> | null;
        if (!element) {
          await handle.dispose();
          throw new Error(`Could not find browser element containing text: ${args.text}`);
        }

        await element.scrollIntoViewIfNeeded();
        await element.click({ button, timeout: 15000 });
        await handle.dispose();
      } else {
        throw new Error("browser_click requires selector, text, or x/y coordinates.");
      }

      await settlePage(page);
      return {
        ...this.buildResultMeta(currentState),
        clicked: true,
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        clicked: false,
      });
    }

    return result;
  }

  async type(sessionId: string, args: { selector?: string; text: string; clear?: boolean; submit?: boolean }) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state);
      if (args.selector) {
        return this.buildVisualFallbackResult(state, {
          typed: false,
          submitted: false,
          note: `${buildFallbackNote(state.fallbackReason)} browser_type with selector is unavailable in visual mode.`,
        });
      }

      const actions: Array<
        | { type: "keypress"; keys: string[] }
        | { type: "type"; text: string }
      > = [];
      if (args.clear) {
        actions.push({ type: "keypress", keys: ["CTRL", "A"] });
        actions.push({ type: "keypress", keys: ["BACKSPACE"] });
      }
      if (args.text) {
        actions.push({ type: "type", text: args.text });
      }
      if (args.submit) {
        actions.push({ type: "keypress", keys: ["ENTER"] });
      }
      if (actions.length > 0) {
        await this.options.sidecar.execActions({ actions });
      }

      return this.buildVisualFallbackResult(state, {
        typed: true,
        submitted: Boolean(args.submit),
        title: state.browser.label,
        url: "visual-fallback://desktop-browser",
        tabs: await this.getVisualPseudoTabs(state),
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      if (args.selector) {
        const locator = page.locator(args.selector).first();
        await locator.waitFor({ state: "visible", timeout: 15000 });
        await locator.scrollIntoViewIfNeeded();
        await locator.click({ clickCount: args.clear ? 3 : 1, timeout: 15000 });
      }

      if (args.clear) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }

      await page.keyboard.type(args.text, { delay: 20 });
      if (args.submit) {
        await page.keyboard.press("Enter");
      }

      await settlePage(page);
      return {
        ...this.buildResultMeta(currentState),
        typed: true,
        submitted: Boolean(args.submit),
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        typed: false,
        submitted: false,
      });
    }

    return result;
  }

  async pressKeys(sessionId: string, args: { keys: string[] }) {
    const state = await this.getSession(sessionId);
    if (!Array.isArray(args.keys) || args.keys.length === 0) {
      throw new Error("browser_press_keys requires at least one key.");
    }

    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state);
      await this.options.sidecar.execActions({
        actions: [{ type: "keypress", keys: args.keys.map((key) => key.toUpperCase()) }],
      });
      return this.buildVisualFallbackResult(state, {
        pressed: true,
        keys: args.keys,
        title: state.browser.label,
        url: "visual-fallback://desktop-browser",
        tabs: await this.getVisualPseudoTabs(state),
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      const keys = args.keys.map((key) => normalizeBrowserKey(String(key)));
      if (keys.length === 1) {
        await page.keyboard.press(keys[0]);
      } else {
        const modifiers = keys.slice(0, -1);
        const mainKey = keys[keys.length - 1];
        for (const key of modifiers) {
          await page.keyboard.down(key);
        }
        await page.keyboard.press(mainKey);
        for (const key of [...modifiers].reverse()) {
          await page.keyboard.up(key);
        }
      }

      await settlePage(page);
      return {
        ...this.buildResultMeta(currentState),
        pressed: true,
        keys,
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        pressed: false,
      });
    }

    return result;
  }

  async waitFor(sessionId: string, args: { selector?: string; text?: string; timeoutMs?: number }) {
    const state = await this.getSession(sessionId);
    const timeoutMs = Math.max(100, Math.min(30000, Math.trunc(args.timeoutMs ?? 5000)));

    if (state.strategy === "visual") {
      if (!args.selector && !args.text) {
        await this.options.sidecar.execActions({ actions: [{ type: "wait", duration_ms: timeoutMs }] });
      }
      return this.buildVisualFallbackResult(state, {
        matched: args.selector ? "selector" : args.text ? "text" : "timeout",
        timeoutMs,
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      if (args.selector) {
        await page.locator(args.selector).first().waitFor({ state: "visible", timeout: timeoutMs });
        return {
          ...this.buildResultMeta(currentState),
          matched: "selector",
          selector: args.selector,
          timeoutMs,
          title: await safePageTitle(page),
          url: page.url(),
          tabs: await this.getTabs(currentState),
        };
      }

      if (args.text) {
        await page.waitForFunction(
          (text) => Boolean(document.body && document.body.innerText.includes(text)),
          args.text,
          { timeout: timeoutMs },
        );
        return {
          ...this.buildResultMeta(currentState),
          matched: "text",
          text: args.text,
          timeoutMs,
          title: await safePageTitle(page),
          url: page.url(),
          tabs: await this.getTabs(currentState),
        };
      }

      await page.waitForTimeout(timeoutMs);
      return {
        ...this.buildResultMeta(currentState),
        matched: "timeout",
        timeoutMs,
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        matched: args.selector ? "selector" : args.text ? "text" : "timeout",
        timeoutMs,
      });
    }

    return result;
  }

  async scroll(sessionId: string, args: { x?: number; y?: number }) {
    const state = await this.getSession(sessionId);
    const x = typeof args.x === "number" ? args.x : 0;
    const y = typeof args.y === "number" ? args.y : 600;

    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state);
      await this.options.sidecar.execActions({
        actions: [{ type: "scroll", scroll_x: x, scroll_y: y }],
      });
      return this.buildVisualFallbackResult(state, {
        scrolled: true,
        scroll: { x: 0, y: 0 },
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      await page.evaluate(
        ({ scrollX, scrollY }) => {
          window.scrollBy(scrollX, scrollY);
        },
        { scrollX: x, scrollY: y },
      );

      const currentScroll = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));

      return {
        ...this.buildResultMeta(currentState),
        scrolled: true,
        scroll: currentScroll,
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        scrolled: false,
      });
    }

    return result;
  }

  async read(sessionId: string, args: { selector?: string; maxLength?: number } = {}) {
    const state = await this.getSession(sessionId);
    const maxLength = Math.max(200, Math.min(12000, Math.trunc(args.maxLength ?? 4000)));

    if (state.strategy === "visual") {
      return this.buildVisualFallbackResult(state, {
        text: "",
        title: state.browser.label,
        url: "visual-fallback://desktop-browser",
        tabs: await this.getVisualPseudoTabs(state),
      });
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      let text: string;
      if (args.selector) {
        const locator = page.locator(args.selector).first();
        await locator.waitFor({ state: "visible", timeout: 15000 });
        text = (await locator.innerText().catch(async () => locator.textContent())) ?? "";
      } else {
        text = await page.evaluate(() => document.body?.innerText || "");
      }

      const normalized = text.replace(/\s+/g, " ").trim();
      return {
        ...this.buildResultMeta(currentState),
        text: normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized,
        title: await safePageTitle(page),
        url: page.url(),
        tabs: await this.getTabs(currentState),
      };
    });

    if ("profile" in result) {
      return this.buildVisualFallbackResult(result, {
        text: "",
      });
    }

    return result;
  }

  async disposeSession(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    this.sessions.delete(sessionId);

    try {
      if (state.strategy === "playwright") {
        await state.context.close();
      } else if (state.processId) {
        await this.options.sidecar.killProcess({ pid: state.processId }).catch(() => undefined);
      }
    } catch {
      // Best effort shutdown.
    } finally {
      await this.syncRuntimeProfile(state.profile).catch(() => undefined);
      await this.cleanupRuntimeProfile(state.profile).catch(() => undefined);
    }
  }

  async disposeAll() {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)));
  }
}

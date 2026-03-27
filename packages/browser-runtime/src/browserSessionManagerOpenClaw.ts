import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright-core";
import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import {
  clickChromeMcpElement,
  closeChromeMcpPage,
  closeChromeMcpSession,
  ensureChromeMcpAvailable,
  evaluateChromeMcpScript,
  listChromeMcpPages,
  navigateChromeMcpPage,
  newChromeMcpPage,
  pressChromeMcpKey,
  selectChromeMcpPage,
  takeChromeMcpSnapshot,
  waitForChromeMcpText,
  type ChromeMcpSnapshotNode,
} from "./chromeMcpClient.js";

type ChromeMcpPageInfo = Awaited<ReturnType<typeof listChromeMcpPages>>[number];

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
  strategy: "playwright" | "cdp" | "chrome-mcp" | "visual";
  browser: "chrome" | "edge" | "brave";
  browserLabel: string;
  profileMode: "local_managed" | "external_cdp" | "existing_session";
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

type RuntimeBrowserProfileMode = "local-managed" | "local-existing-session" | "remote-cdp";
type RuntimeBrowserDriver = "novaper" | "existing-session";

interface ResolvedRuntimeBrowserProfile {
  name: string;
  mode: RuntimeBrowserProfileMode;
  driver: RuntimeBrowserDriver;
  transport: "cdp" | "chrome-mcp";
  attachOnly: boolean;
  browser: BrowserInstall;
  cdpUrl?: string;
  source?: ExternalCdpEndpoint["source"];
  port?: number;
  userDataDir?: string;
  profileDirectory?: string;
  sourceUserDataRoot?: string;
}

interface PlaywrightSessionState {
  strategy: "playwright" | "cdp";
  browser: BrowserInstall;
  profileMode: BrowserResultMeta["profileMode"];
  sessionProfile: ResolvedRuntimeBrowserProfile;
  profile?: BrowserProfileState;
  sourceUserDataRoot?: string;
  profileDirectory?: string;
  context: BrowserContext;
  activePage: Page;
  browserConnection?: Browser;
  endpointURL?: string;
  managedLaunch?: {
    port: number;
    processId: number;
  };
}

interface ChromeMcpSessionState {
  strategy: "chrome-mcp";
  browser: BrowserInstall;
  profileMode: BrowserResultMeta["profileMode"];
  sessionProfile: ResolvedRuntimeBrowserProfile;
  pageId: number;
  sourceUserDataRoot?: string;
  profileDirectory?: string;
}

interface VisualSessionState {
  strategy: "visual";
  browser: BrowserInstall;
  profileMode: BrowserResultMeta["profileMode"];
  sessionProfile: ResolvedRuntimeBrowserProfile;
  profile?: BrowserProfileState;
  sourceUserDataRoot?: string;
  profileDirectory?: string;
  fallbackReason: string;
  processId?: number;
}

type BrowserSessionState = PlaywrightSessionState | ChromeMcpSessionState | VisualSessionState;

interface ExternalCdpEndpoint {
  endpointURL: string;
  source: "env" | "devtools-active-port" | "port-scan" | "launched" | "chrome-mcp" | "managed";
  port?: number;
  wsPath?: string;
  profileDirectory?: string;
  sourceUserDataRoot?: string;
}

interface BrowserRuntimeProfileStatus {
  name: string;
  mode: RuntimeBrowserProfileMode;
  driver: RuntimeBrowserDriver;
  transport: "cdp" | "chrome-mcp";
  attachOnly: boolean;
  available: boolean;
  browser?: BrowserInstall["key"];
  browserLabel?: string;
  cdpUrl?: string;
  profileDirectory?: string;
  userDataDir?: string;
  source?: ExternalCdpEndpoint["source"];
  lastError?: string;
}

interface BrowserRuntimeStatus {
  preferredMode: "playwright" | "external_cdp";
  defaultProfile: string;
  activeTransport?: BrowserResultMeta["strategy"];
  profiles: BrowserRuntimeProfileStatus[];
  externalCdp: {
    preferred: boolean;
    available: boolean;
    attachedSessionCount: number;
    browser?: BrowserInstall["key"];
    endpointURL?: string;
    source?: ExternalCdpEndpoint["source"];
    port?: number;
    profileDirectory?: string;
    lastCheckedAt?: string;
    error?: string;
  };
}

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

async function canConnectToTcpPort(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), 1500);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

async function canBindTcpPort(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    const done = (result: boolean) => {
      server.removeAllListeners();
      resolve(result);
    };
    server.once("error", () => done(false));
    server.listen(port, host, () => {
      server.close(() => done(true));
    });
  });
}

function buildCdpHttpEndpoint(port: number) {
  return `http://127.0.0.1:${port}`;
}

function buildCdpWsEndpoint(port: number, wsPath?: string) {
  return wsPath ? `ws://127.0.0.1:${port}${wsPath}` : buildCdpHttpEndpoint(port);
}

async function fetchCdpVersion(endpointURL: string) {
  if (!/^https?:\/\//i.test(endpointURL)) {
    return undefined;
  }

  const versionUrl = new URL("/json/version", endpointURL).toString();
  try {
    const response = await fetch(versionUrl, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isProbablyExternalChromiumVersion(version: Record<string, unknown> | undefined) {
  const browserText = String(version?.Browser ?? "");
  const userAgent = String(version?.["User-Agent"] ?? "");
  return /Chrome|Edg|Brave/i.test(browserText) || /Chrome|Edg|Brave/i.test(userAgent);
}

function findWindowsBrowserInstall(): BrowserInstall | null {
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

  const candidates: BrowserInstall[] = [
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
      executablePath: path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      userDataRoot: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    },
  ];

  return candidates.find((candidate) => fs.existsSync(candidate.executablePath)) ?? null;
}

function findPosixBrowserInstall(): BrowserInstall | null {
  const home = os.homedir();
  const candidates: BrowserInstall[] = process.platform === "darwin"
    ? [
        {
          key: "chrome",
          label: "Google Chrome",
          processName: "Google Chrome",
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          userDataRoot: path.join(home, "Library", "Application Support", "Google", "Chrome"),
        },
        {
          key: "edge",
          label: "Microsoft Edge",
          processName: "Microsoft Edge",
          executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          userDataRoot: path.join(home, "Library", "Application Support", "Microsoft Edge"),
        },
        {
          key: "brave",
          label: "Brave",
          processName: "Brave Browser",
          executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          userDataRoot: path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
        },
      ]
    : [
        {
          key: "chrome",
          label: "Google Chrome",
          processName: "chrome",
          executablePath: "/usr/bin/google-chrome",
          userDataRoot: path.join(home, ".config", "google-chrome"),
        },
        {
          key: "edge",
          label: "Microsoft Edge",
          processName: "microsoft-edge",
          executablePath: "/usr/bin/microsoft-edge",
          userDataRoot: path.join(home, ".config", "microsoft-edge"),
        },
        {
          key: "brave",
          label: "Brave",
          processName: "brave-browser",
          executablePath: "/usr/bin/brave-browser",
          userDataRoot: path.join(home, ".config", "BraveSoftware", "Brave-Browser"),
        },
      ];

  return candidates.find((candidate) => fs.existsSync(candidate.executablePath)) ?? null;
}

function findInstalledBrowser() {
  return process.platform === "win32" ? findWindowsBrowserInstall() : findPosixBrowserInstall();
}

function normalizeBrowserKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  switch (normalized) {
    case "ctrl":
      return "Control";
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    case "meta":
    case "cmd":
    case "command":
      return "Meta";
    case "esc":
      return "Escape";
    case "return":
      return "Enter";
    default:
      return normalized.length === 1 ? normalized.toUpperCase() : `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  }
}

async function ensureDirectory(dirPath: string) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function copyFileBestEffort(sourcePath: string, destinationPath: string) {
  await ensureDirectory(path.dirname(destinationPath));
  try {
    await fsp.copyFile(sourcePath, destinationPath);
  } catch {
    // Ignore locked or transient files.
  }
}

async function copyDirectoryBestEffort(sourceDir: string, destinationDir: string) {
  if (!(await pathExists(sourceDir))) {
    return;
  }

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
      continue;
    }

    await copyFileBestEffort(sourcePath, destinationPath);
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

  const preferred = ["Default", "Profile 1", "Profile 2"];
  for (const candidate of preferred) {
    if (fs.existsSync(path.join(userDataRoot, candidate))) {
      return candidate;
    }
  }
  return "Default";
}

function isBrowserProcessRunning(browser: BrowserInstall) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${browser.processName}.exe`], {
        encoding: "utf8",
      });
      return output.toLowerCase().includes(`${browser.processName}.exe`);
    }

    execFileSync("pgrep", ["-f", browser.processName], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function writeProfileMetadata(profile: BrowserProfileState, synced = false) {
  await ensureDirectory(profile.seedUserDataDir);
  const data: PersistedProfileMetadata = {
    version: 1,
    browserKey: profile.browserKey,
    profileDirectory: profile.profileDirectory,
    seededFromLocal: profile.seededFromLocal,
    sourceUserDataRoot: profile.sourceUserDataRoot,
    seededAt: nowIso(),
    ...(synced ? { lastSyncedAt: nowIso() } : {}),
  };
  await fsp.writeFile(path.join(profile.seedUserDataDir, PROFILE_METADATA_FILE), JSON.stringify(data, null, 2), "utf8");
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
  return `Browser automation switched to visual fallback: ${reason}. Continue with desktop_actions against the attached desktop screenshot.`;
}

const CHROME_MCP_INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "listbox",
  "slider",
  "spinbutton",
]);

function normalizeChromeSnapshotValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function inferChromeSnapshotTag(role: string) {
  switch (role) {
    case "button":
      return "button";
    case "link":
      return "a";
    case "textbox":
    case "searchbox":
    case "combobox":
    case "spinbutton":
    case "checkbox":
      return "input";
    case "listbox":
      return "select";
    case "option":
      return "option";
    case "tab":
      return "button";
    default:
      return role || "div";
  }
}

interface FlattenedChromeSnapshotNode {
  uid: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  text: string;
}

function flattenChromeSnapshot(root: ChromeMcpSnapshotNode, limit = 200) {
  const boundedLimit = Math.max(1, Math.min(2000, Math.trunc(limit)));
  const out: FlattenedChromeSnapshotNode[] = [];

  const visit = (node: ChromeMcpSnapshotNode) => {
    if (out.length >= boundedLimit) {
      return;
    }

    const uid = normalizeChromeSnapshotValue(node.id);
    const role = normalizeChromeSnapshotValue(node.role)?.toLowerCase() ?? "generic";
    const name = normalizeChromeSnapshotValue(node.name);
    const value = normalizeChromeSnapshotValue(node.value);
    const description = normalizeChromeSnapshotValue(node.description);
    const text = trimText([name, value, description].filter(Boolean).join(" "), 160);

    if (uid && (CHROME_MCP_INTERACTIVE_ROLES.has(role) || name || value || description)) {
      out.push({
        uid,
        role,
        name,
        value,
        description,
        text,
      });
    }

    for (const child of node.children ?? []) {
      visit(child);
      if (out.length >= boundedLimit) {
        return;
      }
    }
  };

  visit(root);
  return out;
}

function toSnapshotElements(nodes: FlattenedChromeSnapshotNode[], maxElements = 40): BrowserSnapshotElement[] {
  return nodes.slice(0, Math.max(1, Math.min(100, Math.trunc(maxElements)))).map((node) => ({
    selector: node.uid,
    tag: inferChromeSnapshotTag(node.role),
    role: node.role || null,
    text: node.text,
    ariaLabel: node.name ?? node.description ?? null,
    name: node.name ?? null,
    placeholder: null,
    type: inferChromeSnapshotTag(node.role) === "input" ? node.role : null,
    href: node.role === "link" ? node.text || null : null,
    disabled: false,
    valuePreview: node.value ? trimText(node.value, 80) : undefined,
  }));
}

function normalizeSearchText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function waitForMs(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickAvailableLoopbackPort(startPort = 9340, attempts = 30) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    if (await canBindTcpPort(port)) {
      return port;
    }
  }
  throw new Error(`Unable to find an available loopback port starting at ${startPort}.`);
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly profileRootDir: string;
  private readonly preferredMode: "playwright" | "external_cdp";
  private readonly chromeMcpRefs = new Map<string, number>();
  private externalCdpStatus: BrowserRuntimeStatus["externalCdp"];

  constructor(
    private readonly options: {
      rootDir: string;
      sidecar: DesktopSidecar;
      preferredMode?: "playwright" | "external_cdp";
    },
  ) {
    this.profileRootDir = path.join(options.rootDir, "data", "browser-profiles");
    this.preferredMode = options.preferredMode ?? "playwright";
    this.externalCdpStatus = {
      preferred: this.preferredMode === "external_cdp",
      available: false,
      attachedSessionCount: 0,
    };
  }

  private toResultProfileMode(profile: ResolvedRuntimeBrowserProfile): BrowserResultMeta["profileMode"] {
    switch (profile.mode) {
      case "local-existing-session":
        return "existing_session";
      case "remote-cdp":
        return "external_cdp";
      default:
        return "local_managed";
    }
  }

  private getDefaultProfileName() {
    return this.preferredMode === "external_cdp" ? "user" : "managed";
  }

  private buildUserSessionProfile(browser: BrowserInstall): ResolvedRuntimeBrowserProfile {
    const profileDirectory = detectPreferredProfileDirectory(browser.userDataRoot);
    return {
      name: "user",
      mode: "local-existing-session",
      driver: "existing-session",
      transport: "chrome-mcp",
      attachOnly: true,
      browser,
      userDataDir: browser.userDataRoot,
      profileDirectory,
      sourceUserDataRoot: browser.userDataRoot,
    };
  }

  private buildManagedSessionProfile(browser: BrowserInstall, port?: number, profile?: BrowserProfileState): ResolvedRuntimeBrowserProfile {
    return {
      name: "managed",
      mode: "local-managed",
      driver: "novaper",
      transport: "cdp",
      attachOnly: false,
      browser,
      ...(typeof port === "number" ? { cdpUrl: buildCdpHttpEndpoint(port), port, source: "managed" as const } : {}),
      userDataDir: profile?.runtimeUserDataDir,
      profileDirectory: profile?.profileDirectory ?? detectPreferredProfileDirectory(browser.userDataRoot),
      sourceUserDataRoot: profile?.sourceUserDataRoot ?? browser.userDataRoot,
    };
  }

  private buildRemoteSessionProfile(browser: BrowserInstall, endpoint: ExternalCdpEndpoint): ResolvedRuntimeBrowserProfile {
    return {
      name: "remote",
      mode: "remote-cdp",
      driver: "novaper",
      transport: "cdp",
      attachOnly: true,
      browser,
      cdpUrl: endpoint.endpointURL,
      source: endpoint.source,
      port: endpoint.port,
      profileDirectory: endpoint.profileDirectory ?? detectPreferredProfileDirectory(browser.userDataRoot),
      sourceUserDataRoot: endpoint.sourceUserDataRoot ?? browser.userDataRoot,
    };
  }

  private buildResultMeta(state: BrowserSessionState): BrowserResultMeta {
    return {
      strategy: state.strategy,
      browser: state.browser.key,
      browserLabel: state.browser.label,
      profileMode: state.profileMode,
    };
  }

  private getAttachedSessionCount() {
    return [...this.sessions.values()].filter(
      (state) =>
        state.strategy === "chrome-mcp" ||
        (state.strategy === "cdp" && state.profileMode === "external_cdp"),
    ).length;
  }

  private getActiveTransport(): BrowserRuntimeStatus["activeTransport"] {
    return [...this.sessions.values()].at(-1)?.strategy;
  }

  private buildRuntimeProfiles(browser: BrowserInstall | null): BrowserRuntimeProfileStatus[] {
    if (!browser) {
      return [];
    }

    const activeRemote = [...this.sessions.values()].find(
      (state): state is PlaywrightSessionState =>
        state.strategy === "cdp" && state.profileMode === "external_cdp",
    );
    const activeManaged = [...this.sessions.values()].find(
      (state): state is PlaywrightSessionState =>
        state.strategy === "cdp" && state.profileMode === "local_managed",
    );
    const hasChromeMcp = [...this.sessions.values()].some((state) => state.strategy === "chrome-mcp");

    const userProfile = this.buildUserSessionProfile(browser);
    const managedProfile = activeManaged?.sessionProfile ?? this.buildManagedSessionProfile(browser);

    const profiles: BrowserRuntimeProfileStatus[] = [
      {
        name: userProfile.name,
        mode: userProfile.mode,
        driver: userProfile.driver,
        transport: userProfile.transport,
        attachOnly: userProfile.attachOnly,
        available: hasChromeMcp,
        browser: browser.key,
        browserLabel: browser.label,
        profileDirectory: userProfile.profileDirectory,
        userDataDir: userProfile.userDataDir,
        lastError: hasChromeMcp
          ? undefined
          : isBrowserProcessRunning(browser)
            ? "Waiting for a local Chromium session that allows browser attach."
            : `${browser.label} is not running.`,
      },
    ];

    const shouldShowRemote =
      this.preferredMode === "external_cdp" ||
      Boolean(activeRemote?.sessionProfile.cdpUrl) ||
      Boolean(this.externalCdpStatus.endpointURL);
    if (shouldShowRemote) {
      const remoteProfile =
        activeRemote?.sessionProfile ??
        (this.externalCdpStatus.endpointURL
          ? this.buildRemoteSessionProfile(browser, {
              endpointURL: this.externalCdpStatus.endpointURL,
              source: this.externalCdpStatus.source ?? "port-scan",
              ...(typeof this.externalCdpStatus.port === "number" ? { port: this.externalCdpStatus.port } : {}),
              ...(this.externalCdpStatus.profileDirectory ? { profileDirectory: this.externalCdpStatus.profileDirectory } : {}),
              sourceUserDataRoot: browser.userDataRoot,
            })
          : {
              name: "remote",
              mode: "remote-cdp",
              driver: "novaper",
              transport: "cdp",
              attachOnly: true,
              browser,
              profileDirectory: this.externalCdpStatus.profileDirectory ?? detectPreferredProfileDirectory(browser.userDataRoot),
              sourceUserDataRoot: browser.userDataRoot,
            });

      profiles.push({
        name: remoteProfile.name,
        mode: remoteProfile.mode,
        driver: remoteProfile.driver,
        transport: remoteProfile.transport,
        attachOnly: remoteProfile.attachOnly,
        available: Boolean(activeRemote || this.externalCdpStatus.available),
        browser: browser.key,
        browserLabel: browser.label,
        cdpUrl: remoteProfile.cdpUrl,
        profileDirectory: remoteProfile.profileDirectory,
        source: remoteProfile.source,
        lastError:
          activeRemote || this.externalCdpStatus.available
            ? undefined
            : this.externalCdpStatus.error,
      });
    }

    profiles.push({
      name: managedProfile.name,
      mode: managedProfile.mode,
      driver: managedProfile.driver,
      transport: managedProfile.transport,
      attachOnly: managedProfile.attachOnly,
      available: true,
      browser: browser.key,
      browserLabel: browser.label,
      cdpUrl: managedProfile.cdpUrl,
      profileDirectory: managedProfile.profileDirectory,
      userDataDir: managedProfile.userDataDir,
      source: managedProfile.source,
    });

    return profiles;
  }

  describeRuntime() {
    return this.preferredMode === "external_cdp"
      ? "OpenClaw-style browser runtime: existing-session via Chrome DevTools MCP, remote CDP attach when available, and a managed Chromium fallback"
      : "OpenClaw-style managed Chromium runtime with a copied profile and loopback CDP";
  }

  getRuntimeStatus(): BrowserRuntimeStatus {
    const browser = findInstalledBrowser();
    return {
      preferredMode: this.preferredMode,
      defaultProfile: this.getDefaultProfileName(),
      activeTransport: this.getActiveTransport(),
      profiles: this.buildRuntimeProfiles(browser),
      externalCdp: {
        ...this.externalCdpStatus,
        preferred: this.preferredMode === "external_cdp",
        attachedSessionCount: this.getAttachedSessionCount(),
      },
    };
  }

  async refreshRuntimeStatus() {
    if (this.preferredMode !== "external_cdp") {
      return this.getRuntimeStatus();
    }

    const browser = findInstalledBrowser();
    if (!browser) {
      this.updateExternalCdpStatus({
        available: false,
        browser: undefined,
        endpointURL: undefined,
        source: undefined,
        port: undefined,
        profileDirectory: undefined,
        error: "No supported Chromium browser found.",
      });
      return this.getRuntimeStatus();
    }

    const activeChromeMcp = [...this.sessions.values()].find(
      (state): state is ChromeMcpSessionState => state.strategy === "chrome-mcp",
    );
    if (activeChromeMcp) {
      this.updateExternalCdpStatus({
        available: true,
        browser: activeChromeMcp.browser.key,
        endpointURL: undefined,
        source: "chrome-mcp",
        port: undefined,
        profileDirectory: activeChromeMcp.profileDirectory,
        error: undefined,
      });
      return this.getRuntimeStatus();
    }

    const activeRemote = [...this.sessions.values()].find(
      (state): state is PlaywrightSessionState =>
        state.strategy === "cdp" && state.profileMode === "external_cdp",
    );
    if (activeRemote) {
      this.updateExternalCdpStatus({
        available: true,
        browser: activeRemote.browser.key,
        endpointURL: activeRemote.endpointURL,
        source: activeRemote.sessionProfile.source,
        port: activeRemote.sessionProfile.port,
        profileDirectory: activeRemote.profileDirectory,
        error: undefined,
      });
      return this.getRuntimeStatus();
    }

    await this.discoverExternalCdpEndpoint(browser);
    return this.getRuntimeStatus();
  }

  private updateExternalCdpStatus(overrides: Partial<BrowserRuntimeStatus["externalCdp"]>) {
    this.externalCdpStatus = {
      ...this.externalCdpStatus,
      ...overrides,
      lastCheckedAt: nowIso(),
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

    const userDataDir = state.profileMode === "local_managed" ? state.profile?.runtimeUserDataDir : undefined;
    const profileDirectory = state.profileMode === "local_managed" ? state.profile?.profileDirectory : state.profileDirectory;
    const launchArgs = [
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
      ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
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
    await waitForMs(1500);
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

  private async activateVisualFallback(
    sessionId: string,
    sessionProfile: ResolvedRuntimeBrowserProfile,
    fallbackReason: string,
    profile?: BrowserProfileState,
    url?: string,
  ): Promise<VisualSessionState> {
    const state: VisualSessionState = {
      strategy: "visual",
      browser: sessionProfile.browser,
      profileMode: this.toResultProfileMode(sessionProfile),
      sessionProfile,
      profile,
      sourceUserDataRoot: sessionProfile.sourceUserDataRoot,
      profileDirectory: sessionProfile.profileDirectory ?? profile?.profileDirectory,
      fallbackReason,
    };
    this.sessions.set(sessionId, state);
    await this.ensureVisualBrowser(state, url).catch(() => undefined);
    return state;
  }

  private async discoverExternalCdpEndpoint(browser: BrowserInstall): Promise<ExternalCdpEndpoint | null> {
    const envEndpoint =
      process.env.NOVAPER_EXTERNAL_CDP_URL?.trim() ||
      process.env.CHROME_REMOTE_DEBUG_URL?.trim() ||
      "";
    if (envEndpoint) {
      const version = await fetchCdpVersion(envEndpoint);
      if (!version || isProbablyExternalChromiumVersion(version)) {
        this.updateExternalCdpStatus({
          available: true,
          browser: browser.key,
          endpointURL: envEndpoint,
          source: "env",
          error: undefined,
        });
        return {
          endpointURL: envEndpoint,
          source: "env",
          profileDirectory: detectPreferredProfileDirectory(browser.userDataRoot),
          sourceUserDataRoot: browser.userDataRoot,
        };
      }
    }

    const profileDirectory = detectPreferredProfileDirectory(browser.userDataRoot);
    const devToolsActivePortPath = browser.userDataRoot ? path.join(browser.userDataRoot, "DevToolsActivePort") : undefined;
    if (devToolsActivePortPath && fs.existsSync(devToolsActivePortPath)) {
      try {
        const [portLine, wsPathLine] = fs.readFileSync(devToolsActivePortPath, "utf8").split(/\r?\n/);
        const port = Number.parseInt(portLine ?? "", 10);
        const wsPath = wsPathLine?.trim() || undefined;
        if (Number.isFinite(port) && port > 0 && (await canConnectToTcpPort(port))) {
          const version = await fetchCdpVersion(buildCdpHttpEndpoint(port));
          if (isProbablyExternalChromiumVersion(version)) {
            const endpointURL = buildCdpWsEndpoint(port, wsPath);
            this.updateExternalCdpStatus({
              available: true,
              browser: browser.key,
              endpointURL,
              source: "devtools-active-port",
              port,
              profileDirectory,
              error: undefined,
            });
            return {
              endpointURL,
              source: "devtools-active-port",
              port,
              wsPath,
              profileDirectory,
              sourceUserDataRoot: browser.userDataRoot,
            };
          }
        }
      } catch {
        // Ignore malformed discovery file.
      }
    }

    for (const port of [9222, 9229, 9334, 9335]) {
      const version = await fetchCdpVersion(buildCdpHttpEndpoint(port));
      if (!isProbablyExternalChromiumVersion(version)) {
        continue;
      }
      const endpointURL =
        typeof version?.webSocketDebuggerUrl === "string" && version.webSocketDebuggerUrl.length > 0
          ? version.webSocketDebuggerUrl
          : buildCdpHttpEndpoint(port);
      this.updateExternalCdpStatus({
        available: true,
        browser: browser.key,
        endpointURL,
        source: "port-scan",
        port,
        profileDirectory,
        error: undefined,
      });
      return {
        endpointURL,
        source: "port-scan",
        port,
        profileDirectory,
        sourceUserDataRoot: browser.userDataRoot,
      };
    }

    this.updateExternalCdpStatus({
      available: false,
      browser: browser.key,
      endpointURL: undefined,
      source: undefined,
      port: undefined,
      profileDirectory,
      error: isBrowserProcessRunning(browser) ? `${browser.label} is running without a discoverable remote-debugging endpoint.` : undefined,
    });
    return null;
  }

  private retainChromeMcpProfile(profileName: string) {
    this.chromeMcpRefs.set(profileName, (this.chromeMcpRefs.get(profileName) ?? 0) + 1);
  }

  private async releaseChromeMcpProfile(profileName: string) {
    const next = (this.chromeMcpRefs.get(profileName) ?? 0) - 1;
    if (next > 0) {
      this.chromeMcpRefs.set(profileName, next);
      return;
    }
    this.chromeMcpRefs.delete(profileName);
    await closeChromeMcpSession(profileName).catch(() => undefined);
  }

  private async launchChromeMcpSession(sessionId: string, browser: BrowserInstall): Promise<ChromeMcpSessionState | null> {
    const sessionProfile = this.buildUserSessionProfile(browser);
    try {
      await ensureChromeMcpAvailable(sessionProfile.name, sessionProfile.userDataDir);
      const pages = await listChromeMcpPages(sessionProfile.name, sessionProfile.userDataDir);
      const page =
        pages.find((entry) => entry.selected) ??
        pages.at(-1) ??
        (await newChromeMcpPage(sessionProfile.name, "about:blank", sessionProfile.userDataDir));
      await selectChromeMcpPage(sessionProfile.name, page.id, sessionProfile.userDataDir).catch(() => undefined);

      const state: ChromeMcpSessionState = {
        strategy: "chrome-mcp",
        browser,
        profileMode: this.toResultProfileMode(sessionProfile),
        sessionProfile,
        pageId: page.id,
        sourceUserDataRoot: sessionProfile.sourceUserDataRoot,
        profileDirectory: sessionProfile.profileDirectory,
      };
      this.sessions.set(sessionId, state);
      this.retainChromeMcpProfile(sessionProfile.name);
      this.updateExternalCdpStatus({
        available: true,
        browser: browser.key,
        endpointURL: undefined,
        source: "chrome-mcp",
        port: undefined,
        profileDirectory: sessionProfile.profileDirectory,
        error: undefined,
      });
      return state;
    } catch (error) {
      this.updateExternalCdpStatus({
        available: false,
        browser: browser.key,
        endpointURL: undefined,
        source: undefined,
        port: undefined,
        profileDirectory: sessionProfile.profileDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async waitForManagedCdpEndpoint(port: number) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const version = await fetchCdpVersion(buildCdpHttpEndpoint(port));
      if (isProbablyExternalChromiumVersion(version)) {
        return {
          endpointURL:
            typeof version?.webSocketDebuggerUrl === "string" && version.webSocketDebuggerUrl.length > 0
              ? version.webSocketDebuggerUrl
              : buildCdpHttpEndpoint(port),
        };
      }
      await waitForMs(500);
    }

    throw new Error("Managed Chromium failed to expose a loopback CDP endpoint.");
  }

  private async attachRemoteCdpSession(sessionId: string, browser: BrowserInstall): Promise<PlaywrightSessionState | null> {
    const endpoint = await this.discoverExternalCdpEndpoint(browser);
    if (!endpoint) {
      return null;
    }

    const sessionProfile = this.buildRemoteSessionProfile(browser, endpoint);
    try {
      const browserConnection = await chromium.connectOverCDP(endpoint.endpointURL);
      const context = browserConnection.contexts()[0];
      if (!context) {
        await browserConnection.close().catch(() => undefined);
        throw new Error("Remote CDP session did not expose a default browser context.");
      }

      let activePage =
        context
          .pages()
          .filter((page) => !page.isClosed() && !page.url().startsWith("devtools://"))
          .at(-1) ?? null;
      if (!activePage) {
        activePage = await context.newPage();
      }

      await activePage.bringToFront();
      await settlePage(activePage);

      const state: PlaywrightSessionState = {
        strategy: "cdp",
        browser,
        profileMode: this.toResultProfileMode(sessionProfile),
        sessionProfile,
        sourceUserDataRoot: endpoint.sourceUserDataRoot,
        profileDirectory: endpoint.profileDirectory,
        context,
        activePage,
        browserConnection,
        endpointURL: endpoint.endpointURL,
      };

      browserConnection.on("disconnected", () => {
        void this.cleanupDisconnectedPlaywrightState(sessionId, state);
      });

      this.sessions.set(sessionId, state);
      this.updateExternalCdpStatus({
        available: true,
        browser: browser.key,
        endpointURL: endpoint.endpointURL,
        source: endpoint.source,
        port: endpoint.port,
        profileDirectory: endpoint.profileDirectory,
        error: undefined,
      });
      return state;
    } catch (error) {
      this.updateExternalCdpStatus({
        available: false,
        browser: browser.key,
        endpointURL: endpoint.endpointURL,
        source: endpoint.source,
        port: endpoint.port,
        profileDirectory: endpoint.profileDirectory,
        error: error instanceof Error ? error.message : "Failed to connect to external CDP.",
      });
      return null;
    }
  }

  private async launchManagedCdpSession(sessionId: string, browser: BrowserInstall): Promise<BrowserSessionState> {
    const profile = await this.prepareProfile(browser, sessionId);
    const port = await pickAvailableLoopbackPort();
    const sessionProfile = this.buildManagedSessionProfile(browser, port, profile);

    let processId: number | undefined;
    try {
      const launched = await this.options.sidecar.launchProcess({
        command: browser.executablePath,
        args: [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile.runtimeUserDataDir}`,
          `--profile-directory=${profile.profileDirectory}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "about:blank",
        ],
      });
      processId = launched.pid;

      const endpoint = await this.waitForManagedCdpEndpoint(port);
      const browserConnection = await chromium.connectOverCDP(endpoint.endpointURL);
      const context = browserConnection.contexts()[0];
      if (!context) {
        await browserConnection.close().catch(() => undefined);
        throw new Error("Managed Chromium did not expose a default browser context.");
      }

      let activePage =
        context
          .pages()
          .filter((page) => !page.isClosed() && !page.url().startsWith("devtools://"))
          .at(-1) ?? null;
      if (!activePage) {
        activePage = await context.newPage();
      }

      await activePage.bringToFront();
      await settlePage(activePage);

      const state: PlaywrightSessionState = {
        strategy: "cdp",
        browser,
        profileMode: this.toResultProfileMode(sessionProfile),
        sessionProfile,
        profile,
        sourceUserDataRoot: profile.sourceUserDataRoot,
        profileDirectory: profile.profileDirectory,
        context,
        activePage,
        browserConnection,
        endpointURL: endpoint.endpointURL,
        managedLaunch: {
          port,
          processId: launched.pid,
        },
      };

      browserConnection.on("disconnected", () => {
        void this.cleanupDisconnectedPlaywrightState(sessionId, state);
      });

      this.sessions.set(sessionId, state);
      return state;
    } catch (error) {
      if (typeof processId === "number") {
        await this.options.sidecar.killProcess({ pid: processId }).catch(() => undefined);
      }
      const reason = error instanceof Error ? error.message : "Failed to launch managed Chromium session.";
      return this.activateVisualFallback(sessionId, sessionProfile, reason, profile);
    }
  }

  private async teardownPlaywrightState(state: PlaywrightSessionState, options?: { cleanupProfile?: boolean }) {
    if (state.managedLaunch?.processId) {
      await this.options.sidecar.killProcess({ pid: state.managedLaunch.processId }).catch(() => undefined);
    }

    if (state.browserConnection) {
      await state.browserConnection.close().catch(() => undefined);
    } else {
      await state.context.close().catch(() => undefined);
    }

    if (options?.cleanupProfile !== false && state.profile) {
      await this.syncRuntimeProfile(state.profile).catch(() => undefined);
      await this.cleanupRuntimeProfile(state.profile).catch(() => undefined);
    }
  }

  private async cleanupDisconnectedPlaywrightState(sessionId: string, state: PlaywrightSessionState) {
    const current = this.sessions.get(sessionId);
    if (current !== state) {
      return;
    }

    this.sessions.delete(sessionId);
    if (state.profile) {
      await this.syncRuntimeProfile(state.profile).catch(() => undefined);
      await this.cleanupRuntimeProfile(state.profile).catch(() => undefined);
    }
  }

  private async getSession(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.strategy === "visual") {
        return existing;
      }

      if (existing.strategy === "chrome-mcp") {
        try {
          await this.getChromeMcpPage(existing);
          return existing;
        } catch {
          await this.disposeSession(sessionId);
        }
      } else {
        try {
          const pages = await this.listPages(existing);
          if (pages.length > 0) {
            if (existing.activePage.isClosed() || !pages.includes(existing.activePage)) {
              existing.activePage = pages[pages.length - 1];
            }
            return existing;
          }
        } catch {
          await this.disposeSession(sessionId);
        }
      }
    }

    const browser = findInstalledBrowser();
    if (!browser) {
      throw new Error("No supported Chromium browser found. Install Google Chrome, Microsoft Edge, or Brave.");
    }

    if (this.preferredMode === "external_cdp") {
      const chromeMcpState = await this.launchChromeMcpSession(sessionId, browser);
      if (chromeMcpState) {
        return chromeMcpState;
      }

      const remoteState = await this.attachRemoteCdpSession(sessionId, browser);
      if (remoteState) {
        return remoteState;
      }
    }

    return this.launchManagedCdpSession(sessionId, browser);
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
        state.sessionProfile,
        error instanceof Error ? error.message : "Browser automation failed.",
        state.profile,
      );
      await this.teardownPlaywrightState(state, { cleanupProfile: false }).catch(() => undefined);
      return visualState;
    }
  }

  private async getChromeMcpPage(state: ChromeMcpSessionState, createIfMissing = true): Promise<ChromeMcpPageInfo> {
    const pages = await listChromeMcpPages(state.sessionProfile.name, state.sessionProfile.userDataDir);
    if (pages.length === 0 && createIfMissing) {
      const created = await newChromeMcpPage(state.sessionProfile.name, "about:blank", state.sessionProfile.userDataDir);
      state.pageId = created.id;
      return created;
    }

    const current = pages.find((page) => page.id === state.pageId) ?? pages.find((page) => page.selected) ?? pages.at(-1);
    if (!current) {
      throw new Error("No Chrome MCP page is available for this session.");
    }
    state.pageId = current.id;
    return current;
  }

  private async getChromeMcpPageMeta(state: ChromeMcpSessionState) {
    const page = await this.getChromeMcpPage(state);
    const result = await evaluateChromeMcpScript({
      profileName: state.sessionProfile.name,
      userDataDir: state.sessionProfile.userDataDir,
      pageId: page.id,
      fn: `() => ({
        title: document.title || "Untitled",
        url: window.location.href,
        readyState: document.readyState,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      })`,
    }).catch(() => null);

    const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    const viewport = record.viewport && typeof record.viewport === "object" ? (record.viewport as Record<string, unknown>) : {};

    return {
      title: trimText(typeof record.title === "string" ? record.title : "Untitled", 120) || "Untitled",
      url: typeof record.url === "string" ? record.url : page.url ?? "about:blank",
      readyState: typeof record.readyState === "string" ? record.readyState : "complete",
      viewport: {
        width: typeof viewport.width === "number" ? viewport.width : 0,
        height: typeof viewport.height === "number" ? viewport.height : 0,
      },
    };
  }

  private async getChromeMcpTabs(state: ChromeMcpSessionState) {
    const pages = await listChromeMcpPages(state.sessionProfile.name, state.sessionProfile.userDataDir);
    const activeMeta = await this.getChromeMcpPageMeta(state).catch(() => null);
    return pages.map((page, index) => ({
      index,
      title: page.id === state.pageId ? activeMeta?.title ?? `Page ${page.id}` : `Page ${page.id}`,
      url: page.url ?? (page.id === state.pageId ? activeMeta?.url ?? "about:blank" : "about:blank"),
      isActive: page.id === state.pageId,
    }));
  }

  private async findChromeMcpUidByText(state: ChromeMcpSessionState, text: string, index = 0) {
    const page = await this.getChromeMcpPage(state);
    const snapshot = await takeChromeMcpSnapshot({
      profileName: state.sessionProfile.name,
      userDataDir: state.sessionProfile.userDataDir,
      pageId: page.id,
    });
    const needle = normalizeSearchText(text);
    const flattened = flattenChromeSnapshot(snapshot, 500);
    const matches = flattened.filter((node) =>
      normalizeSearchText(`${node.name ?? ""} ${node.value ?? ""} ${node.description ?? ""} ${node.text}`).includes(needle),
    );
    return (matches[index] ?? matches[0])?.uid;
  }

  private async waitForChromeMcpSelector(state: ChromeMcpSessionState, selector: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = await this.getChromeMcpPage(state);
      try {
        const snapshot = await takeChromeMcpSnapshot({
          profileName: state.sessionProfile.name,
          userDataDir: state.sessionProfile.userDataDir,
          pageId: page.id,
        });
        if (flattenChromeSnapshot(snapshot, 500).some((node) => node.uid === selector)) {
          return true;
        }
      } catch {
        // Fall through to DOM query.
      }

      const foundViaCss = await evaluateChromeMcpScript({
        profileName: state.sessionProfile.name,
        userDataDir: state.sessionProfile.userDataDir,
        pageId: page.id,
        fn: `() => Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      }).catch(() => false);
      if (foundViaCss === true) {
        return true;
      }

      await waitForMs(250);
    }

    throw new Error(`Timed out waiting for selector: ${selector}`);
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

    if (state.strategy === "chrome-mcp") {
      const page =
        args.newTab === true
          ? await newChromeMcpPage(state.sessionProfile.name, args.url ?? "about:blank", state.sessionProfile.userDataDir)
          : await this.getChromeMcpPage(state);
      state.pageId = page.id;
      await selectChromeMcpPage(state.sessionProfile.name, page.id, state.sessionProfile.userDataDir);

      if (args.url && !args.newTab) {
        await navigateChromeMcpPage({
          profileName: state.sessionProfile.name,
          userDataDir: state.sessionProfile.userDataDir,
          pageId: page.id,
          url: args.url,
          timeoutMs: 30000,
        });
      }

      const meta = await this.getChromeMcpPageMeta(state);
      return {
        ...this.buildResultMeta(state),
        opened: true,
        title: meta.title,
        url: meta.url,
        tabs: await this.getChromeMcpTabs(state),
      };
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

    if ("sessionProfile" in result && result.strategy === "visual") {
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

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      await navigateChromeMcpPage({
        profileName: state.sessionProfile.name,
        userDataDir: state.sessionProfile.userDataDir,
        pageId: page.id,
        url: args.url,
        timeoutMs: 30000,
      });
      const meta = await this.getChromeMcpPageMeta(state);
      return {
        ...this.buildResultMeta(state),
        navigated: true,
        title: meta.title,
        url: meta.url,
        tabs: await this.getChromeMcpTabs(state),
      };
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

    if ("sessionProfile" in result && result.strategy === "visual") {
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

    if (state.strategy === "chrome-mcp") {
      const pages = await listChromeMcpPages(state.sessionProfile.name, state.sessionProfile.userDataDir);
      switch (args.action) {
        case "list":
          return { ...this.buildResultMeta(state), tabs: await this.getChromeMcpTabs(state) };
        case "new": {
          const created = await newChromeMcpPage(state.sessionProfile.name, args.url ?? "about:blank", state.sessionProfile.userDataDir);
          state.pageId = created.id;
          await selectChromeMcpPage(state.sessionProfile.name, created.id, state.sessionProfile.userDataDir);
          const tabs = await this.getChromeMcpTabs(state);
          return { ...this.buildResultMeta(state), opened: true, index: tabs.findIndex((tab) => tab.isActive), url: created.url ?? args.url ?? "about:blank", tabs };
        }
        case "switch": {
          if (typeof args.index !== "number" || args.index < 0 || args.index >= pages.length) {
            throw new Error("browser_tabs switch requires a valid tab index.");
          }
          const target = pages[args.index];
          state.pageId = target.id;
          await selectChromeMcpPage(state.sessionProfile.name, target.id, state.sessionProfile.userDataDir);
          const meta = await this.getChromeMcpPageMeta(state);
          return { ...this.buildResultMeta(state), switched: true, index: args.index, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
        }
        case "close": {
          if (pages.length === 0) {
            return { ...this.buildResultMeta(state), closed: false, browserClosed: false, tabs: [] };
          }
          const targetIndex = typeof args.index === "number" ? args.index : pages.findIndex((page) => page.id === state.pageId);
          if (targetIndex < 0 || targetIndex >= pages.length) {
            throw new Error("browser_tabs close requires a valid tab index.");
          }
          await closeChromeMcpPage(state.sessionProfile.name, pages[targetIndex].id, state.sessionProfile.userDataDir);
          const remaining = await listChromeMcpPages(state.sessionProfile.name, state.sessionProfile.userDataDir);
          if (remaining.length > 0) {
            state.pageId = (remaining[Math.max(0, Math.min(targetIndex, remaining.length - 1))] ?? remaining[0]).id;
            await selectChromeMcpPage(state.sessionProfile.name, state.pageId, state.sessionProfile.userDataDir).catch(() => undefined);
          }
          return { ...this.buildResultMeta(state), closed: true, browserClosed: false, tabs: await this.getChromeMcpTabs(state).catch(() => []) };
        }
        default:
          throw new Error(`Unsupported browser tab action: ${String(args.action)}`);
      }
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (_page, currentState) => {
      const pages = await this.listPages(currentState);
      switch (args.action) {
        case "list":
          return { ...this.buildResultMeta(currentState), tabs: await this.getTabs(currentState) };
        case "new": {
          const page = await currentState.context.newPage();
          currentState.activePage = page;
          await page.bringToFront();
          if (args.url) {
            await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await settlePage(page);
          }
          return { ...this.buildResultMeta(currentState), opened: true, index: (await this.listPages(currentState)).findIndex((entry) => entry === page), url: page.url(), tabs: await this.getTabs(currentState) };
        }
        case "switch": {
          if (typeof args.index !== "number" || args.index < 0 || args.index >= pages.length) {
            throw new Error("browser_tabs switch requires a valid tab index.");
          }
          currentState.activePage = pages[args.index];
          await currentState.activePage.bringToFront();
          return { ...this.buildResultMeta(currentState), switched: true, index: args.index, title: await safePageTitle(currentState.activePage), url: currentState.activePage.url(), tabs: await this.getTabs(currentState) };
        }
        case "close": {
          const targetIndex = typeof args.index === "number" ? args.index : pages.findIndex((page) => page === currentState.activePage);
          if (targetIndex < 0 || targetIndex >= pages.length) {
            throw new Error("browser_tabs close requires a valid tab index.");
          }
          await pages[targetIndex].close({ runBeforeUnload: true });
          const remaining = await this.listPages(currentState);
          if (remaining.length === 0) {
            await this.teardownPlaywrightState(currentState).catch(() => undefined);
            this.sessions.delete(sessionId);
            return { ...this.buildResultMeta(currentState), closed: true, browserClosed: true, tabs: [] };
          }
          currentState.activePage = remaining[Math.max(0, Math.min(targetIndex, remaining.length - 1))];
          await currentState.activePage.bringToFront();
          return { ...this.buildResultMeta(currentState), closed: true, browserClosed: false, tabs: await this.getTabs(currentState) };
        }
        default:
          throw new Error(`Unsupported browser tab action: ${String(args.action)}`);
      }
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
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
        textPreview: "Browser DOM automation is unavailable for this session. Use the desktop screenshot and desktop_actions for browser interaction.",
      }) as BrowserSnapshotResult;
    }

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      const snapshot = await takeChromeMcpSnapshot({
        profileName: state.sessionProfile.name,
        userDataDir: state.sessionProfile.userDataDir,
        pageId: page.id,
      });
      const meta = await this.getChromeMcpPageMeta(state);
      const maxElements = Math.max(1, Math.min(100, Math.trunc(args.maxElements ?? 40)));
      const textLimit = Math.max(200, Math.min(5000, Math.trunc(args.textLimit ?? 1200)));
      const rawText =
        args.includeText === false
          ? undefined
          : await evaluateChromeMcpScript({
              profileName: state.sessionProfile.name,
              userDataDir: state.sessionProfile.userDataDir,
              pageId: page.id,
              fn: "() => document.body?.innerText || ''",
            }).catch(() => "");

      return {
        ...this.buildResultMeta(state),
        title: meta.title,
        url: meta.url,
        readyState: meta.readyState,
        viewport: meta.viewport,
        tabs: await this.getChromeMcpTabs(state),
        elements: toSnapshotElements(flattenChromeSnapshot(snapshot, 500), maxElements),
        textPreview: typeof rawText === "string" ? trimText(rawText.replace(/\s+/g, " ").trim(), textLimit) : undefined,
      };
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
            if (element.id) return `#${escapeSelector(element.id)}`;
            const htmlElement = element as HTMLElement;
            for (const [attribute, value] of [["data-testid", htmlElement.getAttribute("data-testid")], ["aria-label", htmlElement.getAttribute("aria-label")], ["name", htmlElement.getAttribute("name")], ["placeholder", htmlElement.getAttribute("placeholder")]]) {
              if (!value) continue;
              const selector = `${element.tagName.toLowerCase()}[${attribute}="${escapeSelector(value)}"]`;
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            const segments: string[] = [];
            let current: Element | null = element;
            while (current && current !== document.body && segments.length < 6) {
              const parentElement: Element | null = current.parentElement;
              let segment = current.tagName.toLowerCase();
              if (parentElement) {
                const siblings = (Array.from(parentElement.children) as Element[]).filter((child: Element) => child.tagName === current?.tagName);
                if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
              }
              segments.unshift(segment);
              const selector = segments.join(" > ");
              if (document.querySelectorAll(selector).length === 1) return selector;
              current = parentElement;
            }
            return segments.join(" > ") || element.tagName.toLowerCase();
          };
          const actionableSelector = "a, button, input, textarea, select, option, [role='button'], [role='link'], [role='tab'], [role='checkbox'], [contenteditable='true']";
          const candidates = Array.from(document.querySelectorAll(actionableSelector)).filter(visible).slice(0, limit);
          const elements = candidates.map((element) => {
            const htmlElement = element as HTMLElement & { href?: string; disabled?: boolean; value?: string; type?: string; name?: string; placeholder?: string };
            const type = typeof htmlElement.type === "string" ? htmlElement.type : null;
            const valuePreview = type && type.toLowerCase() === "password" ? undefined : shorten(typeof htmlElement.value === "string" ? htmlElement.value : undefined, 80);
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
            viewport: { width: window.innerWidth, height: window.innerHeight },
            elements,
            textPreview: includeText ? shorten(document.body?.innerText || "", maxTextLength) : undefined,
          };
        },
        { maxElements, includeText: args.includeText !== false, textLimit },
      )) as BrowserSnapshotDomResult;
      return { ...this.buildResultMeta(currentState), ...domResult, title: trimText(domResult.title, 120) || "Untitled", tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, {
        title: result.browser.label,
        url: "visual-fallback://desktop-browser",
        readyState: "visual_fallback",
        viewport: { width: 0, height: 0 },
        tabs: await this.getVisualPseudoTabs(result),
        elements: [],
        textPreview: "Browser automation failed during snapshot. Continue with desktop_actions and the latest desktop screenshot.",
      }) as BrowserSnapshotResult;
    }

    return result;
  }

  async click(sessionId: string, args: { selector?: string; text?: string; index?: number; button?: "left" | "right"; x?: number; y?: number }) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      return this.buildVisualFallbackResult(state, {
        clicked: false,
        note: `${buildFallbackNote(state.fallbackReason)} browser_click is no longer using DOM selectors in this session.`,
      });
    }

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      if (typeof args.x === "number" && typeof args.y === "number") {
        const clicked = await evaluateChromeMcpScript({
          profileName: state.sessionProfile.name,
          userDataDir: state.sessionProfile.userDataDir,
          pageId: page.id,
          fn: `() => {
            const x = ${args.x};
            const y = ${args.y};
            const button = ${args.button === "right" ? 2 : 0};
            const target = document.elementFromPoint(x, y);
            if (!(target instanceof Element)) return false;
            const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button };
            target.dispatchEvent(new MouseEvent("mousemove", init));
            target.dispatchEvent(new MouseEvent("mousedown", init));
            target.dispatchEvent(new MouseEvent("mouseup", init));
            target.dispatchEvent(new MouseEvent("click", init));
            return true;
          }`,
        });
        if (clicked !== true) {
          throw new Error("Could not click browser element at the requested coordinates.");
        }
      } else if (args.selector) {
        try {
          await clickChromeMcpElement({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, uid: args.selector });
        } catch {
          const clicked = await evaluateChromeMcpScript({
            profileName: state.sessionProfile.name,
            userDataDir: state.sessionProfile.userDataDir,
            pageId: page.id,
            fn: `() => {
              const element = document.querySelector(${JSON.stringify(args.selector)});
              if (!(element instanceof HTMLElement)) return false;
              element.click();
              return true;
            }`,
          });
          if (clicked !== true) {
            throw new Error(`Could not find browser element for selector: ${args.selector}`);
          }
        }
      } else if (args.text) {
        const uid = await this.findChromeMcpUidByText(state, args.text, args.index ?? 0);
        if (!uid) {
          throw new Error(`Could not find browser element containing text: ${args.text}`);
        }
        await clickChromeMcpElement({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, uid });
      } else {
        throw new Error("browser_click requires selector, text, or x/y coordinates.");
      }

      await waitForMs(150);
      const meta = await this.getChromeMcpPageMeta(state);
      return { ...this.buildResultMeta(state), clicked: true, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
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
        const handle = await page.evaluateHandle(({ text, index }) => {
          const visible = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const selector = "a, button, input, textarea, select, option, [role='button'], [role='link'], [role='tab'], [contenteditable='true']";
          const matches = Array.from(document.querySelectorAll(selector)).filter((element) => {
            if (!visible(element)) return false;
            const content = `${(element as HTMLElement).innerText || element.textContent || ""} ${(element as HTMLElement).getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
            return content.includes(text);
          });
          return matches[index ?? 0] ?? null;
        }, { text: args.text, index: args.index ?? 0 });
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
      return { ...this.buildResultMeta(currentState), clicked: true, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, { clicked: false });
    }
    return result;
  }

  async type(sessionId: string, args: { selector?: string; text: string; clear?: boolean; submit?: boolean }) {
    const state = await this.getSession(sessionId);
    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state);
      if (args.selector) {
        return this.buildVisualFallbackResult(state, { typed: false, submitted: false, note: `${buildFallbackNote(state.fallbackReason)} browser_type with selector is unavailable in visual mode.` });
      }

      const actions: Array<{ type: "keypress"; keys: string[] } | { type: "type"; text: string }> = [];
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

      return this.buildVisualFallbackResult(state, { typed: true, submitted: Boolean(args.submit), title: state.browser.label, url: "visual-fallback://desktop-browser", tabs: await this.getVisualPseudoTabs(state) });
    }

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      const updateScript = (targetExpression: string) => `() => {
        const target = ${targetExpression};
        if (!(target instanceof Element)) return false;
        const text = ${JSON.stringify(args.text)};
        const clear = ${args.clear === true};
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          const nextValue = clear ? text : (target.value || "") + text;
          target.focus();
          target.value = nextValue;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
          const nextValue = clear ? text : (target.textContent || "") + text;
          target.focus();
          target.textContent = nextValue;
          target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          return true;
        }
        target.focus();
        return false;
      }`;

      let updated = false;
      if (args.selector) {
        updated = Boolean(await evaluateChromeMcpScript({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, args: [args.selector], fn: updateScript("el") }).catch(() => false));
        if (!updated) {
          updated = Boolean(await evaluateChromeMcpScript({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, fn: updateScript(`document.querySelector(${JSON.stringify(args.selector)})`) }).catch(() => false));
        }
      } else {
        updated = Boolean(await evaluateChromeMcpScript({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, fn: updateScript("document.activeElement") }).catch(() => false));
      }

      if (!updated) {
        throw new Error(args.selector ? `Could not type into selector: ${args.selector}` : "No editable browser element is focused.");
      }
      if (args.submit) {
        await pressChromeMcpKey({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, key: "Enter" });
      }
      await waitForMs(120);
      const meta = await this.getChromeMcpPageMeta(state);
      return { ...this.buildResultMeta(state), typed: true, submitted: Boolean(args.submit), title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
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
      return { ...this.buildResultMeta(currentState), typed: true, submitted: Boolean(args.submit), title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, { typed: false, submitted: false });
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
      await this.options.sidecar.execActions({ actions: [{ type: "keypress", keys: args.keys.map((key) => key.toUpperCase()) }] });
      return this.buildVisualFallbackResult(state, { pressed: true, keys: args.keys, title: state.browser.label, url: "visual-fallback://desktop-browser", tabs: await this.getVisualPseudoTabs(state) });
    }

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      const keys = args.keys.map((key) => normalizeBrowserKey(String(key)));
      await pressChromeMcpKey({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, key: keys.join("+") });
      const meta = await this.getChromeMcpPageMeta(state);
      return { ...this.buildResultMeta(state), pressed: true, keys, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      const keys = args.keys.map((key) => normalizeBrowserKey(String(key)));
      if (keys.length === 1) {
        await page.keyboard.press(keys[0]);
      } else {
        const modifiers = keys.slice(0, -1);
        const mainKey = keys[keys.length - 1];
        for (const key of modifiers) await page.keyboard.down(key);
        await page.keyboard.press(mainKey);
        for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
      }
      await settlePage(page);
      return { ...this.buildResultMeta(currentState), pressed: true, keys, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, { pressed: false });
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

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      if (args.selector) {
        await this.waitForChromeMcpSelector(state, args.selector, timeoutMs);
        const meta = await this.getChromeMcpPageMeta(state);
        return { ...this.buildResultMeta(state), matched: "selector", selector: args.selector, timeoutMs, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
      }
      if (args.text) {
        await waitForChromeMcpText({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, text: [args.text], timeoutMs });
        const meta = await this.getChromeMcpPageMeta(state);
        return { ...this.buildResultMeta(state), matched: "text", text: args.text, timeoutMs, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
      }
      await waitForMs(timeoutMs);
      const meta = await this.getChromeMcpPageMeta(state);
      return { ...this.buildResultMeta(state), matched: "timeout", timeoutMs, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      if (args.selector) {
        await page.locator(args.selector).first().waitFor({ state: "visible", timeout: timeoutMs });
        return { ...this.buildResultMeta(currentState), matched: "selector", selector: args.selector, timeoutMs, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
      }
      if (args.text) {
        await page.waitForFunction((text) => Boolean(document.body && document.body.innerText.includes(text)), args.text, { timeout: timeoutMs });
        return { ...this.buildResultMeta(currentState), matched: "text", text: args.text, timeoutMs, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
      }
      await page.waitForTimeout(timeoutMs);
      return { ...this.buildResultMeta(currentState), matched: "timeout", timeoutMs, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, { matched: args.selector ? "selector" : args.text ? "text" : "timeout", timeoutMs });
    }
    return result;
  }

  async scroll(sessionId: string, args: { x?: number; y?: number }) {
    const state = await this.getSession(sessionId);
    const x = typeof args.x === "number" ? args.x : 0;
    const y = typeof args.y === "number" ? args.y : 600;

    if (state.strategy === "visual") {
      await this.ensureVisualBrowser(state);
      await this.options.sidecar.execActions({ actions: [{ type: "scroll", scroll_x: x, scroll_y: y }] });
      return this.buildVisualFallbackResult(state, { scrolled: true, scroll: { x: 0, y: 0 } });
    }

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      const scroll = await evaluateChromeMcpScript({
        profileName: state.sessionProfile.name,
        userDataDir: state.sessionProfile.userDataDir,
        pageId: page.id,
        fn: `() => { window.scrollBy(${x}, ${y}); return { x: window.scrollX, y: window.scrollY }; }`,
      });
      const position = scroll && typeof scroll === "object" ? (scroll as Record<string, unknown>) : {};
      const meta = await this.getChromeMcpPageMeta(state);
      return {
        ...this.buildResultMeta(state),
        scrolled: true,
        scroll: { x: typeof position.x === "number" ? position.x : 0, y: typeof position.y === "number" ? position.y : 0 },
        title: meta.title,
        url: meta.url,
        tabs: await this.getChromeMcpTabs(state),
      };
    }

    const result = await this.withPlaywrightFallback(sessionId, state, async (page, currentState) => {
      await page.evaluate(({ scrollX, scrollY }) => { window.scrollBy(scrollX, scrollY); }, { scrollX: x, scrollY: y });
      const currentScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      return { ...this.buildResultMeta(currentState), scrolled: true, scroll: currentScroll, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, { scrolled: false });
    }
    return result;
  }

  async read(sessionId: string, args: { selector?: string; maxLength?: number } = {}) {
    const state = await this.getSession(sessionId);
    const maxLength = Math.max(200, Math.min(12000, Math.trunc(args.maxLength ?? 4000)));

    if (state.strategy === "visual") {
      return this.buildVisualFallbackResult(state, { text: "", title: state.browser.label, url: "visual-fallback://desktop-browser", tabs: await this.getVisualPseudoTabs(state) });
    }

    if (state.strategy === "chrome-mcp") {
      const page = await this.getChromeMcpPage(state);
      let textResult: unknown;
      if (args.selector) {
        textResult = await evaluateChromeMcpScript({
          profileName: state.sessionProfile.name,
          userDataDir: state.sessionProfile.userDataDir,
          pageId: page.id,
          args: [args.selector],
          fn: `(el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || "";
            return el instanceof HTMLElement ? (el.innerText || el.textContent || "") : "";
          }`,
        }).catch(async () =>
          evaluateChromeMcpScript({
            profileName: state.sessionProfile.name,
            userDataDir: state.sessionProfile.userDataDir,
            pageId: page.id,
            fn: `() => {
              const element = document.querySelector(${JSON.stringify(args.selector)});
              if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value || "";
              return element instanceof HTMLElement ? (element.innerText || element.textContent || "") : "";
            }`,
          }),
        );
      } else {
        textResult = await evaluateChromeMcpScript({ profileName: state.sessionProfile.name, userDataDir: state.sessionProfile.userDataDir, pageId: page.id, fn: "() => document.body?.innerText || ''" });
      }

      const normalized = typeof textResult === "string" ? textResult.replace(/\s+/g, " ").trim() : "";
      const meta = await this.getChromeMcpPageMeta(state);
      return { ...this.buildResultMeta(state), text: normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized, title: meta.title, url: meta.url, tabs: await this.getChromeMcpTabs(state) };
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
      return { ...this.buildResultMeta(currentState), text: normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized, title: await safePageTitle(page), url: page.url(), tabs: await this.getTabs(currentState) };
    });

    if ("sessionProfile" in result && result.strategy === "visual") {
      return this.buildVisualFallbackResult(result, { text: "" });
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
      if (state.strategy === "chrome-mcp") {
        await this.releaseChromeMcpProfile(state.sessionProfile.name);
      } else if (state.strategy === "visual") {
        if (state.processId) {
          await this.options.sidecar.killProcess({ pid: state.processId }).catch(() => undefined);
        }
      } else {
        await this.teardownPlaywrightState(state).catch(() => undefined);
      }
    } finally {
      if (state.strategy === "visual" && state.profile) {
        await this.syncRuntimeProfile(state.profile).catch(() => undefined);
        await this.cleanupRuntimeProfile(state.profile).catch(() => undefined);
      }
    }
  }

  async disposeAll() {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)));
  }
}

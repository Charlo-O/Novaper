import fs from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface BrowserInstall {
  key: "chrome" | "edge" | "brave";
  label: string;
  processName: string;
  executablePath: string;
  userDataRoot?: string;
}

export interface StoredProfileMetadata {
  version: number;
  browserKey: BrowserInstall["key"] | string;
  profileDirectory: string;
  sourceUserDataRoot?: string;
  importedAt: string;
  lastSyncedAt?: string;
  seededFromLocal: boolean;
}

export const PROFILE_METADATA_FILE = "profile.json";
export const EMBEDDED_BROWSER_PARTITION = "user_automation";

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

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDirectory(dirPath: string) {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath: string) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function copyFileBestEffort(sourcePath: string, destinationPath: string) {
  try {
    await ensureDirectory(path.dirname(destinationPath));
    await copyFile(sourcePath, destinationPath);
  } catch {
    // Ignore locked files from the user's active browser.
  }
}

export async function copyDirectoryBestEffort(sourceDir: string, destinationDir: string) {
  try {
    await ensureDirectory(destinationDir);
    const entries = await readdir(sourceDir, { withFileTypes: true });
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
    // Best-effort copy.
  }
}

export async function removeDirectoryContents(targetDir: string) {
  await rm(targetDir, { recursive: true, force: true });
  await ensureDirectory(targetDir);
}

export function detectPreferredProfileDirectory(userDataRoot?: string) {
  if (!userDataRoot) {
    return "Default";
  }

  const localStatePath = path.join(userDataRoot, "Local State");
  const localState = readJsonFile<Record<string, unknown>>(localStatePath);
  const profileRecord =
    typeof localState?.profile === "object" && localState.profile
      ? (localState.profile as Record<string, unknown>)
      : undefined;
  const lastUsed =
    typeof profileRecord?.last_used === "string"
      ? profileRecord.last_used.trim()
      : "";
  if (lastUsed) {
    return lastUsed;
  }

  const infoCache =
    typeof profileRecord?.info_cache === "object" && profileRecord.info_cache
      ? Object.keys(profileRecord.info_cache as Record<string, unknown>)
      : [];
  if (infoCache.length > 0) {
    return infoCache[0];
  }

  return "Default";
}

export function readStoredProfileMetadata(profileDir: string) {
  return readJsonFile<StoredProfileMetadata>(
    path.join(profileDir, PROFILE_METADATA_FILE)
  );
}

export async function writeStoredProfileMetadata(
  profileDir: string,
  metadata: StoredProfileMetadata
) {
  await ensureDirectory(profileDir);
  await writeFile(
    path.join(profileDir, PROFILE_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );
}

export async function seedStoredProfileFromSource(options: {
  browserKey: string;
  sourceUserDataRoot: string;
  profileDirectory: string;
  targetDir: string;
  importedAt?: string;
  lastSyncedAt?: string;
}) {
  const {
    browserKey,
    sourceUserDataRoot,
    profileDirectory,
    targetDir,
    importedAt,
    lastSyncedAt,
  } = options;

  await removeDirectoryContents(targetDir);

  const localStatePath = path.join(sourceUserDataRoot, "Local State");
  if (fs.existsSync(localStatePath)) {
    await copyFileBestEffort(localStatePath, path.join(targetDir, "Local State"));
  }

  const sourceProfileDir = path.join(sourceUserDataRoot, profileDirectory);
  if (fs.existsSync(sourceProfileDir)) {
    await copyDirectoryBestEffort(
      sourceProfileDir,
      path.join(targetDir, profileDirectory)
    );
  }

  await ensureDirectory(path.join(targetDir, profileDirectory));

  const metadata: StoredProfileMetadata = {
    version: 1,
    browserKey,
    profileDirectory,
    sourceUserDataRoot,
    importedAt: importedAt ?? nowIso(),
    lastSyncedAt: lastSyncedAt ?? nowIso(),
    seededFromLocal: true,
  };
  await writeStoredProfileMetadata(targetDir, metadata);
  return metadata;
}

export async function seedElectronSessionData(options: {
  sessionDataDir: string;
  profileDir: string;
  partitionName?: string;
}) {
  const partitionName = options.partitionName ?? EMBEDDED_BROWSER_PARTITION;
  const metadata = readStoredProfileMetadata(options.profileDir);
  if (!metadata) {
    await removeDirectoryContents(options.sessionDataDir);
    return null;
  }

  await removeDirectoryContents(options.sessionDataDir);

  const localStatePath = path.join(options.profileDir, "Local State");
  if (fs.existsSync(localStatePath)) {
    await copyFileBestEffort(
      localStatePath,
      path.join(options.sessionDataDir, "Local State")
    );
  }

  const partitionDir = path.join(
    options.sessionDataDir,
    "Partitions",
    partitionName
  );
  await copyDirectoryBestEffort(
    path.join(options.profileDir, metadata.profileDirectory),
    partitionDir
  );
  await ensureDirectory(partitionDir);

  return {
    metadata,
    partitionDir,
    sessionDataDir: options.sessionDataDir,
  };
}

export function findWindowsBrowserInstall(): BrowserInstall | null {
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["PROGRAMFILES(X86)"] ??
    process.env["ProgramFiles(x86)"] ??
    "C:\\Program Files (x86)";
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

  const installs: BrowserInstall[] = [
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "chrome",
      executablePath: path.join(
        programFiles,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe"
      ),
      userDataRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "chrome",
      executablePath: path.join(
        programFilesX86,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe"
      ),
      userDataRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      key: "chrome",
      label: "Google Chrome",
      processName: "chrome",
      executablePath: path.join(
        localAppData,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe"
      ),
      userDataRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      key: "edge",
      label: "Microsoft Edge",
      processName: "msedge",
      executablePath: path.join(
        programFiles,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe"
      ),
      userDataRoot: path.join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      key: "edge",
      label: "Microsoft Edge",
      processName: "msedge",
      executablePath: path.join(
        programFilesX86,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe"
      ),
      userDataRoot: path.join(localAppData, "Microsoft", "Edge", "User Data"),
    },
    {
      key: "brave",
      label: "Brave",
      processName: "brave",
      executablePath: path.join(
        programFiles,
        "BraveSoftware",
        "Brave-Browser",
        "Application",
        "brave.exe"
      ),
      userDataRoot: path.join(
        localAppData,
        "BraveSoftware",
        "Brave-Browser",
        "User Data"
      ),
    },
    {
      key: "brave",
      label: "Brave",
      processName: "brave",
      executablePath: path.join(
        localAppData,
        "BraveSoftware",
        "Brave-Browser",
        "Application",
        "brave.exe"
      ),
      userDataRoot: path.join(
        localAppData,
        "BraveSoftware",
        "Brave-Browser",
        "User Data"
      ),
    },
  ];

  for (const install of installs) {
    if (fs.existsSync(install.executablePath)) {
      return install;
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

export function findInstalledBrowser() {
  return process.platform === "win32"
    ? findWindowsBrowserInstall()
    : findPosixBrowserInstall();
}

export async function loadProfileMetadata(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as StoredProfileMetadata;
  } catch {
    return null;
  }
}

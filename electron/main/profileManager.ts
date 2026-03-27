import fs from "node:fs";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import {
  EMBEDDED_BROWSER_PARTITION,
  PROFILE_METADATA_FILE,
  detectPreferredProfileDirectory,
  findInstalledBrowser,
  nowIso,
  pathExists,
  readStoredProfileMetadata,
  sanitizeName,
  seedElectronSessionData,
  seedStoredProfileFromSource,
  type StoredProfileMetadata,
} from "./chromiumProfile.js";

interface BrowserProfile {
  active: boolean;
  browserKey: string;
  importedAt: string;
  lastSyncedAt?: string;
  name: string;
  path: string;
  profileDirectory: string;
  profileName: string;
  seededFromLocal: boolean;
  sourceUserDataRoot?: string;
}

interface ImportedProfileInfo {
  metadata: StoredProfileMetadata;
  path: string;
  profileName: string;
}

export class ProfileManager {
  private readonly profilesDir: string;

  private readonly sessionDataDir: string;

  private readonly stateFile: string;

  constructor(rootDir: string) {
    this.profilesDir = path.join(rootDir, "browser-profiles");
    this.sessionDataDir = path.join(rootDir, "electron-session-data");
    this.stateFile = path.join(this.profilesDir, "active-profile.json");
  }

  getSessionDataDir() {
    return this.sessionDataDir;
  }

  async listProfiles() {
    await mkdir(this.profilesDir, { recursive: true });
    const activeProfile = await this.readActiveProfile();
    const entries = await readdir(this.profilesDir, { withFileTypes: true });

    const profiles: BrowserProfile[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const profilePath = path.join(this.profilesDir, entry.name);
      const metadata = readStoredProfileMetadata(profilePath);
      if (!metadata) {
        continue;
      }

      profiles.push({
        active: entry.name === activeProfile,
        browserKey: metadata.browserKey,
        importedAt: metadata.importedAt,
        lastSyncedAt: metadata.lastSyncedAt,
        name: entry.name,
        path: profilePath,
        profileDirectory: metadata.profileDirectory,
        profileName: entry.name,
        seededFromLocal: metadata.seededFromLocal,
        sourceUserDataRoot: metadata.sourceUserDataRoot,
      });
    }

    return profiles.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
    );
  }

  async importProfile(browserKey: string, profileDir: string) {
    await mkdir(this.profilesDir, { recursive: true });

    const resolvedProfileDir = path.resolve(profileDir);
    const localStateAtSelectedPath = await pathExists(
      path.join(resolvedProfileDir, "Local State")
    );

    const sourceUserDataRoot = localStateAtSelectedPath
      ? resolvedProfileDir
      : path.dirname(resolvedProfileDir);
    const profileDirectory = localStateAtSelectedPath
      ? detectPreferredProfileDirectory(sourceUserDataRoot)
      : path.basename(resolvedProfileDir);

    const folderName = `${sanitizeName(
      browserKey || "custom"
    )}--${sanitizeName(profileDirectory || "profile")}`;
    const targetDir = path.join(this.profilesDir, folderName);

    await seedStoredProfileFromSource({
      browserKey: browserKey || "custom",
      sourceUserDataRoot,
      profileDirectory,
      targetDir,
      importedAt: nowIso(),
    });

    if (!(await this.readActiveProfile())) {
      await this.switchProfile(folderName);
    }

    return { profileName: folderName, restartRequired: true, success: true };
  }

  async switchProfile(profileName: string) {
    await mkdir(this.profilesDir, { recursive: true });
    await writeFile(
      this.stateFile,
      JSON.stringify({ activeProfile: profileName }, null, 2),
      "utf8"
    );
    return { profileName, restartRequired: true, success: true };
  }

  async prepareSessionData() {
    const activeProfile = await this.ensureActiveProfile();
    if (!activeProfile) {
      await mkdir(this.sessionDataDir, { recursive: true });
      return {
        activeProfile: null,
        partitionName: EMBEDDED_BROWSER_PARTITION,
        sessionDataDir: this.sessionDataDir,
      };
    }

    if (
      activeProfile.metadata.seededFromLocal &&
      activeProfile.metadata.sourceUserDataRoot
    ) {
      await this.refreshStoredProfile(activeProfile);
    }

    await seedElectronSessionData({
      sessionDataDir: this.sessionDataDir,
      profileDir: activeProfile.path,
      partitionName: EMBEDDED_BROWSER_PARTITION,
    });

    const sourceCookiesPath = activeProfile.metadata.sourceUserDataRoot
      ? path.join(
          activeProfile.metadata.sourceUserDataRoot,
          activeProfile.metadata.profileDirectory,
          "Network",
          "Cookies"
        )
      : null;
    const storedCookiesPath = path.join(
      activeProfile.path,
      activeProfile.metadata.profileDirectory,
      "Network",
      "Cookies"
    );
    const partitionCookiesPath = path.join(
      this.sessionDataDir,
      "Partitions",
      EMBEDDED_BROWSER_PARTITION,
      "Network",
      "Cookies"
    );

    return {
      activeProfile: activeProfile.profileName,
      cookies: {
        partitionHasCookies: fs.existsSync(partitionCookiesPath),
        sourceHadCookies: sourceCookiesPath ? fs.existsSync(sourceCookiesPath) : false,
        storedProfileHasCookies: fs.existsSync(storedCookiesPath),
      },
      partitionName: EMBEDDED_BROWSER_PARTITION,
      profileDirectory: activeProfile.metadata.profileDirectory,
      sessionDataDir: this.sessionDataDir,
    };
  }

  private async ensureActiveProfile(): Promise<ImportedProfileInfo | null> {
    await mkdir(this.profilesDir, { recursive: true });

    let activeProfileName = await this.readActiveProfile();
    if (!activeProfileName) {
      const bootstrapped = await this.bootstrapLocalBrowserProfile();
      activeProfileName = bootstrapped?.profileName ?? null;
      if (activeProfileName) {
        await this.switchProfile(activeProfileName);
      }
    }

    if (!activeProfileName) {
      return null;
    }

    return this.getImportedProfile(activeProfileName);
  }

  private async bootstrapLocalBrowserProfile() {
    const browser = findInstalledBrowser();
    if (!browser?.userDataRoot) {
      return null;
    }

    const profileDirectory = detectPreferredProfileDirectory(
      browser.userDataRoot
    );
    const folderName = `${sanitizeName(browser.key)}--${sanitizeName(
      profileDirectory
    )}`;
    const targetDir = path.join(this.profilesDir, folderName);

    await seedStoredProfileFromSource({
      browserKey: browser.key,
      sourceUserDataRoot: browser.userDataRoot,
      profileDirectory,
      targetDir,
      importedAt: nowIso(),
    });

    return { path: targetDir, profileName: folderName };
  }

  private async getImportedProfile(
    profileName: string
  ): Promise<ImportedProfileInfo | null> {
    const profilePath = path.join(this.profilesDir, profileName);
    const metadata = readStoredProfileMetadata(profilePath);
    if (!metadata) {
      return null;
    }

    return {
      metadata,
      path: profilePath,
      profileName,
    };
  }

  private async refreshStoredProfile(profile: ImportedProfileInfo) {
    const sourceUserDataRoot = profile.metadata.sourceUserDataRoot;
    if (!sourceUserDataRoot) {
      return;
    }

    await seedStoredProfileFromSource({
      browserKey: profile.metadata.browserKey,
      sourceUserDataRoot,
      profileDirectory: profile.metadata.profileDirectory,
      targetDir: profile.path,
      importedAt: profile.metadata.importedAt,
      lastSyncedAt: nowIso(),
    });
  }

  private async readActiveProfile() {
    try {
      const content = await readFile(this.stateFile, "utf8");
      const state = JSON.parse(content) as { activeProfile?: string };
      return state.activeProfile ?? null;
    } catch {
      return null;
    }
  }
}

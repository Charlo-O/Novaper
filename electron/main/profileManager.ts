import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface BrowserProfile {
  browserKey: string;
  importedAt: string;
  name: string;
  path: string;
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export class ProfileManager {
  private readonly profilesDir: string;

  private readonly stateFile: string;

  constructor(rootDir: string) {
    this.profilesDir = path.join(rootDir, "browser-profiles");
    this.stateFile = path.join(this.profilesDir, "active-profile.json");
  }

  async listProfiles() {
    await mkdir(this.profilesDir, { recursive: true });
    const activeProfile = await this.readActiveProfile();
    const entries = await readdir(this.profilesDir, { withFileTypes: true });

    const profiles = entries
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const [browserKey = "custom", ...rest] = entry.name.split("--");
        return {
          active: entry.name === activeProfile,
          browserKey,
          name: rest.length > 0 ? rest.join("--") : entry.name,
          path: path.join(this.profilesDir, entry.name),
          profileName: entry.name,
        };
      });

    return profiles.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  async importProfile(browserKey: string, profileDir: string) {
    await mkdir(this.profilesDir, { recursive: true });

    const folderName = `${sanitizeName(browserKey || "custom")}--${sanitizeName(path.basename(profileDir) || "profile")}`;
    const targetDir = path.join(this.profilesDir, folderName);

    await cp(profileDir, targetDir, {
      errorOnExist: false,
      force: true,
      recursive: true,
    });

    const profile: BrowserProfile = {
      browserKey: browserKey || "custom",
      importedAt: new Date().toISOString(),
      name: folderName,
      path: targetDir,
    };

    await writeFile(
      path.join(targetDir, "profile.json"),
      JSON.stringify(profile, null, 2),
      "utf8"
    );

    if (!(await this.readActiveProfile())) {
      await this.switchProfile(folderName);
    }

    return { profileName: folderName, success: true };
  }

  async switchProfile(profileName: string) {
    await mkdir(this.profilesDir, { recursive: true });
    await writeFile(
      this.stateFile,
      JSON.stringify({ activeProfile: profileName }, null, 2),
      "utf8"
    );
    return { profileName, success: true };
  }

  private async readActiveProfile() {
    try {
      const content = await readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(content) as { activeProfile?: string };
      return parsed.activeProfile ?? null;
    } catch {
      return null;
    }
  }
}

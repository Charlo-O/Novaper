import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryEntry, AppProfile, ConsolidationRecord } from "./types.js";

/** JSON file persistence layer for the memory system */
export class MemoryStore {
  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, "apps"), { recursive: true });
    await fs.mkdir(path.join(this.rootDir, "sessions"), { recursive: true });
  }

  // ─── Global Memories ──────────────────────────────────────────────

  async loadGlobal(): Promise<MemoryEntry[]> {
    return this.readJson<MemoryEntry[]>(path.join(this.rootDir, "global.json"), []);
  }

  async saveGlobal(entries: MemoryEntry[]): Promise<void> {
    await this.writeJson(path.join(this.rootDir, "global.json"), entries);
  }

  // ─── App Profiles ─────────────────────────────────────────────────

  async loadAppProfile(appName: string): Promise<AppProfile | null> {
    const safeName = this.safeFilename(appName);
    return this.readJson<AppProfile | null>(
      path.join(this.rootDir, "apps", `${safeName}.json`),
      null,
    );
  }

  async saveAppProfile(profile: AppProfile): Promise<void> {
    const safeName = this.safeFilename(profile.appName);
    await this.writeJson(path.join(this.rootDir, "apps", `${safeName}.json`), profile);
  }

  async listAppProfiles(): Promise<AppProfile[]> {
    const profiles: AppProfile[] = [];
    let files: string[];
    try {
      files = await fs.readdir(path.join(this.rootDir, "apps"));
    } catch {
      return [];
    }
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const profile = await this.readJson<AppProfile | null>(
        path.join(this.rootDir, "apps", file),
        null,
      );
      if (profile) profiles.push(profile);
    }
    return profiles;
  }

  // ─── Session Snapshots ────────────────────────────────────────────

  async loadSession(sessionId: string): Promise<MemoryEntry[]> {
    return this.readJson<MemoryEntry[]>(
      path.join(this.rootDir, "sessions", `${sessionId}.json`),
      [],
    );
  }

  async saveSession(sessionId: string, entries: MemoryEntry[]): Promise<void> {
    await this.writeJson(
      path.join(this.rootDir, "sessions", `${sessionId}.json`),
      entries,
    );
  }

  // ─── Consolidation Records ──────────────────────────────────────────

  async loadConsolidations(): Promise<ConsolidationRecord[]> {
    return this.readJson<ConsolidationRecord[]>(
      path.join(this.rootDir, "consolidations.json"),
      [],
    );
  }

  async saveConsolidations(records: ConsolidationRecord[]): Promise<void> {
    await this.writeJson(path.join(this.rootDir, "consolidations.json"), records);
  }

  async appendConsolidation(record: ConsolidationRecord): Promise<void> {
    const records = await this.loadConsolidations();
    records.push(record);
    await this.saveConsolidations(records);
  }

  // ─── Generic Helpers ──────────────────────────────────────────────

  async findById(id: string): Promise<{ entry: MemoryEntry; location: string } | null> {
    // Search global
    const globals = await this.loadGlobal();
    const gi = globals.findIndex((e) => e.id === id);
    if (gi >= 0) return { entry: globals[gi], location: "global" };

    // Search app profiles
    const profiles = await this.listAppProfiles();
    for (const profile of profiles) {
      const ai = profile.memories.findIndex((e) => e.id === id);
      if (ai >= 0) return { entry: profile.memories[ai], location: `app:${profile.appName}` };
    }
    return null;
  }

  async deleteById(id: string): Promise<boolean> {
    // Try global
    const globals = await this.loadGlobal();
    const gi = globals.findIndex((e) => e.id === id);
    if (gi >= 0) {
      globals.splice(gi, 1);
      await this.saveGlobal(globals);
      return true;
    }

    // Try app profiles
    const profiles = await this.listAppProfiles();
    for (const profile of profiles) {
      const ai = profile.memories.findIndex((e) => e.id === id);
      if (ai >= 0) {
        profile.memories.splice(ai, 1);
        await this.saveAppProfile(profile);
        return true;
      }
    }
    return false;
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private safeFilename(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  }
}

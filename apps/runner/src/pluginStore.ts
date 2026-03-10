import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import unzipper from "unzipper";
import type {
  SkillRepo,
  DiscoverableSkill,
  InstalledSkill,
  McpServerConfig,
} from "../../../packages/runner-core/src/pluginTypes.js";
import { DEFAULT_SKILL_REPOS } from "../../../packages/runner-core/src/pluginTypes.js";

// ---------------------------------------------------------------------------
// YAML front-matter parser (lightweight, no dependency)
// ---------------------------------------------------------------------------

function parseSkillMdFrontMatter(raw: string): { name: string; description: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: raw.trim() };

  const yaml = match[1];
  const body = match[2].trim();
  let name = "";
  let description = "";

  for (const line of yaml.split(/\r?\n/)) {
    const nameMatch = line.match(/^\s*name\s*:\s*(.+)/);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    const descMatch = line.match(/^\s*description\s*:\s*(.+)/);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return { name, description, body };
}

// ---------------------------------------------------------------------------
// PluginStore
// ---------------------------------------------------------------------------

export class PluginStore {
  private readonly pluginsDir: string;
  private readonly reposPath: string;
  private readonly installedSkillsPath: string;
  private readonly mcpServersPath: string;

  // In-memory cache for discovered skills (avoids hitting GitHub API rate limits)
  private discoveryCache: { skills: DiscoverableSkill[]; errors: string[]; timestamp: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly rootDir: string) {
    this.pluginsDir = path.join(rootDir, "data", "plugins");
    this.reposPath = path.join(this.pluginsDir, "skill-repos.json");
    this.installedSkillsPath = path.join(this.pluginsDir, "installed-skills.json");
    this.mcpServersPath = path.join(this.pluginsDir, "mcp-servers.json");
  }

  private async ensureDir() {
    await fs.mkdir(this.pluginsDir, { recursive: true });
  }

  private async readJson<T>(filePath: string): Promise<T[]> {
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as T[];
    } catch {
      return [];
    }
  }

  private async writeJson<T>(filePath: string, data: T[]) {
    await this.ensureDir();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // =========================================================================
  // Skill Repos
  // =========================================================================

  async listRepos(): Promise<SkillRepo[]> {
    const repos = await this.readJson<SkillRepo>(this.reposPath);
    if (repos.length === 0) {
      // Seed defaults on first access
      await this.writeJson(this.reposPath, DEFAULT_SKILL_REPOS);
      return [...DEFAULT_SKILL_REPOS];
    }
    return repos;
  }

  async addRepo(repo: SkillRepo): Promise<SkillRepo> {
    const repos = await this.listRepos();
    const exists = repos.find((r) => r.owner === repo.owner && r.name === repo.name);
    if (exists) throw new Error(`Repo ${repo.owner}/${repo.name} already exists.`);
    repos.push(repo);
    await this.writeJson(this.reposPath, repos);
    return repo;
  }

  async updateRepo(owner: string, name: string, updates: Partial<Pick<SkillRepo, "branch" | "enabled">>): Promise<SkillRepo | null> {
    const repos = await this.listRepos();
    const idx = repos.findIndex((r) => r.owner === owner && r.name === name);
    if (idx === -1) return null;
    repos[idx] = { ...repos[idx], ...updates };
    await this.writeJson(this.reposPath, repos);
    return repos[idx];
  }

  async deleteRepo(owner: string, name: string): Promise<boolean> {
    const repos = await this.listRepos();
    const filtered = repos.filter((r) => !(r.owner === owner && r.name === name));
    if (filtered.length === repos.length) return false;
    await this.writeJson(this.reposPath, filtered);
    return true;
  }

  // =========================================================================
  // Skill Discovery — download repo ZIP and scan for SKILL.md files
  // (matches cc-switch approach: 1 request per repo, no API rate limits)
  // =========================================================================

  async discoverSkills(forceRefresh = false): Promise<{ skills: DiscoverableSkill[]; errors: string[] }> {
    // Return cached results if available and not expired
    if (!forceRefresh && this.discoveryCache && Date.now() - this.discoveryCache.timestamp < this.CACHE_TTL) {
      console.log(`[PluginStore] Returning cached discovery results (${this.discoveryCache.skills.length} skills)`);
      return { skills: this.discoveryCache.skills, errors: this.discoveryCache.errors };
    }

    const repos = await this.listRepos();
    const enabled = repos.filter((r) => r.enabled);

    console.log(`[PluginStore] Discovering skills from ${enabled.length} enabled repos (ZIP download)...`);

    // Fetch all repos in parallel (like cc-switch)
    const settled = await Promise.allSettled(enabled.map((repo) => this.discoverFromRepo(repo)));

    const results: DiscoverableSkill[] = [];
    const errors: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const repo = enabled[i];
      if (outcome.status === "fulfilled") {
        console.log(`[PluginStore] ${repo.owner}/${repo.name}: found ${outcome.value.length} skills`);
        results.push(...outcome.value);
      } else {
        const msg = `${repo.owner}/${repo.name}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`;
        console.error(`[PluginStore] Error discovering:`, msg);
        errors.push(msg);
      }
    }

    console.log(`[PluginStore] Total discovered: ${results.length} skills, ${errors.length} errors`);
    this.discoveryCache = { skills: results, errors, timestamp: Date.now() };
    return { skills: results, errors };
  }

  private async discoverFromRepo(repo: SkillRepo): Promise<DiscoverableSkill[]> {
    // Try branches in order: specified branch, then fallback to main, then master
    const branches = [repo.branch];
    if (repo.branch !== "main") branches.push("main");
    if (repo.branch !== "master") branches.push("master");

    let zipBuffer: Buffer | null = null;
    let usedBranch = repo.branch;

    for (const branch of branches) {
      const zipUrl = `https://github.com/${repo.owner}/${repo.name}/archive/refs/heads/${branch}.zip`;
      console.log(`[PluginStore] Downloading ZIP: ${zipUrl}`);
      try {
        const res = await fetch(zipUrl, {
          headers: { "User-Agent": "Novaper" },
          signal: AbortSignal.timeout(60000),
          redirect: "follow",
        });
        if (res.ok) {
          zipBuffer = Buffer.from(await res.arrayBuffer());
          usedBranch = branch;
          console.log(`[PluginStore] ${repo.owner}/${repo.name}: downloaded ${(zipBuffer.length / 1024).toFixed(0)} KB (branch: ${branch})`);
          break;
        }
        console.warn(`[PluginStore] ${repo.owner}/${repo.name} branch "${branch}": HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[PluginStore] ${repo.owner}/${repo.name} branch "${branch}" fetch error:`, err instanceof Error ? err.message : err);
      }
    }

    if (!zipBuffer) {
      throw new Error(`Failed to download any branch (tried: ${branches.join(", ")})`);
    }

    // Parse ZIP in memory and find SKILL.md files
    const directory = await unzipper.Open.buffer(zipBuffer);
    const skills: DiscoverableSkill[] = [];

    // ZIP entries have a root folder like "repo-name-branch/"
    const skillFiles = directory.files.filter(
      (f) => !f.type || f.type === "File" ? f.path.endsWith("/SKILL.md") || f.path === "SKILL.md" : false
    );

    console.log(`[PluginStore] ${repo.owner}/${repo.name}: found ${skillFiles.length} SKILL.md files in ZIP`);

    for (const file of skillFiles) {
      try {
        const content = (await file.buffer()).toString("utf-8");
        const { name, description } = parseSkillMdFrontMatter(content);

        // Strip the ZIP root folder prefix (e.g. "skills-main/some/path/SKILL.md" → "some/path")
        let relativePath = file.path;
        const slashIdx = relativePath.indexOf("/");
        if (slashIdx !== -1) {
          relativePath = relativePath.substring(slashIdx + 1);
        }
        // Get directory (parent of SKILL.md)
        const skillDir = relativePath.includes("/")
          ? relativePath.substring(0, relativePath.lastIndexOf("/"))
          : ".";

        const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${usedBranch}/${relativePath}`;

        skills.push({
          key: `${repo.owner}/${repo.name}:${skillDir}`,
          name: name || skillDir,
          description: description || "",
          directory: skillDir,
          readmeUrl: rawUrl,
          repoOwner: repo.owner,
          repoName: repo.name,
          repoBranch: usedBranch,
        });
      } catch (err) {
        console.error(`[PluginStore] Error parsing ${file.path}:`, err);
      }
    }

    return skills;
  }

  // =========================================================================
  // Installed Skills
  // =========================================================================

  async listInstalledSkills(): Promise<InstalledSkill[]> {
    return this.readJson<InstalledSkill>(this.installedSkillsPath);
  }

  async installSkill(skill: DiscoverableSkill): Promise<InstalledSkill> {
    const installed = await this.listInstalledSkills();
    const existing = installed.find((s) => s.id === skill.key);
    if (existing) throw new Error(`Skill "${skill.name}" is already installed.`);

    // Download the SKILL.md content
    const res = await fetch(skill.readmeUrl, { headers: { "User-Agent": "Novaper" } });
    if (!res.ok) throw new Error(`Failed to download skill: HTTP ${res.status}`);
    const rawContent = await res.text();
    const { body } = parseSkillMdFrontMatter(rawContent);

    const entry: InstalledSkill = {
      id: skill.key,
      name: skill.name,
      description: skill.description,
      directory: skill.directory,
      content: body || rawContent,
      repoOwner: skill.repoOwner,
      repoName: skill.repoName,
      repoBranch: skill.repoBranch,
      readmeUrl: skill.readmeUrl,
      enabled: true,
      installedAt: Date.now(),
    };

    installed.push(entry);
    await this.writeJson(this.installedSkillsPath, installed);
    return entry;
  }

  async createLocalSkill(input: { name: string; description: string; content: string }): Promise<InstalledSkill> {
    const installed = await this.listInstalledSkills();
    const entry: InstalledSkill = {
      id: `local:${crypto.randomUUID()}`,
      name: input.name,
      description: input.description,
      directory: "",
      content: input.content,
      enabled: true,
      installedAt: Date.now(),
    };
    installed.push(entry);
    await this.writeJson(this.installedSkillsPath, installed);
    return entry;
  }

  async updateInstalledSkill(id: string, updates: Partial<Pick<InstalledSkill, "enabled" | "name" | "description" | "content">>): Promise<InstalledSkill | null> {
    const installed = await this.listInstalledSkills();
    const idx = installed.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    installed[idx] = { ...installed[idx], ...updates };
    await this.writeJson(this.installedSkillsPath, installed);
    return installed[idx];
  }

  async uninstallSkill(id: string): Promise<boolean> {
    const installed = await this.listInstalledSkills();
    const filtered = installed.filter((s) => s.id !== id);
    if (filtered.length === installed.length) return false;
    await this.writeJson(this.installedSkillsPath, filtered);
    return true;
  }

  async getEnabledSkills(): Promise<InstalledSkill[]> {
    const installed = await this.listInstalledSkills();
    return installed.filter((s) => s.enabled);
  }

  // =========================================================================
  // MCP Servers
  // =========================================================================

  async listMcpServers(): Promise<McpServerConfig[]> {
    return this.readJson<McpServerConfig>(this.mcpServersPath);
  }

  async createMcpServer(input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">): Promise<McpServerConfig> {
    const servers = await this.listMcpServers();
    const now = Date.now();
    const server: McpServerConfig = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    servers.push(server);
    await this.writeJson(this.mcpServersPath, servers);
    return server;
  }

  async updateMcpServer(id: string, updates: Partial<Omit<McpServerConfig, "id" | "createdAt">>): Promise<McpServerConfig | null> {
    const servers = await this.listMcpServers();
    const index = servers.findIndex((s) => s.id === id);
    if (index === -1) return null;
    servers[index] = { ...servers[index], ...updates, updatedAt: Date.now() };
    await this.writeJson(this.mcpServersPath, servers);
    return servers[index];
  }

  async deleteMcpServer(id: string): Promise<boolean> {
    const servers = await this.listMcpServers();
    const filtered = servers.filter((s) => s.id !== id);
    if (filtered.length === servers.length) return false;
    await this.writeJson(this.mcpServersPath, filtered);
    return true;
  }
}

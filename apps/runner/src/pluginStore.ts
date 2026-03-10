import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  // Skill Discovery — scan enabled repos via GitHub API
  // =========================================================================

  async discoverSkills(forceRefresh = false): Promise<{ skills: DiscoverableSkill[]; errors: string[] }> {
    // Return cached results if available and not expired
    if (!forceRefresh && this.discoveryCache && Date.now() - this.discoveryCache.timestamp < this.CACHE_TTL) {
      console.log(`[PluginStore] Returning cached discovery results (${this.discoveryCache.skills.length} skills)`);
      return { skills: this.discoveryCache.skills, errors: this.discoveryCache.errors };
    }

    const repos = await this.listRepos();
    const enabled = repos.filter((r) => r.enabled);
    const results: DiscoverableSkill[] = [];
    const errors: string[] = [];

    console.log(`[PluginStore] Discovering skills from ${enabled.length} enabled repos...`);

    for (const repo of enabled) {
      try {
        const skills = await this.discoverFromRepo(repo);
        console.log(`[PluginStore] ${repo.owner}/${repo.name}: found ${skills.length} skills`);
        results.push(...skills);
      } catch (err) {
        const msg = `${repo.owner}/${repo.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[PluginStore] Error discovering:`, msg);
        errors.push(msg);
      }
    }

    console.log(`[PluginStore] Total discovered: ${results.length} skills, ${errors.length} errors`);
    this.discoveryCache = { skills: results, errors, timestamp: Date.now() };
    return { skills: results, errors };
  }

  private async discoverFromRepo(repo: SkillRepo): Promise<DiscoverableSkill[]> {
    // Use GitHub API to get the repo tree
    const treeUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${repo.branch}?recursive=1`;
    console.log(`[PluginStore] Fetching tree: ${treeUrl}`);
    const res = await fetch(treeUrl, {
      headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Novaper" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const errMsg = `GitHub API ${res.status}: ${body.substring(0, 200)}`;
      console.error(`[PluginStore] Tree API failed for ${repo.owner}/${repo.name}: ${errMsg}`);
      throw new Error(errMsg);
    }

    const data = (await res.json()) as { tree?: Array<{ path: string; type: string }> };
    if (!data.tree) {
      console.error(`[PluginStore] No tree in response for ${repo.owner}/${repo.name}`);
      return [];
    }

    // Find all SKILL.md files
    const skillMdPaths = data.tree
      .filter((entry) => entry.type === "blob" && entry.path.endsWith("SKILL.md"))
      .map((entry) => entry.path);

    console.log(`[PluginStore] ${repo.owner}/${repo.name}: found ${skillMdPaths.length} SKILL.md files`);

    const skills: DiscoverableSkill[] = [];

    for (const mdPath of skillMdPaths) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.branch}/${mdPath}`;
        const rawRes = await fetch(rawUrl, { headers: { "User-Agent": "Novaper" }, signal: AbortSignal.timeout(10000) });
        if (!rawRes.ok) {
          console.warn(`[PluginStore] Failed to fetch ${rawUrl}: ${rawRes.status}`);
          continue;
        }

        const rawText = await rawRes.text();
        const { name, description } = parseSkillMdFrontMatter(rawText);

        // directory = parent path of SKILL.md (or repo root)
        const directory = mdPath.includes("/") ? mdPath.substring(0, mdPath.lastIndexOf("/")) : ".";

        skills.push({
          key: `${repo.owner}/${repo.name}:${directory}`,
          name: name || directory,
          description: description || "",
          directory,
          readmeUrl: rawUrl,
          repoOwner: repo.owner,
          repoName: repo.name,
          repoBranch: repo.branch,
        });
      } catch (err) {
        console.error(`[PluginStore] Error fetching skill ${mdPath}:`, err);
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

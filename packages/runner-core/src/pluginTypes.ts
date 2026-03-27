// ---------------------------------------------------------------------------
// Skill Repositories — GitHub repos that contain discoverable skills
// ---------------------------------------------------------------------------

export interface SkillRepo {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Discoverable Skills — found by scanning repos for SKILL.md files
// ---------------------------------------------------------------------------

export interface DiscoverableSkill {
  key: string;            // "owner/repo:directory"
  name: string;
  description: string;
  directory: string;      // relative path inside the repo
  readmeUrl: string;      // raw GitHub URL to SKILL.md
  repoOwner: string;
  repoName: string;
  repoBranch: string;
}

// ---------------------------------------------------------------------------
// Installed Skills — skills downloaded to the local data dir
// ---------------------------------------------------------------------------

export interface InstalledSkill {
  id: string;             // "owner/repo:directory" or "local:<uuid>"
  name: string;
  description: string;
  directory: string;      // subdirectory name in local storage
  content: string;        // full SKILL.md body (prompt text)
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
  enabled: boolean;
  installedAt: number;
}

// ---------------------------------------------------------------------------
// MCP Server Config
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  builtin?: boolean;
  fixed?: boolean;
  createdAt: number;
  updatedAt: number;
}

export const BUILTIN_BROWSER_MCP_SERVER_ID = 'builtin:browser-control';

export const BUILTIN_BROWSER_MCP_SERVER: McpServerConfig = {
  id: BUILTIN_BROWSER_MCP_SERVER_ID,
  name: 'chrome-devtools-mcp',
  description: 'Built-in browser control MCP used by Novaper for existing browser sessions.',
  type: 'stdio',
  command: 'npx',
  args: [
    '-y',
    'chrome-devtools-mcp@latest',
    '--autoConnect',
    '--experimentalStructuredContent',
    '--experimental-page-id-routing',
  ],
  enabled: true,
  builtin: true,
  fixed: true,
  createdAt: 0,
  updatedAt: 0,
};

export const BUILTIN_FIXED_MCP_SERVERS: McpServerConfig[] = [BUILTIN_BROWSER_MCP_SERVER];

export function isBuiltinFixedMcpServerId(id: string): boolean {
  return BUILTIN_FIXED_MCP_SERVERS.some((server) => server.id === id);
}

// ---------------------------------------------------------------------------
// Default skill repos (same as cc-switch)
// ---------------------------------------------------------------------------

export const DEFAULT_SKILL_REPOS: SkillRepo[] = [
  { owner: 'anthropics', name: 'skills', branch: 'main', enabled: true },
  { owner: 'ComposioHQ', name: 'awesome-claude-skills', branch: 'master', enabled: true },
  { owner: 'cexll', name: 'myclaude', branch: 'master', enabled: true },
  { owner: 'JimLiu', name: 'baoyu-skills', branch: 'main', enabled: true },
];

// ---------------------------------------------------------------------------
// Default MCP server presets (same as cc-switch)
// ---------------------------------------------------------------------------

export const DEFAULT_MCP_PRESETS: Array<Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'mcp-server-fetch',
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    enabled: false,
  },
  {
    name: '@modelcontextprotocol/server-time',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    enabled: false,
  },
  {
    name: '@modelcontextprotocol/server-memory',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    enabled: false,
  },
  {
    name: '@modelcontextprotocol/server-sequential-thinking',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    enabled: false,
  },
  {
    name: '@upstash/context7-mcp',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    enabled: false,
  },
];

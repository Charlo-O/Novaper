import type { InstalledSkill, McpServerConfig } from "./pluginTypes.js";

export type CapabilitySource = "builtin" | "skill" | "mcp";
export type CapabilityStatus = "active" | "configured";

export interface CapabilityItem {
  id: string;
  title: string;
  description: string;
  source: CapabilitySource;
  status: CapabilityStatus;
  route: "desktop" | "cli" | "planner" | "shared";
  notes?: string[];
}

export interface CapabilitySection {
  id: string;
  title: string;
  description: string;
  items: CapabilityItem[];
}

export interface CapabilitySnapshot {
  generatedAt: string;
  summary: {
    builtInCount: number;
    activeSkillCount: number;
    enabledMcpCount: number;
    routes: Array<"desktop" | "cli" | "planner">;
  };
  sections: CapabilitySection[];
}

export interface PromptSkill {
  name: string;
  content: string;
  description?: string;
}

function trimDescription(value: string | undefined, fallback: string) {
  const text = value?.trim();
  return text && text.length > 0 ? text : fallback;
}

export function buildCapabilitySnapshot(input: {
  enabledSkills?: Array<Pick<InstalledSkill, "id" | "name" | "description" | "content">>;
  mcpServers?: Array<Pick<McpServerConfig, "id" | "name" | "type" | "enabled">>;
}): CapabilitySnapshot {
  const enabledSkills = input.enabledSkills ?? [];
  const enabledMcpServers = (input.mcpServers ?? []).filter((server) => server.enabled);

  const executionSection: CapabilitySection = {
    id: "execution",
    title: "Execution Surfaces",
    description: "The local routes that can take work right now.",
    items: [
      {
        id: "desktop-operator",
        title: "Live Desktop Operator",
        description:
          "Observes the current Windows desktop, executes browser and native desktop tools, and verifies results with screenshots.",
        source: "builtin",
        status: "active",
        route: "desktop",
        notes: [
          "Prefers browser_* tools on Chromium pages before UI Automation or coordinate fallback.",
          "Can work with screenshots, windows, processes, files, and desktop actions.",
        ],
      },
      {
        id: "cli-agent",
        title: "CLI Coding Agent",
        description:
          "Handles shell, file inspection, and code editing style tasks with structured CLI tools.",
        source: "builtin",
        status: "active",
        route: "cli",
        notes: [
          "Uses read, grep, ls, find, edit, write, and bash style tools.",
          "Best for repository inspection, command execution, and file changes.",
        ],
      },
      {
        id: "planner",
        title: "Layered Task Planner",
        description:
          "Breaks complex instructions into desktop and CLI subtasks, then executes them sequentially.",
        source: "builtin",
        status: "active",
        route: "planner",
        notes: [
          "Chooses between GUI work and CLI work per subtask.",
          "Keeps a single coherent session history while running multiple steps.",
        ],
      },
    ],
  };

  const operatorSection: CapabilitySection = {
    id: "operator-stack",
    title: "Local Operator Stack",
    description: "Shared services that back every route.",
    items: [
      {
        id: "browser-runtime",
        title: "Managed Browser Runtime",
        description:
          "Runs Chromium automation with persisted profile state and DOM-aware browser_* tools.",
        source: "builtin",
        status: "active",
        route: "desktop",
        notes: [
          "Supports browser_open, browser_snapshot, browser_click, browser_type, browser_tabs, and related tools.",
        ],
      },
      {
        id: "memory",
        title: "Working and Long-Term Memory",
        description:
          "Injects app-aware context into live sessions and persists durable memories after tasks complete.",
        source: "builtin",
        status: "active",
        route: "shared",
        notes: [
          "Memory is built from windows, session history, and previous outcomes.",
        ],
      },
      {
        id: "artifacts",
        title: "Replay and Audit Artifacts",
        description:
          "Stores events, screenshots, logs, memory snapshots, and run artifacts under the local data directory.",
        source: "builtin",
        status: "active",
        route: "shared",
        notes: [
          "Useful for review, debugging, and operator playback.",
        ],
      },
      {
        id: "memory-consolidation",
        title: "Memory Consolidation",
        description:
          "Background service that deduplicates, merges, and discovers patterns across stored memories.",
        source: "builtin",
        status: "active",
        route: "shared",
      },
      {
        id: "plugin-management",
        title: "Skills and Integration Registry",
        description:
          "Tracks installed prompt skills and configured MCP integrations so the runtime can expose them consistently.",
        source: "builtin",
        status: "active",
        route: "shared",
        notes: [
          "Capabilities in this section are inspired by Milady's local-first extension model.",
        ],
      },
    ],
  };

  const skillSection: CapabilitySection = {
    id: "skills",
    title: "Active Skill Prompts",
    description: "Installed prompt packs that are injected into agent behavior.",
    items: enabledSkills.map((skill) => ({
      id: skill.id,
      title: skill.name,
      description: trimDescription(skill.description, "Custom prompt skill enabled for the runtime."),
      source: "skill" as const,
      status: "active" as const,
      route: "shared" as const,
      notes: [
        "The full skill prompt is injected into CLI work and live desktop execution.",
      ],
    })),
  };

  const mcpSection: CapabilitySection = {
    id: "mcp",
    title: "Enabled MCP Integrations",
    description: "External integrations that are registered with the local runtime.",
    items: enabledMcpServers.map((server) => ({
      id: server.id,
      title: server.name,
      description: `Configured ${server.type.toUpperCase()} MCP server.`,
      source: "mcp" as const,
      status: "configured" as const,
      route: "shared" as const,
      notes: [
        "These integrations are registered in Novaper, but only tools explicitly surfaced to the model are directly callable in a turn.",
      ],
    })),
  };

  const sections = [executionSection, operatorSection, skillSection, mcpSection];
  const builtInCount = executionSection.items.length + operatorSection.items.length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      builtInCount,
      activeSkillCount: enabledSkills.length,
      enabledMcpCount: enabledMcpServers.length,
      routes: ["desktop", "cli", "planner"],
    },
    sections,
  };
}

export function buildActiveSkillsPrompt(skills?: PromptSkill[]): string {
  if (!skills || skills.length === 0) {
    return "";
  }

  const lines = [
    "# Active Skills",
    "The following skill prompts are active and should be incorporated into your behavior when relevant.",
  ];

  for (const skill of skills) {
    lines.push(`## ${skill.name}`);
    lines.push(skill.content.trim());
  }

  return lines.join("\n\n");
}

export function buildCapabilityPrompt(snapshot: CapabilitySnapshot): string {
  const lines = [
    "# Runtime Capability Profile",
    "This Novaper runtime includes a Milady-style capability layer built on local execution, memory, and extensions.",
    "Available execution routes:",
    "- desktop: current-screen observation, browser-first interaction on Chromium pages, Windows desktop control, and screenshot verification.",
    "- cli: repository inspection, shell execution, and file editing through structured CLI tools.",
    "- planner: decompose complex work into desktop and CLI subtasks.",
    "Shared services:",
    "- memory: app-aware context and durable recall are available.",
    "- artifacts: screenshots, events, logs, and replay data are persisted locally.",
  ];

  const skillItems = snapshot.sections.find((section) => section.id === "skills")?.items ?? [];
  if (skillItems.length > 0) {
    lines.push("");
    lines.push("Enabled skills:");
    for (const item of skillItems) {
      lines.push(`- ${item.title}: ${item.description}`);
    }
  }

  const mcpItems = snapshot.sections.find((section) => section.id === "mcp")?.items ?? [];
  if (mcpItems.length > 0) {
    lines.push("");
    lines.push("Configured MCP integrations:");
    for (const item of mcpItems) {
      lines.push(`- ${item.title}: ${item.description}`);
    }
    lines.push(
      "Do not claim direct access to an MCP integration unless the current turn exposes explicit tools for it.",
    );
  }

  return lines.join("\n");
}

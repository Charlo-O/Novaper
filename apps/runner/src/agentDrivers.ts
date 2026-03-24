import type { AuthProvider } from "../../../packages/replay-schema/src/types.js";
import type { AgentRoute } from "../../../packages/runner-core/src/instructionClassifier.js";

export const AGENT_DRIVER_IDS = [
  "glm-async",
  "mai",
  "gemini",
  "midscene",
  "droidrun",
  "codex-agent",
] as const;

export type AgentDriverId = (typeof AGENT_DRIVER_IDS)[number];
export type AgentConfigParams = Record<string, unknown>;
export type AgentInstructionScope = "root" | "plan" | "task" | "cli";

export const DEFAULT_AGENT_DRIVER_ID: AgentDriverId = "glm-async";

const ALL_AUTH_PROVIDERS: readonly AuthProvider[] = [
  "api-key",
  "codex-oauth",
  "custom-api",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(next)));
}

function appendPromptNotes(basePrompt: string, label: string, notes: string[]) {
  const filtered = notes.map((note) => note.trim()).filter(Boolean);
  if (filtered.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\n[${label} Driver]\n${filtered.map((note) => `- ${note}`).join("\n")}`;
}

function prependInstruction(label: string, scope: AgentInstructionScope, notes: string[], instruction: string) {
  const filtered = notes.map((note) => note.trim()).filter(Boolean);
  if (filtered.length === 0) {
    return instruction;
  }

  return [
    `[Agent Strategy: ${label}]`,
    `Instruction scope: ${scope}`,
    ...filtered.map((note) => `- ${note}`),
    "",
    instruction,
  ].join("\n");
}

interface AgentDriver {
  id: AgentDriverId;
  label: string;
  description: string;
  supportedAuthProviders: readonly AuthProvider[];
  desktopMaxTurns: number;
  plannerStepMaxTurns: number;
  verificationMaxTurns: number;
  resolveRoute(context: {
    instruction: string;
    classifiedRoute: AgentRoute;
    agentConfig: AgentConfigParams;
  }): AgentRoute;
  buildDeveloperPrompt(basePrompt: string, agentConfig: AgentConfigParams): string;
  decorateInstruction(
    instruction: string,
    scope: AgentInstructionScope,
    agentConfig: AgentConfigParams,
  ): string;
}

function classifyRouteStrategy({ classifiedRoute }: { classifiedRoute: AgentRoute }) {
  return classifiedRoute;
}

function plannerFirstStrategy({ classifiedRoute }: { classifiedRoute: AgentRoute }) {
  return classifiedRoute === "cli" ? "cli" : "planner";
}

const agentDrivers: Record<AgentDriverId, AgentDriver> = {
  "glm-async": {
    id: "glm-async",
    label: "GLM Agent",
    description: "Stable low-variance desktop execution strategy.",
    supportedAuthProviders: ALL_AUTH_PROVIDERS,
    desktopMaxTurns: 28,
    plannerStepMaxTurns: 18,
    verificationMaxTurns: 8,
    resolveRoute: classifyRouteStrategy,
    buildDeveloperPrompt(basePrompt) {
      return appendPromptNotes(basePrompt, "GLM Agent", [
        "Favor reliable, low-variance action paths over exploration.",
        "Prefer deterministic tools and only escalate to visual fallback when necessary.",
        "Keep action chains short and verify after each meaningful state change.",
      ]);
    },
    decorateInstruction(instruction, scope) {
      return prependInstruction("GLM Agent", scope, [
        "Use the most reliable path available and avoid speculative branching.",
        "Prefer stable, incremental progress with explicit verification.",
      ], instruction);
    },
  },
  mai: {
    id: "mai",
    label: "MAI Agent",
    description: "Planner-forward GUI strategy with stronger rolling visual context.",
    supportedAuthProviders: ALL_AUTH_PROVIDERS,
    desktopMaxTurns: 30,
    plannerStepMaxTurns: 20,
    verificationMaxTurns: 10,
    resolveRoute: plannerFirstStrategy,
    buildDeveloperPrompt(basePrompt, agentConfig) {
      const historyN = clampInteger(agentConfig.history_n, 3, 1, 10);
      return appendPromptNotes(basePrompt, "MAI Agent", [
        `Maintain a rolling visual memory mindset across roughly ${historyN} recent screenshots, even when only the latest screenshot is attached.`,
        "Decompose GUI objectives into short, verified subtasks instead of long uninterrupted action runs.",
        "Before each action, restate the current screen state mentally and choose one minimal next transition.",
      ]);
    },
    decorateInstruction(instruction, scope, agentConfig) {
      const historyN = clampInteger(agentConfig.history_n, 3, 1, 10);
      return prependInstruction("MAI Agent", scope, [
        `Carry forward the last ${historyN} visual states as working context.`,
        "Prefer subtask decomposition, explicit screen-state checks, and short verified transitions.",
      ], instruction);
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini Agent",
    description: "Tool-calling-first strategy with explicit state/action/result structure.",
    supportedAuthProviders: ALL_AUTH_PROVIDERS,
    desktopMaxTurns: 28,
    plannerStepMaxTurns: 18,
    verificationMaxTurns: 8,
    resolveRoute: classifyRouteStrategy,
    buildDeveloperPrompt(basePrompt) {
      return appendPromptNotes(basePrompt, "Gemini Agent", [
        "Structure reasoning as observed state -> chosen tool -> observed result.",
        "Prefer tool and function calls over free-form narration.",
        "Keep summaries compact, factual, and anchored to observable evidence.",
      ]);
    },
    decorateInstruction(instruction, scope) {
      return prependInstruction("Gemini Agent", scope, [
        "Use explicit state/action/result checkpoints.",
        "Prefer structured tool use and concise factual progress.",
      ], instruction);
    },
  },
  midscene: {
    id: "midscene",
    label: "Midscene Agent",
    description: "Browser- and visual-workflow-oriented execution strategy.",
    supportedAuthProviders: ALL_AUTH_PROVIDERS,
    desktopMaxTurns: 30,
    plannerStepMaxTurns: 18,
    verificationMaxTurns: 8,
    resolveRoute: classifyRouteStrategy,
    buildDeveloperPrompt(basePrompt, agentConfig) {
      const modelFamily =
        typeof agentConfig.model_family === "string" && agentConfig.model_family.trim()
          ? agentConfig.model_family.trim()
          : "doubao-vision";
      return appendPromptNotes(basePrompt, "Midscene Agent", [
        "Prefer browser_* tools and DOM-grounded actions whenever the target lives in a browser.",
        "Treat each screen transition as a checkpoint and describe what changed before proceeding.",
        `Align visual reasoning style with the configured model family hint: ${modelFamily}.`,
      ]);
    },
    decorateInstruction(instruction, scope, agentConfig) {
      const modelFamily =
        typeof agentConfig.model_family === "string" && agentConfig.model_family.trim()
          ? agentConfig.model_family.trim()
          : "doubao-vision";
      return prependInstruction("Midscene Agent", scope, [
        "Prefer browser-first execution when possible, then visual fallback.",
        `Use screen-transition checkpoints with model family hint: ${modelFamily}.`,
      ], instruction);
    },
  },
  droidrun: {
    id: "droidrun",
    label: "DroidRun Agent",
    description: "Planner-forward mobile-style navigation strategy.",
    supportedAuthProviders: ALL_AUTH_PROVIDERS,
    desktopMaxTurns: 28,
    plannerStepMaxTurns: 18,
    verificationMaxTurns: 8,
    resolveRoute: plannerFirstStrategy,
    buildDeveloperPrompt(basePrompt) {
      return appendPromptNotes(basePrompt, "DroidRun Agent", [
        "Think in mobile-style screen navigation loops: identify screen, perform one gesture, verify transition.",
        "Prefer short gesture chains with explicit post-action screen verification.",
        "Treat each tap, scroll, and navigation change as a discrete state transition.",
      ]);
    },
    decorateInstruction(instruction, scope) {
      return prependInstruction("DroidRun Agent", scope, [
        "Use mobile-style navigation loops and short verified gesture chains.",
        "Confirm the screen changed as expected after every gesture.",
      ], instruction);
    },
  },
  "codex-agent": {
    id: "codex-agent",
    label: "Codex Agent",
    description: "Codex-style concise, tool-first execution strategy.",
    supportedAuthProviders: ALL_AUTH_PROVIDERS,
    desktopMaxTurns: 30,
    plannerStepMaxTurns: 20,
    verificationMaxTurns: 8,
    resolveRoute: classifyRouteStrategy,
    buildDeveloperPrompt(basePrompt) {
      return appendPromptNotes(basePrompt, "Codex Agent", [
        "Operate with concise, tool-first discipline and explicit verification after each action.",
        "Avoid unnecessary narration. Execute, verify, and stop immediately when the goal is complete.",
        "When blocked, explain the blocker directly instead of speculative retries.",
      ]);
    },
    decorateInstruction(instruction, scope) {
      return prependInstruction("Codex Agent", scope, [
        "Be concise, tool-first, and verification-driven.",
        "Stop as soon as the requested outcome is verifiably complete.",
      ], instruction);
    },
  },
};

export function normalizeAgentDriverId(input: unknown): AgentDriverId {
  return typeof input === "string" && (AGENT_DRIVER_IDS as readonly string[]).includes(input)
    ? (input as AgentDriverId)
    : DEFAULT_AGENT_DRIVER_ID;
}

export function normalizeAgentConfig(input: unknown): AgentConfigParams {
  return isRecord(input) ? { ...input } : {};
}

export function getAgentDriver(input: unknown): AgentDriver {
  return agentDrivers[normalizeAgentDriverId(input)];
}

export function listAgentDrivers() {
  return AGENT_DRIVER_IDS.map((id) => agentDrivers[id]);
}

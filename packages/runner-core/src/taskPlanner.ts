import type { ResponsesClient } from "./responsesClient.js";

export type TaskExecutionMethod =
  | "system_launch"
  | "browser_dom"
  | "uia"
  | "window_tools"
  | "vision"
  | "cli";

export interface TaskPlanItem {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "waiting_input";
  dependsOn?: string[];
  agentType: "cli" | "desktop";
  preferredMethods?: TaskExecutionMethod[];
  successCriteria?: string[];
  fallbackPolicy?: string[];
  replanHint?: string;
  atomic?: boolean;
  summary?: string;
}

export interface TaskPlan {
  instruction: string;
  tasks: TaskPlanItem[];
  createdAt: string;
}

export interface WindowInfo {
  handle: string | number;
  title: string;
  processId: number;
  processName: string;
  isForeground: boolean;
}

/**
 * Decompose a complex instruction into sub-tasks using LLM.
 * Returns a structured task plan with dependencies.
 */
export async function planTasks(
  instruction: string,
  context: { windows: WindowInfo[]; memory: string; capabilities?: string },
  client: ResponsesClient,
  model: string,
): Promise<TaskPlan> {
  const windowsList = context.windows
    .map((w) => `${w.processName} - "${w.title}"${w.isForeground ? " (foreground)" : ""}`)
    .join("\n");

  const prompt = `You are a task planning assistant for a Windows desktop automation system.
Given a user instruction, break it down into a sequence of sub-tasks that can be executed one at a time.

Current desktop windows:
${windowsList || "(no windows detected)"}

${context.memory ? `Relevant memory context:\n${context.memory}\n` : ""}
${context.capabilities ? `Runtime capabilities:\n${context.capabilities}\n` : ""}

User instruction: ${instruction}

For each sub-task, determine:
- id: unique short identifier (e.g., "t1", "t2")
- title: brief title
- description: what needs to be done in one stage of the overall task
- agentType: "cli" for command-line/file tasks, "desktop" for GUI interaction
- dependsOn: array of task IDs that must complete first (empty if none)
- preferredMethods: ordered array using only these values:
  - "system_launch" for opening apps or URLs through OS-level launch
  - "browser_dom" for browser_* tools
  - "uia" for UI Automation
  - "window_tools" for process/window focus/wait/verification tools
  - "vision" for screenshot-driven fallback
  - "cli" for command-line tools
- successCriteria: array of short, observable success checks
- fallbackPolicy: array of short fallback rules if the preferred method fails
- replanHint: one short sentence explaining how to adjust if verification fails
- atomic: true if this step should stay as a single minimal verifiable stage

Planning rules:
- Prefer 2 to 4 total sub-tasks for complex instructions.
- Each step must be atomic enough to verify before the next step.
- Do not combine "open app", "navigate", and "final business action" into one step.
- For software opening, prefer "system_launch" and "window_tools" before "uia" or "vision".
- For web tasks, prefer "browser_dom" before "uia" or "vision".
- Always include at least one success criterion that can be checked by tools, not just by model guesswork.

If the instruction is simple enough to be done in one step, return just one task.

Return ONLY a JSON array of task objects. No other text.`;

  try {
    const response = await client.createResponse({
      model,
      instructions: "You are a task planner. Return only valid JSON arrays.",
      input: prompt,
    });

    const text = response.output_text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Fallback: single task
      return createSingleTaskPlan(instruction);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      id: string;
      title: string;
      description: string;
      agentType?: "cli" | "desktop";
      dependsOn?: string[];
      preferredMethods?: TaskExecutionMethod[];
      successCriteria?: string[];
      fallbackPolicy?: string[];
      replanHint?: string;
      atomic?: boolean;
    }>;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return createSingleTaskPlan(instruction);
    }

    const tasks: TaskPlanItem[] = parsed.map((item) => ({
      id: item.id || `t${Math.random().toString(36).slice(2, 6)}`,
      title: item.title || instruction.slice(0, 50),
      description: item.description || instruction,
      status: "pending" as const,
      dependsOn: item.dependsOn || [],
      agentType: item.agentType === "cli" ? "cli" : "desktop",
      preferredMethods: normalizePreferredMethods(item.preferredMethods, item.agentType === "cli" ? "cli" : "desktop"),
      successCriteria: normalizeStringArray(item.successCriteria),
      fallbackPolicy: normalizeStringArray(item.fallbackPolicy),
      replanHint: typeof item.replanHint === "string" && item.replanHint.trim() ? item.replanHint.trim() : undefined,
      atomic: item.atomic !== false,
    }));

    return {
      instruction,
      tasks,
      createdAt: new Date().toISOString(),
    };
  } catch {
    return createSingleTaskPlan(instruction);
  }
}

function createSingleTaskPlan(instruction: string): TaskPlan {
  return {
    instruction,
    tasks: [
      {
        id: "t1",
        title: instruction.slice(0, 80),
        description: instruction,
        status: "pending",
        agentType: "desktop",
        preferredMethods: ["system_launch", "window_tools", "uia", "vision"],
        successCriteria: ["The requested outcome is visible in the current app or window state."],
        fallbackPolicy: ["If deterministic tools fail, inspect the latest screenshot and use visual fallback."],
        replanHint: "Re-observe the current desktop state and choose the next minimal verifiable action.",
        atomic: true,
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePreferredMethods(value: unknown, agentType: "cli" | "desktop"): TaskExecutionMethod[] {
  const allowed = new Set<TaskExecutionMethod>(["system_launch", "browser_dom", "uia", "window_tools", "vision", "cli"]);
  const fallback: TaskExecutionMethod[] =
    agentType === "cli"
      ? ["cli"]
      : ["system_launch", "window_tools", "uia", "vision"];

  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is TaskExecutionMethod => allowed.has(entry as TaskExecutionMethod));

  if (normalized.length === 0) {
    return fallback;
  }

  if (agentType === "cli") {
    return ["cli"];
  }

  return Array.from(new Set(normalized));
}

/** Get the next executable task (all dependencies completed) */
export function getNextTask(plan: TaskPlan): TaskPlanItem | null {
  const completedIds = new Set(plan.tasks.filter((t) => t.status === "completed").map((t) => t.id));

  for (const task of plan.tasks) {
    if (task.status !== "pending") continue;
    const deps = task.dependsOn || [];
    if (deps.every((dep) => completedIds.has(dep))) {
      return task;
    }
  }
  return null;
}

/** Update task status in plan */
export function updateTaskStatus(plan: TaskPlan, taskId: string, status: TaskPlanItem["status"], summary?: string): void {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (task) {
    task.status = status;
    if (summary) task.summary = summary;
  }
}

/** Check if all tasks are done */
export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.tasks.every((t) => t.status === "completed" || t.status === "failed");
}

/** Format plan as text for display/logging */
export function formatPlan(plan: TaskPlan): string {
  const statusEmoji: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]",
    failed: "[!]",
    waiting_input: "[?]",
  };

  return plan.tasks
    .map((t) => `${statusEmoji[t.status] || "[ ]"} ${t.id}: ${t.title} (${t.agentType})${t.summary ? ` — ${t.summary}` : ""}`)
    .join("\n");
}

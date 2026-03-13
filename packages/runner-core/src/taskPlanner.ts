import type { ResponsesClient } from "./responsesClient.js";

export interface TaskPlanItem {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "waiting_input";
  dependsOn?: string[];
  agentType: "cli" | "desktop";
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
- description: what needs to be done
- agentType: "cli" for command-line/file tasks, "desktop" for GUI interaction
- dependsOn: array of task IDs that must complete first (empty if none)

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
      },
    ],
    createdAt: new Date().toISOString(),
  };
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

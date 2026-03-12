import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface WorkflowRecord {
  uuid: string;
  name: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRecord {
  id: string;
  name: string;
  workflow_uuid: string;
  device_serialnos: string[];
  device_group_id?: string | null;
  cron_expression: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run_time: string | null;
  last_run_success: boolean | null;
  last_run_status?: "success" | "partial" | "failure" | null;
  last_run_success_count?: number | null;
  last_run_total_count?: number | null;
  last_run_message: string | null;
  next_run_time: string | null;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDayOfWeek(value: number) {
  return value === 7 ? 0 : value;
}

function isWildcard(field: string) {
  return field.trim() === "*";
}

function parseSegment(segment: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  const [rawBase, rawStep] = segment.split("/");
  const step = rawStep ? Number.parseInt(rawStep, 10) : 1;
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step: ${segment}`);
  }

  const base = rawBase.trim();
  if (base === "*") {
    for (let value = min; value <= max; value += step) {
      values.add(value);
    }
    return values;
  }

  const addRange = (start: number, end: number) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new Error(`Invalid cron range: ${segment}`);
    }
    for (let value = start; value <= end; value += step) {
      if (value < min || value > max) {
        throw new Error(`Cron value out of range: ${segment}`);
      }
      values.add(value);
    }
  };

  if (base.includes("-")) {
    const [startText, endText] = base.split("-");
    addRange(Number.parseInt(startText, 10), Number.parseInt(endText, 10));
    return values;
  }

  const value = Number.parseInt(base, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Cron value out of range: ${segment}`);
  }
  values.add(value);
  return values;
}

function fieldMatches(field: string, value: number, min: number, max: number, normalize?: (value: number) => number) {
  const targetValue = normalize ? normalize(value) : value;
  const segments = field.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Invalid cron field: ${field}`);
  }

  for (const segment of segments) {
    const candidates = parseSegment(segment, min, max);
    if (normalize) {
      if ([...candidates].map(normalize).includes(targetValue)) {
        return true;
      }
    } else if (candidates.has(targetValue)) {
      return true;
    }
  }

  return false;
}

export function validateCronExpression(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expression must have 5 fields.");
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  fieldMatches(minute, 0, 0, 59);
  fieldMatches(hour, 0, 0, 23);
  fieldMatches(dayOfMonth, 1, 1, 31);
  fieldMatches(month, 1, 1, 12);
  fieldMatches(dayOfWeek, 0, 0, 7, normalizeDayOfWeek);
}

export function matchesCronExpression(expression: string, date: Date) {
  validateCronExpression(expression);

  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
  const minuteMatches = fieldMatches(minute, date.getMinutes(), 0, 59);
  const hourMatches = fieldMatches(hour, date.getHours(), 0, 23);
  const monthMatches = fieldMatches(month, date.getMonth() + 1, 1, 12);
  const domMatches = fieldMatches(dayOfMonth, date.getDate(), 1, 31);
  const dowMatches = fieldMatches(dayOfWeek, date.getDay(), 0, 7, normalizeDayOfWeek);

  const dayMatches =
    !isWildcard(dayOfMonth) && !isWildcard(dayOfWeek)
      ? domMatches || dowMatches
      : domMatches && dowMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}

export function computeNextRunTime(expression: string, after = new Date()) {
  validateCronExpression(expression);

  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let index = 0; index < 60 * 24 * 366; index += 1) {
    if (matchesCronExpression(expression, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

export class AutomationStore {
  private readonly workflowsPath: string;
  private readonly tasksPath: string;
  private workflows = new Map<string, WorkflowRecord>();
  private tasks = new Map<string, ScheduledTaskRecord>();

  constructor(private readonly rootDir: string) {
    this.workflowsPath = path.join(rootDir, "workflows.json");
    this.tasksPath = path.join(rootDir, "scheduled-tasks.json");
  }

  async loadFromDisk() {
    await fs.mkdir(this.rootDir, { recursive: true });

    const [workflowEntries, taskEntries] = await Promise.all([
      this.readJson<WorkflowRecord>(this.workflowsPath),
      this.readJson<ScheduledTaskRecord>(this.tasksPath),
    ]);

    this.workflows = new Map(workflowEntries.map((entry) => [entry.uuid, entry]));
    this.tasks = new Map(
      taskEntries.map((entry) => {
        const existingNextRun = entry.next_run_time ? new Date(entry.next_run_time) : null;
        const next_run_time =
          entry.enabled && entry.cron_expression
            ? existingNextRun && existingNextRun.getTime() > Date.now()
              ? entry.next_run_time
              : computeNextRunTime(entry.cron_expression)
            : null;
        return [
          entry.id,
          {
            ...entry,
            device_serialnos: Array.isArray(entry.device_serialnos) ? entry.device_serialnos : [],
            device_group_id: entry.device_group_id ?? null,
            next_run_time,
          },
        ];
      }),
    );

    await this.persistAll();
  }

  listWorkflows() {
    return [...this.workflows.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  getWorkflow(uuid: string) {
    return this.workflows.get(uuid);
  }

  async createWorkflow(input: { name: string; text: string; uuid?: string }) {
    const workflow: WorkflowRecord = {
      uuid: input.uuid?.trim() || randomUUID(),
      name: input.name.trim(),
      text: input.text,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.workflows.set(workflow.uuid, workflow);
    await this.persistWorkflows();
    return workflow;
  }

  async updateWorkflow(uuid: string, patch: { name: string; text: string }) {
    const workflow = this.requireWorkflow(uuid);
    const updated: WorkflowRecord = {
      ...workflow,
      name: patch.name.trim(),
      text: patch.text,
      updated_at: nowIso(),
    };
    this.workflows.set(uuid, updated);
    await this.persistWorkflows();
    return updated;
  }

  async deleteWorkflow(uuid: string) {
    const deleted = this.workflows.delete(uuid);
    if (!deleted) {
      return false;
    }
    await this.persistWorkflows();
    return true;
  }

  listScheduledTasks() {
    return [...this.tasks.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  getScheduledTask(taskId: string) {
    return this.tasks.get(taskId);
  }

  async createScheduledTask(input: {
    name: string;
    workflow_uuid: string;
    device_serialnos?: string[] | null;
    device_group_id?: string | null;
    cron_expression: string;
    enabled?: boolean;
    id?: string;
  }) {
    validateCronExpression(input.cron_expression);

    const enabled = input.enabled ?? true;
    const task: ScheduledTaskRecord = {
      id: input.id?.trim() || randomUUID(),
      name: input.name.trim(),
      workflow_uuid: input.workflow_uuid,
      device_serialnos: Array.isArray(input.device_serialnos) ? input.device_serialnos : [],
      device_group_id: input.device_group_id ?? null,
      cron_expression: input.cron_expression.trim(),
      enabled,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_run_time: null,
      last_run_success: null,
      last_run_status: null,
      last_run_success_count: null,
      last_run_total_count: null,
      last_run_message: null,
      next_run_time: enabled ? computeNextRunTime(input.cron_expression.trim()) : null,
    };
    this.tasks.set(task.id, task);
    await this.persistTasks();
    return task;
  }

  async updateScheduledTask(
    taskId: string,
    patch: {
      name?: string;
      workflow_uuid?: string;
      device_serialnos?: string[] | null;
      device_group_id?: string | null;
      cron_expression?: string;
      enabled?: boolean;
    },
  ) {
    const task = this.requireScheduledTask(taskId);
    const cron_expression = patch.cron_expression?.trim() ?? task.cron_expression;
    validateCronExpression(cron_expression);

    const enabled = patch.enabled ?? task.enabled;
    const updated: ScheduledTaskRecord = {
      ...task,
      ...patch,
      name: patch.name?.trim() ?? task.name,
      workflow_uuid: patch.workflow_uuid ?? task.workflow_uuid,
      device_serialnos:
        patch.device_serialnos === undefined ? task.device_serialnos : patch.device_serialnos ?? [],
      device_group_id:
        patch.device_group_id === undefined ? task.device_group_id ?? null : patch.device_group_id,
      cron_expression,
      enabled,
      updated_at: nowIso(),
      next_run_time: enabled ? computeNextRunTime(cron_expression) : null,
    };
    this.tasks.set(taskId, updated);
    await this.persistTasks();
    return updated;
  }

  async deleteScheduledTask(taskId: string) {
    const deleted = this.tasks.delete(taskId);
    if (!deleted) {
      return false;
    }
    await this.persistTasks();
    return true;
  }

  listDueScheduledTasks(referenceTime = new Date()) {
    return this.listScheduledTasks().filter((task) => {
      if (!task.enabled || !task.next_run_time) {
        return false;
      }
      return new Date(task.next_run_time).getTime() <= referenceTime.getTime();
    });
  }

  async recordTaskRunStart(taskId: string, message: string) {
    const task = this.requireScheduledTask(taskId);
    const updated: ScheduledTaskRecord = {
      ...task,
      updated_at: nowIso(),
      last_run_message: message,
    };
    this.tasks.set(taskId, updated);
    await this.persistTasks();
    return updated;
  }

  async recordTaskRunResult(
    taskId: string,
    result: {
      success: boolean;
      message: string;
      successCount?: number;
      totalCount?: number;
      finishedAt?: Date;
    },
  ) {
    const task = this.requireScheduledTask(taskId);
    const finishedAt = result.finishedAt ?? new Date();
    const status =
      result.successCount != null &&
      result.totalCount != null &&
      result.totalCount > 0 &&
      result.successCount < result.totalCount &&
      result.successCount > 0
        ? "partial"
        : result.success
          ? "success"
          : "failure";

    const updated: ScheduledTaskRecord = {
      ...task,
      updated_at: nowIso(),
      last_run_time: finishedAt.toISOString(),
      last_run_success: result.success,
      last_run_status: status,
      last_run_success_count: result.successCount ?? null,
      last_run_total_count: result.totalCount ?? null,
      last_run_message: result.message,
      next_run_time: task.enabled ? computeNextRunTime(task.cron_expression, finishedAt) : null,
    };
    this.tasks.set(taskId, updated);
    await this.persistTasks();
    return updated;
  }

  private requireWorkflow(uuid: string) {
    const workflow = this.workflows.get(uuid);
    if (!workflow) {
      throw new Error(`Workflow not found: ${uuid}`);
    }
    return workflow;
  }

  private requireScheduledTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    return task;
  }

  private async readJson<T>(filePath: string) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T[];
    } catch {
      return [];
    }
  }

  private async persistAll() {
    await Promise.all([this.persistWorkflows(), this.persistTasks()]);
  }

  private async persistWorkflows() {
    await fs.writeFile(
      this.workflowsPath,
      `${JSON.stringify(this.listWorkflows(), null, 2)}\n`,
      "utf8",
    );
  }

  private async persistTasks() {
    await fs.writeFile(
      this.tasksPath,
      `${JSON.stringify(this.listScheduledTasks(), null, 2)}\n`,
      "utf8",
    );
  }
}

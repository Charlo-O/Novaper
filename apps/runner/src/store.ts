import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthProvider, ReplayManifest, RunEvent, RunRecord, RunStatus } from "../../../packages/replay-schema/src/types.js";

function now() {
  return new Date().toISOString();
}

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly history = new Map<string, RunEvent[]>();
  private readonly streams = new Map<string, Set<Response>>();

  constructor(private readonly rootDir: string) {}

  async createRun(input: {
    scenarioId: string;
    machineId: string;
    payload: Record<string, unknown>;
    model: string;
    authProvider?: AuthProvider;
    retryOf?: string;
  }): Promise<RunRecord> {
    const id = randomUUID();
    const replayDir = path.join(this.rootDir, id);
    await fs.mkdir(path.join(replayDir, "screenshots"), { recursive: true });

    const run: RunRecord = {
      id,
      scenarioId: input.scenarioId,
      machineId: input.machineId,
      status: "Draft",
      createdAt: now(),
      updatedAt: now(),
      input: input.payload,
      model: input.model,
      authProvider: input.authProvider,
      replayDir,
      retryOf: input.retryOf,
    };

    this.runs.set(id, run);
    this.history.set(id, []);
    await this.persistRun(run);
    await this.persistReplayManifest(run);
    return run;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getEvents(runId: string): RunEvent[] {
    return this.history.get(runId) ?? [];
  }

  async updateStatus(runId: string, status: RunStatus, extra?: Partial<RunRecord>): Promise<RunRecord> {
    const run = this.requireRun(runId);
    const updated: RunRecord = {
      ...run,
      ...extra,
      status,
      updatedAt: now(),
    };
    this.runs.set(runId, updated);
    await this.persistRun(updated);
    return updated;
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const run = this.requireRun(runId);
    const updated = {
      ...run,
      ...patch,
      updatedAt: now(),
    };
    this.runs.set(runId, updated);
    await this.persistRun(updated);
    return updated;
  }

  async appendEvent(runId: string, event: Omit<RunEvent, "id" | "runId" | "at">): Promise<RunEvent> {
    const fullEvent: RunEvent = {
      id: randomUUID(),
      runId,
      at: now(),
      ...event,
    };
    const events = this.history.get(runId) ?? [];
    events.push(fullEvent);
    this.history.set(runId, events);
    await fs.appendFile(path.join(this.requireRun(runId).replayDir, "events.jsonl"), `${JSON.stringify(fullEvent)}\n`, "utf8");

    const clients = this.streams.get(runId);
    if (clients) {
      for (const client of clients) {
        client.write(`data: ${JSON.stringify(fullEvent)}\n\n`);
      }
    }

    return fullEvent;
  }

  attachStream(runId: string, response: Response): () => void {
    const set = this.streams.get(runId) ?? new Set<Response>();
    set.add(response);
    this.streams.set(runId, set);

    for (const event of this.getEvents(runId)) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    return () => {
      const clients = this.streams.get(runId);
      clients?.delete(response);
      if (clients && clients.size === 0) {
        this.streams.delete(runId);
      }
    };
  }

  async requestStop(runId: string): Promise<RunRecord> {
    return this.updateRun(runId, { stopRequested: true });
  }

  requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private async persistRun(run: RunRecord): Promise<void> {
    await fs.writeFile(path.join(run.replayDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  private async persistReplayManifest(run: RunRecord): Promise<void> {
    const manifest: ReplayManifest = {
      run,
      eventsFile: "events.jsonl",
      screenshotsDir: "screenshots",
      artifacts: [],
    };
    await fs.writeFile(path.join(run.replayDir, "replay.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Response } from "express";
import type { AuthProvider } from "../../../packages/replay-schema/src/types.js";
import {
  DEFAULT_AGENT_DRIVER_ID,
  normalizeAgentConfig,
  normalizeAgentDriverId,
  type AgentConfigParams,
  type AgentDriverId,
} from "./agentDrivers.js";

export interface PendingConfirmation {
  message: string;
  options?: string[];
  resolveWith?: string;
  requestedAt: string;
}

export interface LiveSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  authProvider?: AuthProvider;
  agentType: AgentDriverId;
  agentConfig: AgentConfigParams;
  status: "idle" | "observing" | "acting" | "error" | "waiting_confirmation";
  artifactDir: string;
  previousResponseId?: string;
  latestScreenshotUrl?: string;
  latestInstruction?: string;
  latestSummary?: string;
  stopRequested?: boolean;
  error?: string;
  pendingConfirmation?: PendingConfirmation;
  executionLock?: boolean;
}

export interface LiveEvent {
  id: string;
  sessionId: string;
  at: string;
  type: "status" | "log" | "tool_call" | "tool_result" | "computer_action" | "screenshot" | "error" | "message" | "agent_route";
  level: "info" | "warning" | "error";
  message: string;
  payload?: unknown;
}

function now() {
  return new Date().toISOString();
}

export class LiveSessionStore {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly history = new Map<string, LiveEvent[]>();
  private readonly streams = new Map<string, Set<Response>>();

  constructor(private readonly rootDir: string) {}

  /** Scan data/live-sessions/{id}/session.json on startup and restore into memory Map */
  async loadFromDisk(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch {
      return; // directory doesn't exist yet
    }

    for (const entry of entries) {
      const sessionPath = path.join(this.rootDir, entry, "session.json");
      try {
        const raw = await fs.readFile(sessionPath, "utf8");
        const session = JSON.parse(raw) as LiveSession;
        session.agentType = normalizeAgentDriverId(session.agentType);
        session.agentConfig = normalizeAgentConfig(session.agentConfig);

        // Recover sessions that were mid-execution when the server stopped.
        // These will never resume, so reset them to idle.
        if (session.status === "acting" || session.status === "observing") {
          session.status = "idle";
          session.stopRequested = false;
          session.executionLock = false;
          await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
        }

        this.sessions.set(session.id, session);

        // Restore events from events.jsonl
        const eventsPath = path.join(this.rootDir, entry, "events.jsonl");
        const events: LiveEvent[] = [];
        try {
          const eventsRaw = await fs.readFile(eventsPath, "utf8");
          for (const line of eventsRaw.split("\n")) {
            if (line.trim()) {
              events.push(JSON.parse(line));
            }
          }
        } catch {
          // no events file yet
        }
        this.history.set(session.id, events);
      } catch {
        // skip malformed entries
      }
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.history.delete(sessionId);
    this.streams.delete(sessionId);
    try {
      await fs.rm(session.artifactDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    return true;
  }

  async createSession(
    model: string,
    authProvider?: AuthProvider,
    agentType: AgentDriverId = DEFAULT_AGENT_DRIVER_ID,
    agentConfig: AgentConfigParams = {},
  ): Promise<LiveSession> {
    const id = randomUUID();
    const artifactDir = path.join(this.rootDir, id);
    await fs.mkdir(path.join(artifactDir, "screenshots"), { recursive: true });

    const session: LiveSession = {
      id,
      createdAt: now(),
      updatedAt: now(),
      model,
      authProvider,
      agentType: normalizeAgentDriverId(agentType),
      agentConfig: normalizeAgentConfig(agentConfig),
      status: "idle",
      artifactDir,
    };

    this.sessions.set(id, session);
    this.history.set(id, []);
    await this.persistSession(session);
    return session;
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  listSessions() {
    return [...this.sessions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getEvents(sessionId: string) {
    return this.history.get(sessionId) ?? [];
  }

  async updateSession(sessionId: string, patch: Partial<LiveSession>) {
    const session = this.requireSession(sessionId);
    const updated: LiveSession = {
      ...session,
      ...patch,
      agentType:
        patch.agentType === undefined
          ? session.agentType
          : normalizeAgentDriverId(patch.agentType),
      agentConfig:
        patch.agentConfig === undefined
          ? session.agentConfig
          : normalizeAgentConfig(patch.agentConfig),
      updatedAt: now(),
    };
    this.sessions.set(sessionId, updated);
    await this.persistSession(updated);
    return updated;
  }

  async appendEvent(sessionId: string, event: Omit<LiveEvent, "id" | "sessionId" | "at">) {
    const fullEvent: LiveEvent = {
      id: randomUUID(),
      sessionId,
      at: now(),
      ...event,
    };

    const events = this.history.get(sessionId) ?? [];
    events.push(fullEvent);
    this.history.set(sessionId, events);
    await fs.appendFile(path.join(this.requireSession(sessionId).artifactDir, "events.jsonl"), `${JSON.stringify(fullEvent)}\n`, "utf8");

    const clients = this.streams.get(sessionId);
    if (clients) {
      for (const client of clients) {
        client.write(`data: ${JSON.stringify(fullEvent)}\n\n`);
      }
    }

    return fullEvent;
  }

  attachStream(sessionId: string, response: Response) {
    const set = this.streams.get(sessionId) ?? new Set<Response>();
    set.add(response);
    this.streams.set(sessionId, set);

    for (const event of this.getEvents(sessionId)) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    return () => {
      const clients = this.streams.get(sessionId);
      clients?.delete(response);
      if (clients && clients.size === 0) {
        this.streams.delete(sessionId);
      }
    };
  }

  requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Live session not found: ${sessionId}`);
    }
    return session;
  }

  private async persistSession(session: LiveSession) {
    await fs.writeFile(path.join(session.artifactDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }
}

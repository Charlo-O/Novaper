import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Response } from "express";
import type { AuthProvider } from "../../../packages/replay-schema/src/types.js";

export interface LiveSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  authProvider?: AuthProvider;
  status: "idle" | "observing" | "acting" | "error";
  artifactDir: string;
  previousResponseId?: string;
  latestScreenshotUrl?: string;
  latestInstruction?: string;
  latestSummary?: string;
  stopRequested?: boolean;
  error?: string;
}

export interface LiveEvent {
  id: string;
  sessionId: string;
  at: string;
  type: "status" | "log" | "tool_call" | "tool_result" | "computer_action" | "screenshot" | "error" | "message";
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

  async createSession(model: string, authProvider?: AuthProvider): Promise<LiveSession> {
    const id = randomUUID();
    const artifactDir = path.join(this.rootDir, id);
    await fs.mkdir(path.join(artifactDir, "screenshots"), { recursive: true });

    const session: LiveSession = {
      id,
      createdAt: now(),
      updatedAt: now(),
      model,
      authProvider,
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

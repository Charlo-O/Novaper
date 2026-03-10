import { randomUUID } from "node:crypto";
import type { MemoryEntry, WorkingMemoryState } from "./types.js";

const MAX_OBSERVATIONS = 20;
const MAX_EVENTS = 50;

/** Short-term working memory within a single session */
export class WorkingMemory {
  private sessionId: string;
  private appContext = "";
  private taskGoal = "";
  private observations: string[] = [];
  private eventBuffer: Array<{ type: string; summary: string; at: string }> = [];
  private entries: MemoryEntry[] = [];
  private conversationTracker?: WorkingMemoryState["conversationTracker"];
  private progressState: Record<string, unknown> = {};
  private lastObservation = "";

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  addObservation(observation: string, appContext?: string): void {
    this.observations.push(observation);
    if (this.observations.length > MAX_OBSERVATIONS) {
      this.observations.shift();
    }
    this.lastObservation = observation;
    if (appContext) {
      this.appContext = appContext;
    }
  }

  addEvent(type: string, summary: string): void {
    this.eventBuffer.push({ type, summary, at: new Date().toISOString() });
    if (this.eventBuffer.length > MAX_EVENTS) {
      this.eventBuffer.shift();
    }
  }

  addTaskProgress(key: string, value: unknown): void {
    this.progressState[key] = value;
  }

  setTaskGoal(goal: string): void {
    this.taskGoal = goal;
  }

  trackConversation(contact: string, message: { from: string; text: string }): void {
    if (!this.conversationTracker || this.conversationTracker.contactName !== contact) {
      this.conversationTracker = {
        contactName: contact,
        lastMessages: [],
        pendingReply: false,
      };
    }
    this.conversationTracker.lastMessages.push({
      ...message,
      time: new Date().toISOString(),
    });
    // Keep last 20 messages
    if (this.conversationTracker.lastMessages.length > 20) {
      this.conversationTracker.lastMessages =
        this.conversationTracker.lastMessages.slice(-20);
    }
    // If last message is from someone else, mark pending reply
    this.conversationTracker.pendingReply = message.from !== "me";
  }

  /** Build relevant context string for prompt injection */
  getRelevantContext(instruction: string, maxTokens = 2000): string {
    const parts: string[] = [];

    if (this.taskGoal) {
      parts.push(`[Current Task Goal]: ${this.taskGoal}`);
    }

    if (this.appContext) {
      parts.push(`[Active App]: ${this.appContext}`);
    }

    // Recent observations
    if (this.observations.length > 0) {
      const recent = this.observations.slice(-5);
      parts.push(`[Recent Observations]:\n${recent.map((o, i) => `${i + 1}. ${o}`).join("\n")}`);
    }

    // Conversation tracker
    if (this.conversationTracker) {
      const ct = this.conversationTracker;
      parts.push(`[Chat Tracking - ${ct.contactName}]:`);
      const msgs = ct.lastMessages.slice(-5);
      for (const m of msgs) {
        parts.push(`  ${m.from}: ${m.text}`);
      }
      if (ct.pendingReply) {
        parts.push(`  >> Pending reply to ${ct.contactName}`);
      }
    }

    // Progress state
    const progressKeys = Object.keys(this.progressState);
    if (progressKeys.length > 0) {
      parts.push(`[Task Progress]:`);
      for (const key of progressKeys) {
        parts.push(`  ${key}: ${JSON.stringify(this.progressState[key])}`);
      }
    }

    // Session entries (long-term relevant)
    if (this.entries.length > 0) {
      parts.push(`[Relevant Memories]:`);
      for (const entry of this.entries.slice(0, 5)) {
        parts.push(`  - [${entry.category}] ${entry.content}`);
      }
    }

    let result = parts.join("\n");
    // Rough token estimation: ~4 chars per token
    const maxChars = maxTokens * 4;
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + "\n... (truncated)";
    }
    return result;
  }

  /** Inject long-term entries retrieved for this session */
  setRelevantEntries(entries: MemoryEntry[]): void {
    this.entries = entries;
  }

  snapshot(): WorkingMemoryState {
    return {
      sessionId: this.sessionId,
      appContext: this.appContext,
      taskGoal: this.taskGoal,
      entries: this.entries,
      conversationTracker: this.conversationTracker,
      progressState: { ...this.progressState },
      lastObservation: this.lastObservation,
    };
  }

  restore(state: WorkingMemoryState): void {
    this.sessionId = state.sessionId;
    this.appContext = state.appContext;
    this.taskGoal = state.taskGoal;
    this.entries = state.entries;
    this.conversationTracker = state.conversationTracker;
    this.progressState = state.progressState;
    this.lastObservation = state.lastObservation;
  }

  /** Generate memory entries worth saving long-term from this session */
  extractNotableEntries(): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const now = new Date().toISOString();

    // If we tracked a conversation, save that knowledge
    if (this.conversationTracker) {
      entries.push({
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        category: "conversation",
        appContext: this.appContext || undefined,
        scope: "global",
        content: `Had conversation with ${this.conversationTracker.contactName}. Last messages: ${this.conversationTracker.lastMessages.slice(-3).map((m) => `${m.from}: ${m.text}`).join("; ")}`,
        accessCount: 0,
        lastAccessedAt: now,
        tags: ["conversation", this.conversationTracker.contactName],
        sourceSessionId: this.sessionId,
        confidence: 0.7,
      });
    }

    // Save task completion context
    if (this.taskGoal) {
      entries.push({
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        category: "task_context",
        appContext: this.appContext || undefined,
        scope: "global",
        content: `Completed task: ${this.taskGoal}. Progress: ${JSON.stringify(this.progressState)}`,
        accessCount: 0,
        lastAccessedAt: now,
        tags: ["task", "completed"],
        sourceSessionId: this.sessionId,
        confidence: 0.6,
      });
    }

    return entries;
  }
}

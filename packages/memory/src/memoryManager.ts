import type { MemoryEntry, WindowInfo, LiveEvent, ResponsesClient } from "./types.js";
import { MemoryStore } from "./memoryStore.js";
import { WorkingMemory } from "./workingMemory.js";
import { LongTermMemory } from "./longTermMemory.js";
import { AppContextMemory } from "./appContextMemory.js";

/** Unified orchestrator for the three-layer memory system */
export class MemoryManager {
  private readonly store: MemoryStore;
  private readonly longTerm: LongTermMemory;
  private readonly appContext: AppContextMemory;
  private readonly workingMemories = new Map<string, WorkingMemory>();

  constructor(dataDir: string) {
    this.store = new MemoryStore(dataDir);
    this.longTerm = new LongTermMemory(this.store);
    this.appContext = new AppContextMemory(this.store);
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.appContext.initDefaults();
  }

  async initSession(sessionId: string): Promise<void> {
    const wm = new WorkingMemory(sessionId);
    this.workingMemories.set(sessionId, wm);

    // Try to restore previous working memory snapshot
    const snapshot = await this.store.loadSession(sessionId);
    if (snapshot.length > 0) {
      wm.setRelevantEntries(snapshot);
    }
  }

  getWorkingMemory(sessionId: string): WorkingMemory | undefined {
    return this.workingMemories.get(sessionId);
  }

  /**
   * Build memory context to inject into the agent's developer prompt.
   * Called before each turn of the agent loop.
   */
  async buildMemoryContext(
    instruction: string,
    windows: WindowInfo[],
    foreground?: WindowInfo,
    sessionId?: string,
  ): Promise<string> {
    const parts: string[] = [];

    // 1. App context
    const appProfile = await this.appContext.detectApp(windows, foreground);
    if (appProfile) {
      parts.push(this.appContext.buildAppContext(appProfile));
    }

    // 2. Long-term memory recall
    const appName = appProfile?.appName;
    const recalled = await this.longTerm.recall(instruction, appName, 5);
    if (recalled.length > 0) {
      parts.push("[Long-Term Memories]:");
      for (const entry of recalled) {
        parts.push(`  - [${entry.category}] ${entry.content}`);
      }
    }

    // 3. Working memory context
    if (sessionId) {
      const wm = this.workingMemories.get(sessionId);
      if (wm) {
        if (appProfile) {
          wm.addObservation(`Foreground app: ${appProfile.appName}`, appProfile.appName);
        }
        const wmContext = wm.getRelevantContext(instruction);
        if (wmContext) {
          parts.push(wmContext);
        }
      }
    }

    return parts.length > 0
      ? `\n--- Memory Context ---\n${parts.join("\n")}\n--- End Memory Context ---\n`
      : "";
  }

  /**
   * Record the result of an agent turn.
   * Called after each turn of the agent loop.
   */
  async recordTurnResult(
    sessionId: string,
    instruction: string,
    toolCalls: Array<{ name: string; args: unknown; result: unknown }>,
    assistantMessage: string,
  ): Promise<void> {
    const wm = this.workingMemories.get(sessionId);
    if (!wm) return;

    wm.setTaskGoal(instruction);
    wm.addObservation(assistantMessage);

    for (const tc of toolCalls) {
      wm.addEvent(tc.name, `${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`);
    }
  }

  /**
   * Finalize a session: extract long-term memories and save working memory snapshot.
   * Called when a session completes.
   */
  async finalizeSession(
    sessionId: string,
    summary: string,
    events: LiveEvent[],
    client?: ResponsesClient,
    model?: string,
  ): Promise<void> {
    const wm = this.workingMemories.get(sessionId);

    // Save working memory entries from the session
    if (wm) {
      const notableEntries = wm.extractNotableEntries();
      for (const entry of notableEntries) {
        await this.longTerm.storeEntry(entry);
      }

      // Save snapshot for potential session restoration
      const snapshot = wm.snapshot();
      await this.store.saveSession(sessionId, snapshot.entries);
    }

    // Use LLM to extract valuable memories from session events
    if (client && model && summary) {
      try {
        const extracted = await this.longTerm.extractFromSession(summary, events, client, model);
        for (const entry of extracted) {
          await this.longTerm.storeEntry(entry);
        }
      } catch {
        // LLM extraction is best-effort
      }
    }

    // Cleanup working memory from active map
    this.workingMemories.delete(sessionId);

    // Periodic pruning (run every time, it's cheap)
    await this.longTerm.pruneStale();
  }

  // ─── Direct access for API layer ────────────────────────────────────

  getStore(): MemoryStore {
    return this.store;
  }

  getLongTerm(): LongTermMemory {
    return this.longTerm;
  }

  getAppContext(): AppContextMemory {
    return this.appContext;
  }
}

import { randomUUID } from "node:crypto";
import type { MemoryEntry, LiveEvent, ResponsesClient } from "./types.js";
import { MemoryStore } from "./memoryStore.js";

/** Long-term persistent memory across sessions */
export class LongTermMemory {
  constructor(private readonly store: MemoryStore) {}

  async storeEntry(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const full: MemoryEntry = {
      id: randomUUID(),
      createdAt: now,
      ...entry,
    };

    if (full.scope === "app" && full.appContext) {
      // Store in app profile
      let profile = await this.store.loadAppProfile(full.appContext);
      if (!profile) {
        profile = {
          appName: full.appContext,
          processNames: [],
          windowTitlePatterns: [],
          knownBehaviors: [],
          preferredInteraction: "hybrid",
          complexity: "moderate",
          memories: [],
        };
      }
      profile.memories.push(full);
      await this.store.saveAppProfile(profile);
    } else {
      // Store in global
      const globals = await this.store.loadGlobal();
      globals.push(full);
      await this.store.saveGlobal(globals);
    }

    return full;
  }

  /** Retrieve memories matching a query using keyword overlap scoring */
  async recall(query: string, appContext?: string, limit = 10): Promise<MemoryEntry[]> {
    const queryTokens = tokenize(query);
    const candidates: Array<{ entry: MemoryEntry; score: number }> = [];

    // Search global memories
    const globals = await this.store.loadGlobal();
    for (const entry of globals) {
      const score = computeScore(queryTokens, entry, appContext);
      if (score > 0) {
        candidates.push({ entry, score });
      }
    }

    // Search app-specific memories
    if (appContext) {
      const profile = await this.store.loadAppProfile(appContext);
      if (profile) {
        for (const entry of profile.memories) {
          const score = computeScore(queryTokens, entry, appContext) * 1.2; // boost app-specific
          if (score > 0) {
            candidates.push({ entry, score });
          }
        }
      }
    }

    // Sort by score descending, take top N
    candidates.sort((a, b) => b.score - a.score);
    const results = candidates.slice(0, limit).map((c) => c.entry);

    // Update access counts
    for (const entry of results) {
      entry.accessCount++;
      entry.lastAccessedAt = new Date().toISOString();
    }

    return results;
  }

  /** Use LLM to extract valuable memories from a session */
  async extractFromSession(
    summary: string,
    events: LiveEvent[],
    client: ResponsesClient,
    model: string,
  ): Promise<MemoryEntry[]> {
    // Build a condensed event log
    const eventSummary = events
      .filter((e) => ["tool_call", "computer_action", "message", "error"].includes(e.type))
      .slice(-30)
      .map((e) => `[${e.type}] ${e.message}`)
      .join("\n");

    const prompt = `Analyze this desktop automation session and extract valuable memories worth saving for future sessions. Focus on:
1. User preferences discovered (e.g., preferred apps, workflows)
2. App-specific knowledge (e.g., UI quirks, reliable interaction methods)
3. Procedures that worked well (step sequences for common tasks)
4. Important context (e.g., contacts, file locations, account info)

Session summary: ${summary}

Events:
${eventSummary}

Return a JSON array of memory objects. Each should have:
- category: "preference" | "app_knowledge" | "procedure" | "task_context"
- content: natural language description of what to remember
- tags: array of relevant keywords
- appContext: app name if app-specific (optional)
- confidence: 0.0-1.0 how valuable this memory is

Return ONLY the JSON array, no other text. If nothing worth remembering, return [].`;

    try {
      const response = await client.createResponse({
        model,
        instructions: "You are a memory extraction assistant. Return only valid JSON.",
        input: prompt,
      });

      const text = response.output_text.trim();
      // Try to parse JSON from the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        category: MemoryEntry["category"];
        content: string;
        tags: string[];
        appContext?: string;
        confidence: number;
      }>;

      const now = new Date().toISOString();
      return parsed.map((item) => ({
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        category: item.category || "task_context",
        appContext: item.appContext,
        scope: (item.appContext ? "app" : "global") as "app" | "global",
        content: item.content,
        accessCount: 0,
        lastAccessedAt: now,
        tags: item.tags || [],
        confidence: Math.min(1, Math.max(0, item.confidence || 0.5)),
      }));
    } catch {
      // If LLM extraction fails, return empty
      return [];
    }
  }

  /** Remove stale memories with low confidence or old access time */
  async pruneStale(maxAgeDays = 90, minConfidence = 0.2): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString();
    let pruned = 0;

    // Prune global
    const globals = await this.store.loadGlobal();
    const filtered = globals.filter((entry) => {
      if (entry.lastAccessedAt < cutoffStr && entry.confidence < minConfidence) {
        pruned++;
        return false;
      }
      // Decay confidence for old entries
      if (entry.lastAccessedAt < cutoffStr) {
        entry.confidence = Math.max(0, entry.confidence - 0.1);
      }
      return true;
    });
    if (pruned > 0) {
      await this.store.saveGlobal(filtered);
    }

    // Prune app profiles
    const profiles = await this.store.listAppProfiles();
    for (const profile of profiles) {
      const before = profile.memories.length;
      profile.memories = profile.memories.filter((entry) => {
        if (entry.lastAccessedAt < cutoffStr && entry.confidence < minConfidence) {
          return false;
        }
        if (entry.lastAccessedAt < cutoffStr) {
          entry.confidence = Math.max(0, entry.confidence - 0.1);
        }
        return true;
      });
      const diff = before - profile.memories.length;
      if (diff > 0) {
        pruned += diff;
        await this.store.saveAppProfile(profile);
      }
    }

    return pruned;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function computeScore(queryTokens: string[], entry: MemoryEntry, appContext?: string): number {
  const entryText = `${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
  const entryTokens = new Set(tokenize(entryText));

  let overlap = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) overlap++;
  }

  if (queryTokens.length === 0) return 0;
  let score = overlap / queryTokens.length;

  // Boost for matching app context
  if (appContext && entry.appContext === appContext) {
    score *= 1.3;
  }

  // Weight by confidence
  score *= entry.confidence;

  // Slight recency boost
  const age = Date.now() - new Date(entry.lastAccessedAt).getTime();
  const daysSinceAccess = age / (1000 * 60 * 60 * 24);
  if (daysSinceAccess < 7) score *= 1.1;

  return score;
}

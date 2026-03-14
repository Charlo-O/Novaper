import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  ResponsesClient,
  ConsolidationRecord,
  ConsolidationResult,
} from "./types.js";
import { MemoryStore } from "./memoryStore.js";
import { LongTermMemory } from "./longTermMemory.js";

/**
 * Memory consolidation service.
 *
 * Layer 1 (local, zero LLM): deduplication, pattern boosting, pruning.
 * Layer 2 (LLM-enhanced): cross-memory insight extraction & app profile synthesis.
 */
export class MemoryConsolidation {
  constructor(
    private readonly store: MemoryStore,
    private readonly longTerm: LongTermMemory,
  ) {}

  // ─── Layer 1 — Pure local (zero LLM) ─────────────────────────────

  /**
   * Deduplicate memories across global and all app profiles.
   * Uses Jaccard similarity on tokenized content+tags; threshold 0.6.
   */
  async deduplicateMemories(): Promise<{ mergedCount: number; removedIds: string[] }> {
    let mergedCount = 0;
    const removedIds: string[] = [];

    // Deduplicate global memories
    const globals = await this.store.loadGlobal();
    const globalResult = deduplicateList(globals);
    mergedCount += globalResult.mergedCount;
    removedIds.push(...globalResult.removedIds);
    if (globalResult.mergedCount > 0) {
      await this.store.saveGlobal(globalResult.entries);
    }

    // Deduplicate each app profile's memories
    const profiles = await this.store.listAppProfiles();
    for (const profile of profiles) {
      const result = deduplicateList(profile.memories);
      if (result.mergedCount > 0) {
        mergedCount += result.mergedCount;
        removedIds.push(...result.removedIds);
        profile.memories = result.entries;
        await this.store.saveAppProfile(profile);
      }
    }

    return { mergedCount, removedIds };
  }

  /**
   * Boost confidence for frequently recurring patterns.
   * Groups memories by (category, appContext); if a group has 3+ entries
   * with overlapping keywords, boost confidence by 0.1 (cap 1.0).
   */
  async boostFrequentPatterns(): Promise<number> {
    let boostedCount = 0;

    const allEntries = await this.gatherAllEntries();
    const groups = new Map<string, MemoryEntry[]>();

    for (const entry of allEntries) {
      const key = `${entry.category}::${entry.appContext ?? "global"}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }

    for (const group of groups.values()) {
      if (group.length < 3) continue;

      // Check for overlapping keywords
      const tokenSets = group.map((e) => new Set(tokenize(`${e.content} ${e.tags.join(" ")}`)));
      for (let i = 0; i < group.length; i++) {
        let overlapCount = 0;
        for (let j = 0; j < group.length; j++) {
          if (i === j) continue;
          const overlap = jaccard(tokenSets[i], tokenSets[j]);
          if (overlap > 0.3) overlapCount++;
        }
        if (overlapCount >= 2 && group[i].confidence < 1.0) {
          group[i].confidence = Math.min(1.0, group[i].confidence + 0.1);
          boostedCount++;
        }
      }
    }

    if (boostedCount > 0) {
      await this.saveAllEntries(allEntries);
    }

    return boostedCount;
  }

  // ─── Layer 2 — LLM enhanced ──────────────────────────────────────

  /**
   * Use LLM to consolidate unconsolidated memories: find connections,
   * merge duplicates, and extract insights.
   */
  async consolidateWithLLM(
    client: ResponsesClient,
    model: string,
  ): Promise<ConsolidationRecord | null> {
    const allEntries = await this.gatherAllEntries();
    const unconsolidated = allEntries.filter((e) => !e.consolidated);

    if (unconsolidated.length < 2) return null;

    // Limit batch size to keep prompt reasonable
    const batch = unconsolidated.slice(0, 30);

    const memoryDump = batch
      .map((e) => `[${e.id}] (${e.category}) ${e.content} [tags: ${e.tags.join(", ")}]`)
      .join("\n");

    const prompt = `Analyze these stored memories from a desktop automation assistant. Find connections, merge duplicates, and extract one key insight.

Memories:
${memoryDump}

Return a JSON object with:
- mergedIds: array of arrays — each inner array lists IDs that should be merged (they are duplicates or near-duplicates)
- connections: array of { fromId, toId, relationship } for meaningful cross-memory connections
- insight: a single sentence summarizing the most important pattern or insight across these memories
- summary: a brief summary of what was consolidated

Return ONLY the JSON object, no other text.`;

    const response = await client.createResponse({
      model,
      instructions: "You are a memory consolidation assistant. Return only valid JSON.",
      input: prompt,
    });

    const text = response.output_text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      mergedIds?: string[][];
      connections?: Array<{ fromId: string; toId: string; relationship: string }>;
      insight?: string;
      summary?: string;
    };

    const record: ConsolidationRecord = {
      id: randomUUID(),
      sourceIds: batch.map((e) => e.id),
      insight: parsed.insight ?? "",
      summary: parsed.summary ?? "",
      connections: parsed.connections ?? [],
      createdAt: new Date().toISOString(),
    };

    // Mark source memories as consolidated
    for (const entry of batch) {
      entry.consolidated = true;
    }
    await this.saveAllEntries(allEntries);

    // Persist the consolidation record
    await this.store.appendConsolidation(record);

    return record;
  }

  /**
   * Use LLM to update an app profile's knownBehaviors based on its memories.
   */
  async synthesizeAppProfile(
    appName: string,
    client: ResponsesClient,
    model: string,
  ): Promise<void> {
    const profile = await this.store.loadAppProfile(appName);
    if (!profile || profile.memories.length === 0) return;

    const memDump = profile.memories
      .map((e) => `- (${e.category}) ${e.content}`)
      .join("\n");

    const prompt = `Based on these memories about the app "${appName}", generate an updated list of known behaviors.

Current knownBehaviors: ${JSON.stringify(profile.knownBehaviors)}

Memories:
${memDump}

Return a JSON array of strings — each string is a concise known behavior or characteristic of this app. Keep existing valid behaviors, add new ones from the memories, remove outdated ones. Return ONLY the JSON array.`;

    const response = await client.createResponse({
      model,
      instructions: "You are an app profile synthesis assistant. Return only valid JSON.",
      input: prompt,
    });

    const text = response.output_text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const behaviors = JSON.parse(jsonMatch[0]) as string[];
    if (Array.isArray(behaviors)) {
      profile.knownBehaviors = behaviors;
      await this.store.saveAppProfile(profile);
    }
  }

  // ─── Entry points ────────────────────────────────────────────────

  /** Layer 1 only: dedup + boost + prune. No LLM needed. */
  async runLocal(): Promise<ConsolidationResult> {
    const { mergedCount } = await this.deduplicateMemories();
    const boostedCount = await this.boostFrequentPatterns();
    const prunedCount = await this.longTerm.pruneStale();

    return { mergedCount, boostedCount, prunedCount };
  }

  /** Full consolidation: Layer 1 + Layer 2. Requires LLM client. */
  async runFull(client: ResponsesClient, model: string): Promise<ConsolidationResult> {
    const local = await this.runLocal();

    let insight: string | undefined;
    let consolidationId: string | undefined;

    try {
      const record = await this.consolidateWithLLM(client, model);
      if (record) {
        insight = record.insight;
        consolidationId = record.id;
      }

      // Synthesize app profiles
      const profiles = await this.store.listAppProfiles();
      for (const profile of profiles) {
        if (profile.memories.length > 0) {
          try {
            await this.synthesizeAppProfile(profile.appName, client, model);
          } catch {
            // Per-app synthesis is best-effort
          }
        }
      }
    } catch {
      // LLM layer is best-effort; local results still valid
    }

    return {
      ...local,
      insight,
      consolidationId,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────

  /** Gather all memory entries from global + all app profiles. */
  private async gatherAllEntries(): Promise<MemoryEntry[]> {
    const globals = await this.store.loadGlobal();
    const profiles = await this.store.listAppProfiles();
    const appEntries = profiles.flatMap((p) => p.memories);
    return [...globals, ...appEntries];
  }

  /**
   * Save entries back to their respective stores.
   * Entries with scope "app" + appContext go to app profiles; others to global.
   */
  private async saveAllEntries(entries: MemoryEntry[]): Promise<void> {
    const globalEntries: MemoryEntry[] = [];
    const appGroups = new Map<string, MemoryEntry[]>();

    for (const entry of entries) {
      if (entry.scope === "app" && entry.appContext) {
        const list = appGroups.get(entry.appContext) ?? [];
        list.push(entry);
        appGroups.set(entry.appContext, list);
      } else {
        globalEntries.push(entry);
      }
    }

    await this.store.saveGlobal(globalEntries);

    for (const [appName, appEntries] of appGroups) {
      const profile = await this.store.loadAppProfile(appName);
      if (profile) {
        profile.memories = appEntries;
        await this.store.saveAppProfile(profile);
      }
    }
  }
}

// ─── Utility functions ──────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function deduplicateList(entries: MemoryEntry[]): {
  entries: MemoryEntry[];
  mergedCount: number;
  removedIds: string[];
} {
  const removed = new Set<string>();
  const removedIds: string[] = [];
  let mergedCount = 0;

  for (let i = 0; i < entries.length; i++) {
    if (removed.has(entries[i].id)) continue;

    const tokensI = tokenize(`${entries[i].content} ${entries[i].tags.join(" ")}`);

    for (let j = i + 1; j < entries.length; j++) {
      if (removed.has(entries[j].id)) continue;

      const tokensJ = tokenize(`${entries[j].content} ${entries[j].tags.join(" ")}`);
      const sim = jaccard(tokensI, tokensJ);

      if (sim > 0.6) {
        // Keep the one with higher confidence as the survivor
        const [survivor, victim] =
          entries[i].confidence >= entries[j].confidence ? [entries[i], entries[j]] : [entries[j], entries[i]];

        // Merge: union tags, sum accessCount, track mergedFrom
        const tagSet = new Set([...survivor.tags, ...victim.tags]);
        survivor.tags = [...tagSet];
        survivor.accessCount += victim.accessCount;
        survivor.mergedFrom = [...(survivor.mergedFrom ?? []), victim.id];
        survivor.updatedAt = new Date().toISOString();

        removed.add(victim.id);
        removedIds.push(victim.id);
        mergedCount++;
      }
    }
  }

  return {
    entries: entries.filter((e) => !removed.has(e.id)),
    mergedCount,
    removedIds,
  };
}

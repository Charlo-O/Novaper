export interface MemoryEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  category: "preference" | "app_knowledge" | "conversation" | "procedure" | "task_context";
  appContext?: string; // "WeChat", "WPS Office", "Chrome" etc.
  scope: "global" | "app" | "session";
  content: string; // natural language description
  accessCount: number;
  lastAccessedAt: string;
  expiresAt?: string; // TTL for working memory
  tags: string[];
  sourceSessionId?: string;
  confidence: number; // 0.0-1.0
  consolidated?: boolean; // marked after LLM consolidation
  mergedFrom?: string[]; // IDs of entries merged into this one
}

export interface AppProfile {
  appName: string;
  processNames: string[]; // process name detection
  windowTitlePatterns: string[];
  knownBehaviors: string[]; // e.g. "Qt-based, UIA unreliable"
  preferredInteraction: "uia" | "vision" | "hybrid";
  complexity: "simple" | "moderate" | "complex";
  memories: MemoryEntry[];
}

export interface WorkingMemoryState {
  sessionId: string;
  appContext: string;
  taskGoal: string;
  entries: MemoryEntry[];
  conversationTracker?: {
    contactName: string;
    lastMessages: Array<{ from: string; text: string; time: string }>;
    pendingReply: boolean;
  };
  progressState: Record<string, unknown>;
  lastObservation: string;
}

export interface WindowInfo {
  handle: string | number;
  title: string;
  processId: number;
  processName: string;
  isForeground: boolean;
}

export interface LiveEvent {
  id: string;
  sessionId: string;
  at: string;
  type: string;
  level: string;
  message: string;
  payload?: unknown;
}

export interface ConsolidationRecord {
  id: string;
  sourceIds: string[];
  insight: string;
  summary: string;
  connections: Array<{ fromId: string; toId: string; relationship: string }>;
  createdAt: string;
}

export interface ConsolidationResult {
  mergedCount: number;
  boostedCount: number;
  prunedCount: number;
  insight?: string;
  consolidationId?: string;
}

export interface ResponsesClient {
  createResponse(params: {
    model: string;
    instructions?: string;
    input: string;
  }): Promise<{ output_text: string }>;
}

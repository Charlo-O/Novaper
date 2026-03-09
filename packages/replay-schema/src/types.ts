export type AuthProvider = "api-key" | "codex-oauth";

export type RunStatus =
  | "Draft"
  | "PreparingMachine"
  | "Ready"
  | "Running"
  | "Retrying"
  | "Blocked"
  | "Verifying"
  | "Succeeded"
  | "Failed"
  | "Stopped";

export interface RunRecord {
  id: string;
  scenarioId: string;
  machineId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown>;
  model: string;
  authProvider?: AuthProvider;
  summary?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  replayDir: string;
  stopRequested?: boolean;
  retryOf?: string;
}

export type RunEventLevel = "info" | "warning" | "error";

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  type:
    | "status"
    | "log"
    | "tool_call"
    | "tool_result"
    | "computer_action"
    | "screenshot"
    | "verifier"
    | "error"
    | "final";
  level: RunEventLevel;
  message: string;
  payload?: unknown;
}

export interface ReplayManifest {
  run: RunRecord;
  eventsFile: string;
  screenshotsDir: string;
  artifacts: string[];
}

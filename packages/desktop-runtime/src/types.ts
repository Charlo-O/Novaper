export interface ScreenshotResult {
  imageBase64: string;
  width: number;
  height: number;
}

export interface WindowInfo {
  handle: string;
  title: string;
  processId: number;
  processName: string;
  isForeground: boolean;
}

export interface ApplicationMatch {
  name: string;
  source: "running_window" | "start_app" | "shortcut" | "app_path" | "explicit_path";
  launchType: "focus_window" | "shell_app" | "shortcut" | "command";
  target: string;
  score: number;
  handle?: string;
  title?: string;
  processName?: string;
  path?: string;
}

export interface ResolveApplicationResult {
  query: string;
  aliases: string[];
  candidates: ApplicationMatch[];
}

export interface OpenApplicationResult {
  opened: boolean;
  launchMethod: string;
  reusedWindow: boolean;
  pid?: number;
  candidate?: ApplicationMatch;
  window?: WindowInfo;
}

export interface WaitForProcessResult {
  found: boolean;
  pid?: number;
  processName?: string;
  elapsedMs: number;
  pids?: number[];
}

export interface WindowStateResult {
  matched: boolean;
  requireForeground: boolean;
  count: number;
  window?: WindowInfo;
  windows: WindowInfo[];
}

export interface HeartbeatResult {
  machineId: string;
  userName: string;
  interactiveSession: boolean;
  foregroundWindow?: WindowInfo;
  display: {
    width: number;
    height: number;
    scale: number;
  };
}

export interface UiSelector {
  name?: string;
  automationId?: string;
  className?: string;
  controlType?: string;
  processId?: number;
  processName?: string;
  windowTitleContains?: string;
  scope?: "children" | "descendants";
  maxResults?: number;
}

export interface UiElementInfo {
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  processId: number;
  isOffscreen: boolean;
  boundingRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type ComputerAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right" }
  | { type: "double_click"; x: number; y: number; button?: "left" | "right" }
  | { type: "drag"; path: Array<{ x: number; y: number }> }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x?: number; y?: number; scroll_x?: number; scroll_y?: number }
  | { type: "type"; text: string }
  | { type: "keypress"; keys: string[] }
  | { type: "wait"; duration_ms?: number }
  | { type: "screenshot" };

export interface ExecActionsResult {
  actions: Array<Record<string, unknown>>;
  screenshot: ScreenshotResult;
}

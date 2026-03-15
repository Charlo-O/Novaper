/**
 * Shared TypeScript types for all IPC channels between main and renderer processes.
 */

// ==================== Window Control ====================
export interface WindowControlChannels {
  "window-close": void;
  "window-minimize": void;
  "window-toggle-maximize": void;
  "is-fullscreen": boolean;
}

// ==================== WebView ====================
export interface WebViewSize {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebViewCreateResult {
  success: boolean;
  id?: string;
  hidden?: boolean;
  error?: string;
}

export interface WebViewChannels {
  "create-webview": { args: [id: string, url: string]; result: WebViewCreateResult };
  "show-webview": { args: [id: string]; result: { success: boolean; error?: string } };
  "hide-webview": { args: [id: string]; result: { success: boolean; error?: string } };
  "hide-all-webview": { args: []; result: void };
  "change-view-size": { args: [id: string, size: WebViewSize]; result: { success: boolean; error?: string } };
  "get-active-webview": { args: []; result: string[] };
  "capture-webview": { args: [id: string]; result: string | null };
  "webview-destroy": { args: [id: string]; result: { success: boolean; error?: string } };
  "set-size": { args: [size: WebViewSize]; result: void };
  "get-show-webview": { args: []; result: string[] };
}

// ==================== Files ====================
export interface FileChannels {
  "select-file": { args: [options?: any]; result: string | null };
  "read-file": { args: [filePath: string]; result: string };
}

// ==================== Skills ====================
export interface SkillEntry {
  name: string;
  content: string;
}

export interface SkillChannels {
  "get-skills-dir": { args: []; result: string };
  "skills-scan": { args: []; result: SkillEntry[] };
  "skill-write": { args: [skillDirName: string, content: string]; result: { success: boolean } };
  "skill-delete": { args: [skillDirName: string]; result: { success: boolean } };
}

// ==================== Browser Profiles ====================
export interface ProfileMetadata {
  name: string;
  browserKey: string;
  profileDirectory: string;
  seededFromLocal: boolean;
  seededAt: string;
  lastSyncedAt?: string;
}

export interface ProfileChannels {
  "list-browser-profiles": { args: []; result: ProfileMetadata[] };
  "import-browser-profile": { args: [browserKey: string, profileDir: string]; result: { success: boolean; name?: string; error?: string } };
  "switch-browser-profile": { args: [profileName: string]; result: { success: boolean; error?: string } };
}

// ==================== System ====================
export interface SystemChannels {
  "get-app-version": { args: []; result: string };
  "get-backend-port": { args: []; result: number };
  "export-log": { args: []; result: string | null };
  "restart-app": { args: []; result: void };
}

// ==================== Recording ====================
export interface RecordedActionIpc {
  id: string;
  seq: number;
  type: string;
  timestamp: number;
  target: {
    selector: string;
    xpath?: string;
    text?: string;
    tag: string;
    attributes?: Record<string, string>;
  };
  value?: string;
  position?: { x: number; y: number };
  screenshot_path?: string;
  description?: string;
}

export interface RecordingChannels {
  "start-recording": { args: [webviewId: string]; result: { success: boolean; error?: string } };
  "stop-recording": { args: [webviewId: string]; result: { success: boolean; actions?: RecordedActionIpc[]; error?: string } };
  "capture-action-screenshot": { args: [webviewId: string, actionSeq: number, workflowUuid: string]; result: { success: boolean; path?: string; error?: string } };
}

// ==================== Events (main → renderer) ====================
export interface EventChannels {
  "webview-navigated": [id: string, url: string];
  "url-updated": [url: string];
  "webview-show": [id: string];
  "protocol-url": [url: string];
  "backend-ready": [data: { success: boolean; port?: number; error?: string }];
  "recorded-action": [webviewId: string, action: RecordedActionIpc];
}

// ==================== All Invoke Channels ====================
export type InvokeChannels =
  & WindowControlChannels
  & WebViewChannels
  & FileChannels
  & SkillChannels
  & ProfileChannels
  & SystemChannels
  & RecordingChannels;

import type {
  ComputerAction,
  ExecActionsResult,
  HeartbeatResult,
  ScreenshotResult,
  UiElementInfo,
  UiSelector,
  WindowInfo,
} from "./types.js";

/**
 * Abstract interface for computer control backends.
 * Current implementation: LocalWindowsBackend (wrapping DesktopSidecar).
 * Future: CloudSandboxBackend, RemoteDesktopBackend, etc.
 */
export interface ComputerBackend {
  /** Capture current screen as base64 PNG */
  captureScreenshot(): Promise<ScreenshotResult>;

  /** List visible top-level windows */
  listWindows(): Promise<WindowInfo[]>;

  /** Execute batch of low-level desktop actions */
  execActions(args: { actions: ComputerAction[] }): Promise<ExecActionsResult>;

  /** Health check with machine metadata */
  heartbeat(): Promise<HeartbeatResult>;

  /** Launch a process/command */
  launchProcess(args: { command: string; args?: string[]; cwd?: string }): Promise<{ pid: number }>;

  /** Terminate a process */
  killProcess(args: { pid?: number; processName?: string }): Promise<{ killed: boolean }>;

  /** Focus a window by handle or title */
  focusWindow(args: { handle?: string; titleContains?: string }): Promise<{ focused: boolean }>;

  /** Check file existence and optionally read content */
  checkFile(args: { path: string; readText?: boolean }): Promise<Record<string, unknown>>;

  /** Move/rename a file */
  moveFile(args: { path: string; destination: string }): Promise<{ moved: boolean; destination: string }>;

  /** Find UI Automation elements */
  uiaFind(args: { selector: UiSelector }): Promise<UiElementInfo[]>;

  /** Invoke/click a UI Automation element */
  uiaInvoke(args: { selector: UiSelector }): Promise<{ invoked: boolean; element: UiElementInfo }>;

  /** Set value on a UI Automation edit field */
  uiaSetValue(args: { selector: UiSelector; value: string }): Promise<{ updated: boolean; element: UiElementInfo }>;

  /** Capture multiple frames at interval */
  captureFrameSequence?(count: number, intervalMs: number): Promise<Array<{ base64: string; timestamp: number }>>;

  /** Start screen recording */
  startScreenRecording?(opts: { fps?: number; outputPath: string }): Promise<{ recordingId: string }>;

  /** Stop screen recording */
  stopScreenRecording?(recordingId: string): Promise<{ filePath: string; duration: number }>;
}

/**
 * Local Windows backend wrapping the existing DesktopSidecar.
 * This is a pass-through implementation that delegates to the sidecar.
 */
export class LocalWindowsBackend implements ComputerBackend {
  constructor(private readonly sidecar: import("./sidecar.js").DesktopSidecar) {}

  captureScreenshot() {
    return this.sidecar.captureScreenshot();
  }

  listWindows() {
    return this.sidecar.listWindows();
  }

  execActions(args: { actions: ComputerAction[] }) {
    return this.sidecar.execActions(args);
  }

  heartbeat() {
    return this.sidecar.heartbeat();
  }

  launchProcess(args: { command: string; args?: string[]; cwd?: string }) {
    return this.sidecar.launchProcess(args);
  }

  killProcess(args: { pid?: number; processName?: string }) {
    return this.sidecar.killProcess(args);
  }

  focusWindow(args: { handle?: string; titleContains?: string }) {
    return this.sidecar.focusWindow(args);
  }

  checkFile(args: { path: string; readText?: boolean }) {
    return this.sidecar.checkFile(args);
  }

  moveFile(args: { path: string; destination: string }) {
    return this.sidecar.moveFile(args);
  }

  uiaFind(args: { selector: UiSelector }) {
    return this.sidecar.uiaFind(args);
  }

  uiaInvoke(args: { selector: UiSelector }) {
    return this.sidecar.uiaInvoke(args);
  }

  uiaSetValue(args: { selector: UiSelector; value: string }) {
    return this.sidecar.uiaSetValue(args);
  }

  captureFrameSequence(count: number, intervalMs: number) {
    return this.sidecar.captureFrameSequence(count, intervalMs);
  }

  startScreenRecording(opts: { fps?: number; outputPath: string }) {
    return this.sidecar.startScreenRecording(opts);
  }

  stopScreenRecording(recordingId: string) {
    return this.sidecar.stopScreenRecording(recordingId);
  }
}

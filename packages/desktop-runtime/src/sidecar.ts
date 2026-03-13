import { invokePowerShell } from "./powershell.js";
import type {
  ApplicationMatch,
  ComputerAction,
  ExecActionsResult,
  HeartbeatResult,
  OpenApplicationResult,
  ResolveApplicationResult,
  ScreenshotResult,
  UiElementInfo,
  UiSelector,
  WaitForProcessResult,
  WindowStateResult,
  WindowInfo,
} from "./types.js";

export class DesktopSidecar {
  captureScreenshot(): Promise<ScreenshotResult> {
    return invokePowerShell("capture_screenshot");
  }

  listWindows(): Promise<WindowInfo[]> {
    return invokePowerShell("list_windows");
  }

  resolveApplication(args: { name: string; aliases?: string[] }): Promise<ResolveApplicationResult> {
    return invokePowerShell("resolve_application", args);
  }

  openApplication(args: {
    name: string;
    aliases?: string[];
    arguments?: string[];
    preferWindowReuse?: boolean;
  }): Promise<OpenApplicationResult> {
    return invokePowerShell("open_application", args);
  }

  focusWindow(args: { handle?: string; titleContains?: string }): Promise<{ focused: boolean }> {
    return invokePowerShell("focus_window", args);
  }

  waitForProcess(args: { pid?: number; processName?: string; timeoutMs?: number }): Promise<WaitForProcessResult> {
    return invokePowerShell("wait_for_process", args);
  }

  waitForWindow(args: {
    handle?: string;
    titleContains?: string;
    processName?: string;
    timeoutMs?: number;
    requireForeground?: boolean;
  }): Promise<WindowStateResult> {
    return invokePowerShell("wait_for_window", args);
  }

  verifyWindowState(args: {
    handle?: string;
    titleContains?: string;
    processName?: string;
    requireForeground?: boolean;
  }): Promise<WindowStateResult> {
    return invokePowerShell("verify_window_state", args);
  }

  heartbeat(): Promise<HeartbeatResult> {
    return invokePowerShell("heartbeat");
  }

  launchProcess(args: { command: string; args?: string[]; cwd?: string }): Promise<{ pid: number }> {
    return invokePowerShell("launch_process", args);
  }

  killProcess(args: { pid?: number; processName?: string }): Promise<{ killed: boolean }> {
    return invokePowerShell("kill_process", args);
  }

  checkFile(args: { path: string; readText?: boolean }): Promise<Record<string, unknown>> {
    return invokePowerShell("check_file", args);
  }

  moveFile(args: { path: string; destination: string }): Promise<{ moved: boolean; destination: string }> {
    return invokePowerShell("move_file", args);
  }

  renameFile(args: { path: string; newName: string }): Promise<{ renamed: boolean; destination: string }> {
    return invokePowerShell("rename_file", args);
  }

  async uiaFind(args: { selector: UiSelector }): Promise<UiElementInfo[]> {
    const result = await invokePowerShell("uia_find", args);
    if (Array.isArray(result)) {
      return result as UiElementInfo[];
    }
    if (result && typeof result === "object" && "controlType" in result && "boundingRect" in result) {
      return [result as UiElementInfo];
    }
    if (result && typeof result === "object") {
      return [];
    }
    return [];
  }

  uiaInvoke(args: { selector: UiSelector }): Promise<{ invoked: boolean; element: UiElementInfo }> {
    return invokePowerShell("uia_invoke", args);
  }

  uiaSetValue(args: { selector: UiSelector; value: string }): Promise<{ updated: boolean; element: UiElementInfo }> {
    return invokePowerShell("uia_set_value", args);
  }

  execActions(args: { actions: ComputerAction[] }): Promise<ExecActionsResult> {
    return invokePowerShell("exec_actions", args);
  }

  setDisplayProfile(args: { width: number; height: number; scale: number }): Promise<Record<string, unknown>> {
    return invokePowerShell("set_display_profile", args);
  }

  // ─── Screen Recording (Phase 3) ────────────────────────────────────

  startScreenRecording(opts: { fps?: number; outputPath: string }): Promise<{ recordingId: string }> {
    return invokePowerShell("start_screen_recording", opts);
  }

  stopScreenRecording(recordingId: string): Promise<{ filePath: string; duration: number }> {
    return invokePowerShell("stop_screen_recording", { recordingId });
  }

  /** Capture N frames at a given interval. Returns array of base64 JPEG images. */
  async captureFrameSequence(count: number, intervalMs: number): Promise<Array<{ base64: string; timestamp: number }>> {
    const frames: Array<{ base64: string; timestamp: number }> = [];
    for (let i = 0; i < count; i++) {
      const screenshot = await this.captureScreenshot();
      frames.push({ base64: screenshot.imageBase64, timestamp: Date.now() });
      if (i < count - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return frames;
  }
}

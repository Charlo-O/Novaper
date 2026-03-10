import { invokePowerShell } from "./powershell.js";
import type {
  ComputerAction,
  ExecActionsResult,
  HeartbeatResult,
  ScreenshotResult,
  UiElementInfo,
  UiSelector,
  WindowInfo,
} from "./types.js";

export class DesktopSidecar {
  captureScreenshot(): Promise<ScreenshotResult> {
    return invokePowerShell("capture_screenshot");
  }

  listWindows(): Promise<WindowInfo[]> {
    return invokePowerShell("list_windows");
  }

  focusWindow(args: { handle?: string; titleContains?: string }): Promise<{ focused: boolean }> {
    return invokePowerShell("focus_window", args);
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

  uiaFind(args: { selector: UiSelector }): Promise<UiElementInfo[]> {
    return invokePowerShell("uia_find", args);
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

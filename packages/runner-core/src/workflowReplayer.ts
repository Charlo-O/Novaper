import { promises as fs } from "node:fs";
import path from "node:path";
import type { RecordedAction } from "../../../apps/runner/src/automationStore.js";
import type { BrowserSessionManager } from "../../browser-runtime/src/browserSessionManager.js";

export interface ReplayOptions {
  workflowUuid: string;
  workflowName: string;
  recordingUrl: string;
  actions: RecordedAction[];
  browserSession: BrowserSessionManager;
  sessionId: string;
  artifactDir: string;
  onAction?: (action: RecordedAction, index: number, screenshot?: string) => void;
  onComplete?: (result: ReplayResult) => void;
  onError?: (action: RecordedAction, index: number, error: string) => void;
  signal?: AbortSignal;
}

export interface ReplayResult {
  success: boolean;
  actionsExecuted: number;
  actionsTotal: number;
  duration_ms: number;
  screenshots: string[];
  errors: Array<{ actionSeq: number; error: string }>;
}

export interface ReplayProgress {
  status: "running" | "completed" | "failed" | "stopped";
  currentAction: number;
  totalActions: number;
  duration_ms: number;
  lastScreenshot?: string;
  errors: Array<{ actionSeq: number; error: string }>;
}

const activeReplays = new Map<string, { progress: ReplayProgress; abort: AbortController }>();

export function getReplayProgress(workflowUuid: string): ReplayProgress | null {
  return activeReplays.get(workflowUuid)?.progress ?? null;
}

export function stopReplay(workflowUuid: string): boolean {
  const entry = activeReplays.get(workflowUuid);
  if (!entry) return false;
  entry.abort.abort();
  entry.progress.status = "stopped";
  return true;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function replayWorkflow(options: ReplayOptions): Promise<ReplayResult> {
  const {
    workflowUuid,
    actions,
    browserSession,
    sessionId,
    artifactDir,
    onAction,
    onComplete,
    onError,
  } = options;

  const abortController = new AbortController();
  const signal = options.signal ?? abortController.signal;

  const screenshotDir = path.join(artifactDir, "workflows", workflowUuid, "replays", String(Date.now()));
  await ensureDir(screenshotDir);

  const progress: ReplayProgress = {
    status: "running",
    currentAction: 0,
    totalActions: actions.length,
    duration_ms: 0,
    errors: [],
  };

  activeReplays.set(workflowUuid, { progress, abort: abortController });

  const startTime = Date.now();
  const screenshots: string[] = [];
  const errors: Array<{ actionSeq: number; error: string }> = [];
  let actionsExecuted = 0;

  try {
    // Navigate to starting URL
    if (options.recordingUrl) {
      await browserSession.navigate(sessionId, { url: options.recordingUrl });
      await delay(2000);
    }

    for (let i = 0; i < actions.length; i++) {
      if (signal.aborted) break;

      const action = actions[i];
      progress.currentAction = i;
      progress.duration_ms = Date.now() - startTime;

      try {
        await executeAction(browserSession, sessionId, action);
        actionsExecuted++;

        // Wait for page to settle after action
        await delay(actionDelay(action));

        // Capture screenshot
        try {
          const screenshotPath = path.join(screenshotDir, `action-${action.seq}.png`);
          const snapshotResult = await browserSession.snapshot(sessionId, { maxElements: 0 });
          if (snapshotResult && "screenshot" in snapshotResult && snapshotResult.screenshot) {
            const base64Data = (snapshotResult.screenshot as string).replace(/^data:image\/\w+;base64,/, "");
            await fs.writeFile(screenshotPath, Buffer.from(base64Data, "base64"));
            screenshots.push(screenshotPath);
            progress.lastScreenshot = screenshotPath;
          }
        } catch {
          // Screenshot failure is non-fatal
        }

        onAction?.(action, i, progress.lastScreenshot);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ actionSeq: action.seq, error: errorMsg });
        progress.errors.push({ actionSeq: action.seq, error: errorMsg });
        onError?.(action, i, errorMsg);

        // Continue to next action on non-critical errors
        if (isCriticalError(errorMsg)) {
          break;
        }
      }
    }

    const result: ReplayResult = {
      success: errors.length === 0 && !signal.aborted,
      actionsExecuted,
      actionsTotal: actions.length,
      duration_ms: Date.now() - startTime,
      screenshots,
      errors,
    };

    progress.status = signal.aborted ? "stopped" : errors.length === 0 ? "completed" : "failed";
    progress.duration_ms = result.duration_ms;

    onComplete?.(result);
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const result: ReplayResult = {
      success: false,
      actionsExecuted,
      actionsTotal: actions.length,
      duration_ms: Date.now() - startTime,
      screenshots,
      errors: [...errors, { actionSeq: -1, error: errorMsg }],
    };

    progress.status = "failed";
    progress.duration_ms = result.duration_ms;
    progress.errors.push({ actionSeq: -1, error: errorMsg });

    onComplete?.(result);
    return result;
  } finally {
    // Clean up after a delay to allow status polling
    setTimeout(() => activeReplays.delete(workflowUuid), 60_000);
  }
}

async function executeAction(
  browser: BrowserSessionManager,
  sessionId: string,
  action: RecordedAction,
) {
  switch (action.type) {
    case "click":
      await browser.click(sessionId, {
        selector: action.target.selector,
        text: action.target.text,
        x: action.position?.x,
        y: action.position?.y,
      });
      break;

    case "dblclick":
      // Double-click via two rapid clicks
      await browser.click(sessionId, {
        selector: action.target.selector,
        text: action.target.text,
        x: action.position?.x,
        y: action.position?.y,
      });
      await delay(50);
      await browser.click(sessionId, {
        selector: action.target.selector,
        text: action.target.text,
        x: action.position?.x,
        y: action.position?.y,
      });
      break;

    case "type":
      if (action.value != null) {
        await browser.type(sessionId, {
          selector: action.target.selector || undefined,
          text: action.value,
          clear: true,
        });
      }
      break;

    case "keypress":
      if (action.value) {
        await browser.pressKeys(sessionId, {
          keys: action.value.split("+"),
        });
      }
      break;

    case "navigate":
      if (action.value) {
        await browser.navigate(sessionId, { url: action.value });
      }
      break;

    case "scroll":
      await browser.scroll(sessionId, {
        x: action.position?.x ?? 0,
        y: action.position?.y ?? 300,
      });
      break;

    case "select":
      // Select is handled via click + type for now
      if (action.target.selector && action.value != null) {
        await browser.click(sessionId, { selector: action.target.selector });
        await delay(200);
        await browser.type(sessionId, { text: action.value, submit: true });
      }
      break;

    case "hover":
      // Hover via moving mouse to element position
      if (action.position) {
        await browser.click(sessionId, {
          x: action.position.x,
          y: action.position.y,
        });
      }
      break;

    case "wait":
      await delay(action.timestamp || 1000);
      break;
  }
}

function actionDelay(action: RecordedAction): number {
  switch (action.type) {
    case "navigate":
      return 3000;
    case "click":
    case "dblclick":
      return 1000;
    case "type":
      return 500;
    case "scroll":
      return 800;
    default:
      return 500;
  }
}

function isCriticalError(error: string): boolean {
  return /target closed|browser.*closed|navigation.*failed|page.*crashed/i.test(error);
}

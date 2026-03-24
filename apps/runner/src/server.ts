import express from "express";
import archiver from "archiver";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AuthProvider } from "../../../packages/replay-schema/src/types.js";
import { loadScenarios } from "../../../packages/scenario-kit/src/loadScenarios.js";
import { RunStore } from "./store.js";
import { LiveSessionStore } from "./liveStore.js";
import {
  getAgentDriver,
  normalizeAgentConfig,
  normalizeAgentDriverId,
} from "./agentDrivers.js";
import { executeRun } from "../../../packages/runner-core/src/runExecutor.js";
import { DesktopSidecar } from "../../../packages/desktop-runtime/src/sidecar.js";
import { driveDesktopAgent, type DesktopAgentToolCall } from "../../../packages/runner-core/src/desktopAgent.js";
import { drivePiAgent } from "../../../packages/runner-core/src/piAgent.js";
import {
  buildActiveSkillsPrompt,
  buildCapabilityPrompt,
  buildCapabilitySnapshot,
  type PromptSkill,
} from "../../../packages/runner-core/src/capabilityProfile.js";
import { classifyInstruction, type AgentRoute } from "../../../packages/runner-core/src/instructionClassifier.js";
import {
  planTasks,
  getNextTask,
  updateTaskStatus,
  isPlanComplete,
  formatPlan,
  type TaskExecutionMethod,
  type TaskPlanItem,
} from "../../../packages/runner-core/src/taskPlanner.js";
import { AuthService } from "./authService.js";
import { getProxyStatus } from "./networkProxy.js";
import { LogCollector } from "./logCollector.js";
import { MemoryManager } from "../../../packages/memory/src/memoryManager.js";
import { FrameStreamer } from "../../../packages/runner-core/src/videoObserver.js";
import { BrowserSessionManager } from "../../../packages/browser-runtime/src/browserSessionManager.js";
import { AutomationStore } from "./automationStore.js";
import type { RecordedAction } from "./automationStore.js";
import { replayWorkflow, getReplayProgress, stopReplay as stopReplayEngine } from "../../../packages/runner-core/src/workflowReplayer.js";
import { DeviceStore, type StoredDeviceRecord } from "./deviceStore.js";
import { PluginStore } from "./pluginStore.js";
import type { ResponsesClient } from "../../../packages/runner-core/src/responsesClient.js";

function normalizeRequestedProvider(input: unknown) {
  return input === "api-key" || input === "codex-oauth" ? input : undefined;
}

function authErrorStatus(message: string) {
  return /not configured|not authenticated|No auth provider/i.test(message) ? 400 : 500;
}

function canReuseResponseChain(authProvider?: AuthProvider) {
  return authProvider !== "codex-oauth";
}

interface VerificationAssessment {
  verified: boolean;
  evidence: string[];
  missingReason?: string;
}

interface VisualVerificationAssessment {
  verified: boolean;
  evidence: string[];
  reason?: string;
}

function summarizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function taskAllowsVisionFallback(task: TaskPlanItem) {
  if ((task.preferredMethods ?? []).includes("vision")) {
    return true;
  }

  return (task.fallbackPolicy ?? []).some((item) => /visual|screenshot|desktop_actions|vision/i.test(item));
}

function extractResponseText(response: { output_text?: string; output?: unknown[] }) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object" || !("type" in item) || item.type !== "message") {
        return [];
      }

      const content = "content" in item && Array.isArray(item.content) ? item.content : [];
      return content
        .map((part) => {
          if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
            return part.text;
          }
          return "";
        })
        .filter(Boolean);
    })
    .join("\n")
    .trim();
}

function parseVisualVerificationAssessment(text: string): VisualVerificationAssessment {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.map((item) => String(item)).filter(Boolean)
      : [];
    return {
      verified: parsed.verified === true,
      evidence,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined,
    };
  } catch {
    return {
      verified: false,
      evidence: [],
      reason: trimmed || "Visual verification response could not be parsed.",
    };
  }
}

async function runVisualVerificationPass(input: {
  client: ResponsesClient;
  model: string;
  sidecar: DesktopSidecar;
  task: TaskPlanItem;
}) {
  const screenshot = await input.sidecar.captureScreenshot();
  const response = await input.client.createResponse({
    model: input.model,
    input: [
      {
        role: "developer",
        content:
          "You verify whether a desktop step is complete from a screenshot. Use only visible evidence. Return JSON only with keys verified (boolean), evidence (array of short strings), and reason (string, optional). Set verified=true only when the screenshot clearly shows the goal has been achieved.",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "[Visual Verification]",
              `Step title: ${input.task.title}`,
              `Goal: ${input.task.description}`,
              ...(input.task.successCriteria?.length
                ? ["Success criteria:", ...input.task.successCriteria.map((criterion) => `- ${criterion}`)]
                : []),
              `Screen size: ${screenshot.width}x${screenshot.height}`,
              "Judge only from what is visible in this screenshot. If the screenshot does not clearly prove completion, return verified=false.",
            ].join("\n"),
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${screenshot.imageBase64}`,
            detail: "high",
          },
        ],
      },
    ],
  });

  return parseVisualVerificationAssessment(extractResponseText(response));
}

function formatMethod(method: TaskExecutionMethod) {
  switch (method) {
    case "system_launch":
      return "system-level launch";
    case "browser_dom":
      return "browser DOM tools";
    case "uia":
      return "UI Automation";
    case "window_tools":
      return "window/process tools";
    case "vision":
      return "visual fallback";
    case "cli":
      return "CLI tools";
    default:
      return method;
  }
}

function buildTaskExecutionInstruction(task: TaskPlanItem) {
  const lines = [
    "[Planned Step]",
    `Step title: ${task.title}`,
    `Goal: ${task.description}`,
    `Atomic step: ${task.atomic === false ? "no" : "yes"}`,
  ];

  if (task.preferredMethods && task.preferredMethods.length > 0) {
    lines.push(`Preferred method order: ${task.preferredMethods.map(formatMethod).join(" -> ")}`);
  }

  if (task.successCriteria && task.successCriteria.length > 0) {
    lines.push("Success criteria:");
    for (const criterion of task.successCriteria) {
      lines.push(`- ${criterion}`);
    }
  }

  if (task.fallbackPolicy && task.fallbackPolicy.length > 0) {
    lines.push("Fallback policy:");
    for (const item of task.fallbackPolicy) {
      lines.push(`- ${item}`);
    }
  }

  if (task.replanHint) {
    lines.push(`Re-plan hint: ${task.replanHint}`);
  }

  lines.push("Execute only the current step.");
  lines.push("Use the preferred method order whenever possible.");
  if (taskAllowsVisionFallback(task)) {
    lines.push("If UI Automation or detect_elements returns no match, an empty result, or an error, stop retrying the same selector and switch to screenshot-driven desktop_actions.");
  }
  lines.push("Before you finish, verify the success criteria with tools or a fresh observation.");
  lines.push("If the criteria are not satisfied, do not declare success. Either perform one corrective action or explain that the step is still incomplete.");

  return lines.join("\n");
}

function buildVerificationFollowUpInstruction(task: TaskPlanItem, assessment: VerificationAssessment) {
  const lines = [
    "[Verification Pass]",
    `Re-check the planned step: ${task.title}`,
    `Goal: ${task.description}`,
    assessment.missingReason ? `Missing verification: ${assessment.missingReason}` : "Missing verification evidence.",
    "Do not restart the whole task.",
    "First inspect the current state and verify whether the step has actually succeeded.",
    "Prefer verification tools such as verify_window_state, wait_for_window, wait_for_process, browser_snapshot, browser_read, browser_wait_for, uia_find, or list_windows.",
    "If the step is not complete, you may take at most one corrective action and then verify again.",
    "Do not declare completion without evidence.",
  ];

  if (taskAllowsVisionFallback(task)) {
    lines.push("If UI Automation tools or detect_elements fail, return empty, or stay unreliable, inspect the latest screenshot and continue with desktop_actions instead of repeating the same UIA query.");
    lines.push("After a visual corrective action, re-check the visible result before answering.");
  }

  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function evaluateTaskVerification(task: TaskPlanItem, toolCalls: DesktopAgentToolCall[]): VerificationAssessment {
  const evidence: string[] = [];
  let processVerified = false;
  let windowVerified = false;
  let browserVerified = false;
  let uiaVerified = false;

  for (const call of toolCalls) {
    const result = call.result;
    if (call.name === "wait_for_process" && isRecord(result) && result.found === true) {
      processVerified = true;
      evidence.push(`process detected via ${call.name}`);
    }

    if ((call.name === "wait_for_window" || call.name === "verify_window_state") && isRecord(result) && result.matched === true) {
      windowVerified = true;
      evidence.push(`window verified via ${call.name}`);
    }

    if (call.name === "focus_window" && isRecord(result) && result.focused === true) {
      windowVerified = true;
      evidence.push("window focused");
    }

    if (call.name === "open_application" && isRecord(result)) {
      if (result.reusedWindow === true || isRecord(result.window)) {
        windowVerified = true;
        evidence.push(`application reused existing window via ${String(result.launchMethod ?? "open_application")}`);
      }
    }

    if ((call.name === "browser_snapshot" || call.name === "browser_read" || call.name === "browser_wait_for") && isRecord(result)) {
      if (result.strategy === "playwright") {
        browserVerified = true;
        evidence.push(`browser state verified via ${call.name}`);
      }
    }

    if (call.name === "uia_find" && isNonEmptyArray(result)) {
      uiaVerified = true;
      evidence.push("UI Automation found matching elements");
    }

    if ((call.name === "uia_invoke" || call.name === "uia_set_value") && isRecord(result)) {
      if (result.invoked === true || result.updated === true) {
        uiaVerified = true;
        evidence.push(`UI Automation confirmed via ${call.name}`);
      }
    }
  }

  const methods = new Set(task.preferredMethods ?? []);
  const needsBrowser = methods.has("browser_dom");
  const needsSystem = methods.has("system_launch") || methods.has("window_tools");
  const needsUia = methods.has("uia");

  const verified =
    (needsBrowser && browserVerified) ||
    (needsSystem && (windowVerified || processVerified)) ||
    (needsUia && (uiaVerified || windowVerified)) ||
    (!needsBrowser && !needsSystem && !needsUia && evidence.length > 0);

  if (verified) {
    return {
      verified: true,
      evidence: Array.from(new Set(evidence)),
    };
  }

  let missingReason = "No verification signal matched the planned success criteria.";
  if (needsBrowser && !browserVerified) {
    missingReason = "The step expected browser verification, but no browser_* verification tool succeeded.";
  } else if (needsSystem && !windowVerified && !processVerified) {
    missingReason = "The step expected process or window verification after launch, but none was recorded.";
  } else if (needsUia && !uiaVerified && !windowVerified) {
    missingReason = "The step expected UI Automation or window verification, but none was recorded.";
  }

  return {
    verified: false,
    evidence: Array.from(new Set(evidence)),
    missingReason,
  };
}

function buildLiveDeveloperPrompt(options?: {
  capabilityBrief?: string;
  skills?: PromptSkill[];
}) {
  const sections = [
    [
      "You are a live Windows desktop assistant similar to an interactive computer-use operator.",
      "The human is watching the current desktop and will send one instruction at a time.",
      "For every instruction, inspect the current desktop state before acting.",
      "Work in rolling steps: observe state, perform one minimal verifiable action, verify the result, then decide the next step.",
      "Prefer tools in this order: 1) browser_* tools for web pages in Chrome, Edge, or other Chromium browsers, 2) UI Automation and deterministic desktop tools, 3) process/file/window tools, 4) desktop_actions for coordinate-based visual fallback, 5) the computer tool when available.",
      "When the instruction requires opening software, use resolve_application, open_application, wait_for_process, wait_for_window, verify_window_state, and focus_window before any coordinate clicks.",
      "When the task is happening inside a web page, use browser_snapshot before interacting and prefer browser_click, browser_type, browser_press_keys, browser_tabs, and browser_read over desktop clicks.",
      "The browser_* tools use Playwright with a persisted automation profile copied from the local Chromium profile. If any browser_* result reports strategy='visual' or requiresDesktopActions=true, stop relying on DOM selectors and continue with desktop_actions against the attached desktop screenshot.",
      "Never claim a desktop task is complete until you have used at least one tool during the current instruction.",
      "Never claim success for opening an app unless a process or window check confirms the target exists.",
      "Never claim success for search, playback, sending, or navigation tasks unless the post-action state visibly confirms the requested outcome.",
      "WeChat, WPS, and other Qt or custom-drawn apps often expose unreliable UI Automation trees. In those apps, prefer screenshot-driven desktop_actions over stubborn UIA retries.",
      "For chat apps such as WeChat, verify message delivery on the next screenshot. If the text is still in the input box, try the alternate send method such as Enter, Ctrl+Enter, or clicking the Send button.",
      "Only say a chat message was sent when a post-action screenshot shows the input box cleared or the message bubble appearing in the conversation.",
      "Do only what the current user instruction requires. When the instruction is complete, stop and summarize briefly.",
      "If the instruction is ambiguous, ask a short clarification instead of guessing.",
      "If you hit a CAPTCHA, verification code, or login wall that you cannot solve, skip it and try an alternative path to complete the task. Only stop and explain if there is truly no alternative.",
      "If you hit UAC or a system security prompt, stop and explain the blocker.",
      "When an action produces no visible change after execution, do not repeat it. Try a different tool, different coordinates, or a different workflow.",
      "When a desktop screenshot is attached, treat it as the current visual state. Use absolute pixel coordinates from that screenshot for desktop_actions.",
    ].join("\n"),
  ];

  if (options?.capabilityBrief?.trim()) {
    sections.push(options.capabilityBrief.trim());
  }

  const skillsPrompt = buildActiveSkillsPrompt(options?.skills);
  if (skillsPrompt) {
    sections.push(skillsPrompt);
  }

  return sections.join("\n\n");
}

async function saveLiveObservation(sessionArtifactDir: string, sessionId: string, base64Image: string) {
  const fileName = `observe-${Date.now()}.png`;
  const filePath = path.join(sessionArtifactDir, "screenshots", fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(base64Image, "base64"));
  return `/artifacts/live/${sessionId}/screenshots/${fileName}`;
}

async function loadCapabilityContext(pluginStore: PluginStore) {
  const [enabledSkills, mcpServers] = await Promise.all([
    pluginStore.getEnabledSkills(),
    pluginStore.listMcpServers(),
  ]);
  const skills = enabledSkills.map((skill) => ({
    name: skill.name,
    content: skill.content,
    description: skill.description,
  }));
  const snapshot = buildCapabilitySnapshot({
    enabledSkills,
    mcpServers,
  });

  return {
    enabledSkills,
    skills,
    snapshot,
    capabilityBrief: buildCapabilityPrompt(snapshot),
  };
}

export async function createServer(config: {
  rootDir: string;
  port: number;
  host: string;
  model: string;
  openAIApiKey?: string;
  webViewManager?: unknown;
}) {
  const app = express();
  const operatorWebDir = path.join(config.rootDir, "apps", "operator-web", "dist");
  const store = new RunStore(path.join(config.rootDir, "data", "runs"));
  const liveStore = new LiveSessionStore(path.join(config.rootDir, "data", "live-sessions"));
  const sidecar = new DesktopSidecar();
  const authService = new AuthService(config.rootDir, config.openAIApiKey);
  let browserSessionManager: any;
  if (config.webViewManager) {
    const { ElectronBrowserAdapter } = await import(
      "../../../electron/main/electronBrowserAdapter.js"
    );
    browserSessionManager = new ElectronBrowserAdapter(config.webViewManager as any);
  } else {
    browserSessionManager = new BrowserSessionManager({
      rootDir: config.rootDir,
      sidecar,
    });
  }
  const automationStore = new AutomationStore(path.join(config.rootDir, "data", "automation"));
  const deviceStore = new DeviceStore(path.join(config.rootDir, "data", "devices"));
  const pluginStore = new PluginStore(config.rootDir);
  const scenarios = await loadScenarios(path.join(config.rootDir, "scenarios"));
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario.manifest.id, scenario]));

  // Initialize log collector
  const logCollector = new LogCollector(path.join(config.rootDir, "data", "logs"));
  await logCollector.init();

  // Initialize memory manager
  const memoryManager = new MemoryManager(path.join(config.rootDir, "data", "memory"));
  await memoryManager.init();

  // Start background memory consolidation (every 30 minutes)
  memoryManager.startConsolidationLoop(30 * 60 * 1000, async () => {
    try {
      const auth = await authService.getResponsesClient();
      return { client: auth.client as unknown as import("../../../packages/memory/src/types.js").ResponsesClient, model: config.model };
    } catch {
      return null;
    }
  });

  // Restore persisted data from disk on startup
  await Promise.all([
    store.loadFromDisk(),
    liveStore.loadFromDisk(),
    automationStore.loadFromDisk(),
    deviceStore.loadFromDisk(),
  ]);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(operatorWebDir));
  app.use("/artifacts", express.static(path.join(config.rootDir, "data", "runs")));
  app.use("/artifacts/live", express.static(path.join(config.rootDir, "data", "live-sessions")));

  const runningScheduledTasks = new Set<string>();
  const automationBaseUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;

  function mapDeviceRecord(device: StoredDeviceRecord) {
    const now = Date.now();
    return {
      id: device.id,
      serial: device.serial,
      model: device.model,
      status: "device",
      connection_type: device.connection_type,
      state: "online",
      is_available_only: false,
      display_name: device.display_name,
      group_id: device.group_id || "default",
      agent: {
        state: "idle",
        created_at: now,
        last_used: now,
        error_message: null,
        model_name: config.model,
      },
    };
  }

  async function syncPrimaryDevice() {
    const heartbeat = await sidecar.heartbeat();
    await deviceStore.syncPrimaryDevice(heartbeat.machineId || "NOVAPER-DESKTOP");
    return heartbeat;
  }

  async function waitForSessionToSettle(sessionId: string, timeoutMs = 15 * 60 * 1000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const sessionState = liveStore.getSession(sessionId);
      if (!sessionState) {
        throw new Error(`Live session disappeared: ${sessionId}`);
      }
      if (sessionState.status === "idle" || sessionState.status === "error") {
        return sessionState;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Live session timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  async function queueScheduledTaskRun(taskId: string, trigger: "manual" | "scheduled") {
    if (runningScheduledTasks.has(taskId)) {
      return { queued: false, reason: "already-running" as const };
    }

    const task = automationStore.getScheduledTask(taskId);
    if (!task) {
      throw new Error("Scheduled task not found.");
    }

    const workflow = automationStore.getWorkflow(task.workflow_uuid);
    if (!workflow) {
      throw new Error(`Workflow not found for scheduled task: ${task.workflow_uuid}`);
    }

    runningScheduledTasks.add(taskId);
    await automationStore.recordTaskRunStart(taskId, `${trigger === "manual" ? "Manual" : "Scheduled"} run queued.`);

    void (async () => {
      try {
        // Recorded workflow: use replay engine directly
        if (workflow.type === "recorded" && workflow.recorded_actions?.length) {
          const sessionId = `scheduled-${workflow.uuid}-${Date.now()}`;
          await browserSessionManager.open(sessionId, { url: workflow.recording_url });

          const result = await replayWorkflow({
            workflowUuid: workflow.uuid,
            workflowName: workflow.name,
            recordingUrl: workflow.recording_url || "",
            actions: workflow.recorded_actions,
            browserSession: browserSessionManager,
            sessionId,
            artifactDir: path.join(config.rootDir, "data"),
          });

          await automationStore.recordTaskRunResult(task.id, {
            success: result.success,
            message: result.success
              ? `Replay completed: ${result.actionsExecuted}/${result.actionsTotal} actions.`
              : `Replay failed: ${result.errors.map((e) => e.error).join("; ")}`,
            successCount: result.success ? 1 : 0,
            totalCount: 1,
          });
        } else {
          // Manual workflow: use AI-driven execution
          const authStatus = await authService.getStatus();
          const authProvider = authStatus.defaultProvider;
          if (!authProvider) {
            throw new Error("No auth provider is configured for automation runs.");
          }

          const session = await liveStore.createSession(config.model, authProvider as AuthProvider);
          await liveStore.appendEvent(session.id, {
            type: "status",
            level: "info",
            message: `${trigger === "manual" ? "Manual" : "Scheduled"} workflow run started.`,
            payload: {
              scheduledTaskId: task.id,
              workflowUuid: workflow.uuid,
              workflowName: workflow.name,
            },
          });

          const instruction = [
            `Workflow: ${workflow.name}`,
            "Execute the following workflow exactly as a local automation task.",
            workflow.text,
          ].join("\n\n");

          const commandResponse = await fetch(`${automationBaseUrl}/api/live-sessions/${session.id}/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instruction,
              authProvider,
              model: config.model,
            }),
          });

          if (!commandResponse.ok) {
            const errorText = await commandResponse.text();
            throw new Error(`Automation launch failed: HTTP ${commandResponse.status} ${errorText}`);
          }

          const settledSession = await waitForSessionToSettle(session.id);
          const success = settledSession.status !== "error";
          const message = success
            ? settledSession.latestSummary ?? "Workflow completed."
            : settledSession.error ?? "Workflow failed.";

          await automationStore.recordTaskRunResult(task.id, {
            success,
            message,
            successCount: success ? 1 : 0,
            totalCount: 1,
          });
        }
      } catch (error) {
        await automationStore.recordTaskRunResult(taskId, {
          success: false,
          message: error instanceof Error ? error.message : String(error),
          successCount: 0,
          totalCount: 1,
        });
      } finally {
        runningScheduledTasks.delete(taskId);
      }
    })();

    return { queued: true as const };
  }

  function startAutomationScheduler() {
    const tick = async () => {
      const dueTasks = automationStore.listDueScheduledTasks();
      for (const task of dueTasks) {
        if (runningScheduledTasks.has(task.id)) {
          continue;
        }
        try {
          await queueScheduledTaskRun(task.id, "scheduled");
        } catch {
          // best effort
        }
      }
    };

    void tick();
    setInterval(() => {
      void tick();
    }, 30_000);
  }

  app.get("/api/system/health", async (_request, response) => {
    const [heartbeat, auth] = await Promise.all([sidecar.heartbeat(), authService.getStatus()]);
    response.json({
      ok: true,
      version: "0.1.0",
      machine: heartbeat,
      scenarios: scenarios.length,
      auth,
      proxy: getProxyStatus(),
    });
  });

  app.get("/api/system/capabilities", async (_request, response) => {
    const capabilityContext = await loadCapabilityContext(pluginStore);
    response.json(capabilityContext.snapshot);
  });

  app.get("/api/auth/status", async (_request, response) => {
    response.json(await authService.getStatus());
  });

  app.get("/api/devices", async (_request, response) => {
    await syncPrimaryDevice();
    response.json({
      devices: deviceStore.listDevices().map(mapDeviceRecord),
    });
  });

  app.post("/api/devices/connect-wifi", async (request, response) => {
    await syncPrimaryDevice();
    const deviceId = String(request.body?.device_id ?? DeviceStore.PRIMARY_DEVICE_ID).trim();
    try {
      const device = await deviceStore.setConnectionType(deviceId, "wifi");
      response.json({
        success: true,
        message: "Connected over WiFi.",
        device_id: device.id,
      });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/devices/disconnect-wifi", async (request, response) => {
    await syncPrimaryDevice();
    const deviceId = String(request.body?.device_id ?? "").trim();
    if (!deviceId) {
      response.status(400).json({ error: "device_id is required." });
      return;
    }
    try {
      await deviceStore.setConnectionType(deviceId, "usb");
      response.json({
        success: true,
        message: "Disconnected WiFi device.",
      });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/devices/manual-wifi", async (request, response) => {
    await syncPrimaryDevice();
    const ip = String(request.body?.ip ?? "").trim();
    const port = Number(request.body?.port ?? 5555);
    if (!ip) {
      response.status(400).json({ error: "ip is required." });
      return;
    }
    const device = await deviceStore.addManualWifiDevice({
      ip,
      port: Number.isFinite(port) ? port : 5555,
    });
    response.json({
      success: true,
      message: "Manual WiFi device added.",
      device_id: device.id,
    });
  });

  app.put("/api/devices/:serial/name", async (request, response) => {
    await syncPrimaryDevice();
    const serial = String(request.params.serial ?? "").trim();
    const displayName =
      request.body?.display_name == null ? null : String(request.body.display_name).trim() || null;
    try {
      const device = await deviceStore.updateDeviceName(serial, displayName);
      response.json({
        success: true,
        serial: device.serial,
        display_name: device.display_name,
      });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/devices/:serial/name", async (request, response) => {
    await syncPrimaryDevice();
    const serial = String(request.params.serial ?? "").trim();
    const device = deviceStore.getDeviceBySerial(serial);
    if (!device) {
      response.status(404).json({ error: `Device not found: ${serial}` });
      return;
    }
    response.json({
      success: true,
      serial,
      display_name: device.display_name,
    });
  });

  app.get("/api/device-groups", async (_request, response) => {
    await syncPrimaryDevice();
    response.json({
      groups: deviceStore.listGroupsWithCounts(),
    });
  });

  app.post("/api/device-groups", async (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    if (!name) {
      response.status(400).json({ error: "name is required." });
      return;
    }
    await syncPrimaryDevice();
    const group = await deviceStore.createGroup(name);
    const enriched = deviceStore.listGroupsWithCounts().find((entry) => entry.id === group.id);
    response.status(201).json(enriched ?? { ...group, device_count: 0 });
  });

  app.put("/api/device-groups/:id", async (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    if (!name) {
      response.status(400).json({ error: "name is required." });
      return;
    }
    await syncPrimaryDevice();
    try {
      const group = await deviceStore.updateGroup(request.params.id, name);
      const enriched = deviceStore.listGroupsWithCounts().find((entry) => entry.id === group.id);
      response.json(enriched ?? { ...group, device_count: 0 });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/device-groups/:id", async (request, response) => {
    await syncPrimaryDevice();
    const result = await deviceStore.deleteGroup(request.params.id);
    response.json(result);
  });

  app.post("/api/device-groups/reorder", async (request, response) => {
    const groupIds = Array.isArray(request.body?.group_ids)
      ? request.body.group_ids.map((value: unknown) => String(value))
      : [];
    await syncPrimaryDevice();
    response.json(await deviceStore.reorderGroups(groupIds));
  });

  app.post("/api/device-groups/assign", async (request, response) => {
    const serial = String(request.body?.serial ?? "").trim();
    const groupId = String(request.body?.group_id ?? "").trim();
    if (!serial || !groupId) {
      response.status(400).json({ error: "serial and group_id are required." });
      return;
    }
    await syncPrimaryDevice();
    try {
      await deviceStore.assignDeviceToGroup(serial, groupId);
      response.json({
        success: true,
        message: "Device moved to group.",
      });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/mdns/devices", (_request, response) => {
    response.json({
      success: true,
      devices: deviceStore.listMdnsDevices(),
    });
  });

  app.post("/api/devices/pair-wifi", async (request, response) => {
    await syncPrimaryDevice();
    const ip = String(request.body?.ip ?? "").trim();
    const connectionPort = Number(request.body?.connection_port ?? 5555);
    if (!ip) {
      response.status(400).json({ error: "ip is required." });
      return;
    }
    const device = await deviceStore.addManualWifiDevice({
      ip,
      port: Number.isFinite(connectionPort) ? connectionPort : 5555,
    });
    response.json({
      success: true,
      message: "Device paired over WiFi.",
      device_id: device.id,
    });
  });

  app.post("/api/remote-devices/discover", (request, response) => {
    const baseUrl = String(request.body?.base_url ?? "").trim();
    if (!baseUrl) {
      response.status(400).json({ error: "base_url is required." });
      return;
    }
    response.json(deviceStore.discoverRemoteDevices(baseUrl));
  });

  app.post("/api/remote-devices", async (request, response) => {
    await syncPrimaryDevice();
    const baseUrl = String(request.body?.base_url ?? "").trim();
    const deviceId = String(request.body?.device_id ?? "").trim();
    if (!baseUrl || !deviceId) {
      response.status(400).json({ error: "base_url and device_id are required." });
      return;
    }
    const device = await deviceStore.addRemoteDevice({ baseUrl, deviceId });
    response.json({
      success: true,
      message: "Remote device added.",
      serial: device.serial,
    });
  });

  app.delete("/api/remote-devices/:serial", async (request, response) => {
    await syncPrimaryDevice();
    const serial = String(request.params.serial ?? "").trim();
    const removed = await deviceStore.removeRemoteDevice(serial);
    response.status(removed ? 200 : 404).json({
      success: removed,
      message: removed ? "Remote device removed." : "Remote device not found.",
    });
  });

  app.post("/api/qr-pairing", (request, response) => {
    const timeout = Number(request.body?.timeout ?? 90);
    const session = deviceStore.createQrPairingSession(Number.isFinite(timeout) ? timeout : 90);
    response.json({
      success: true,
      qr_payload: `WIFI:T:ADB;S:Novaper Pairing;P:${session.sessionId};`,
      session_id: session.sessionId,
      expires_at: session.expiresAt,
      message: "QR pairing started.",
    });
  });

  app.get("/api/qr-pairing/:sessionId", async (request, response) => {
    await syncPrimaryDevice();
    response.json(deviceStore.getQrPairingStatus(request.params.sessionId));
  });

  app.post("/api/qr-pairing/:sessionId/cancel", (request, response) => {
    response.json(deviceStore.cancelQrPairing(request.params.sessionId));
  });

  app.get("/api/workflows", (_request, response) => {
    response.json({
      workflows: automationStore.listWorkflows().map((workflow) => ({
        uuid: workflow.uuid,
        name: workflow.name,
        text: workflow.text,
        type: workflow.type || "manual",
        recorded_actions: workflow.recorded_actions,
        recording_url: workflow.recording_url,
        recording_metadata: workflow.recording_metadata,
      })),
    });
  });

  app.get("/api/workflows/:uuid", (request, response) => {
    const workflow = automationStore.getWorkflow(request.params.uuid);
    if (!workflow) {
      response.status(404).json({ error: "Workflow not found." });
      return;
    }
    response.json({
      uuid: workflow.uuid,
      name: workflow.name,
      text: workflow.text,
      type: workflow.type || "manual",
      recorded_actions: workflow.recorded_actions,
      recording_url: workflow.recording_url,
      recording_metadata: workflow.recording_metadata,
    });
  });

  app.post("/api/workflows", async (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    const text = String(request.body?.text ?? "").trim();
    if (!name || !text) {
      response.status(400).json({ error: "name and text are required." });
      return;
    }
    const workflow = await automationStore.createWorkflow({ name, text });
    response.status(201).json({
      uuid: workflow.uuid,
      name: workflow.name,
      text: workflow.text,
      type: workflow.type,
    });
  });

  app.put("/api/workflows/:uuid", async (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    const text = String(request.body?.text ?? "").trim();
    if (!name || !text) {
      response.status(400).json({ error: "name and text are required." });
      return;
    }

    const workflow = automationStore.getWorkflow(request.params.uuid);
    if (!workflow) {
      response.status(404).json({ error: "Workflow not found." });
      return;
    }

    const updatedWorkflow = await automationStore.updateWorkflow(request.params.uuid, { name, text });
    response.json({
      uuid: updatedWorkflow.uuid,
      name: updatedWorkflow.name,
      text: updatedWorkflow.text,
    });
  });

  app.delete("/api/workflows/:uuid", async (request, response) => {
    const dependentTasks = automationStore
      .listScheduledTasks()
      .filter((task) => task.workflow_uuid === request.params.uuid);
    if (dependentTasks.length > 0) {
      response.status(409).json({
        error: "Workflow is still referenced by scheduled tasks.",
      });
      return;
    }

    const deleted = await automationStore.deleteWorkflow(request.params.uuid);
    if (!deleted) {
      response.status(404).json({ error: "Workflow not found." });
      return;
    }
    response.json({ ok: true });
  });

  // ==================== Recorded Workflows ====================

  app.post("/api/workflows/recorded", async (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    const recording_url = String(request.body?.recording_url ?? "").trim();
    const recorded_actions = request.body?.recorded_actions as RecordedAction[] | undefined;
    const duration_ms = Number(request.body?.duration_ms ?? 0);

    if (!name || !recorded_actions || recorded_actions.length === 0) {
      response.status(400).json({ error: "name and recorded_actions are required." });
      return;
    }

    const workflow = await automationStore.createRecordedWorkflow({
      name,
      recording_url,
      recorded_actions,
      duration_ms,
    });

    response.status(201).json(workflow);
  });

  app.post("/api/workflows/:uuid/replay", async (request, response) => {
    const workflow = automationStore.getWorkflow(request.params.uuid);
    if (!workflow) {
      response.status(404).json({ error: "Workflow not found." });
      return;
    }
    if (workflow.type !== "recorded" || !workflow.recorded_actions?.length) {
      response.status(400).json({ error: "Workflow has no recorded actions." });
      return;
    }

    const existingProgress = getReplayProgress(workflow.uuid);
    if (existingProgress?.status === "running") {
      response.status(409).json({ error: "Replay already in progress." });
      return;
    }

    try {
      // Open a browser session for replay
      await browserSessionManager.open(workflow.uuid + "-replay", {
        url: workflow.recording_url,
      });
      const sessionId = workflow.uuid + "-replay";

      // Start replay asynchronously
      void replayWorkflow({
        workflowUuid: workflow.uuid,
        workflowName: workflow.name,
        recordingUrl: workflow.recording_url || "",
        actions: workflow.recorded_actions,
        browserSession: browserSessionManager,
        sessionId,
        artifactDir: path.join(config.rootDir, "data"),
      });

      response.json({ started: true, uuid: workflow.uuid });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/workflows/:uuid/replay-status", (request, response) => {
    const workflow = automationStore.getWorkflow(request.params.uuid);
    if (!workflow) {
      response.status(404).json({ error: "Workflow not found." });
      return;
    }

    const progress = getReplayProgress(workflow.uuid);
    if (!progress) {
      response.json({ status: "idle", currentAction: 0, totalActions: 0, duration_ms: 0, errors: [] });
      return;
    }
    response.json(progress);
  });

  app.post("/api/workflows/:uuid/replay/stop", (request, response) => {
    const stopped = stopReplayEngine(request.params.uuid);
    response.json({ stopped });
  });

  app.get("/api/workflows/:uuid/screenshots", async (request, response) => {
    const uuid = request.params.uuid;
    const screenshotsDir = path.join(config.rootDir, "data", "workflows", uuid);
    try {
      const walkDir = async (dir: string): Promise<string[]> => {
        const files: string[] = [];
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              files.push(...(await walkDir(fullPath)));
            } else if (entry.name.endsWith(".png") || entry.name.endsWith(".jpg")) {
              files.push(path.relative(screenshotsDir, fullPath).replace(/\\/g, "/"));
            }
          }
        } catch {}
        return files;
      };
      const files = await walkDir(screenshotsDir);
      response.json({ screenshots: files });
    } catch {
      response.json({ screenshots: [] });
    }
  });

  // Serve workflow screenshots as static files
  app.use("/api/workflows-static", express.static(path.join(config.rootDir, "data", "workflows")));

  app.get("/api/scheduled-tasks", (_request, response) => {
    response.json({
      tasks: automationStore.listScheduledTasks(),
    });
  });

  app.get("/api/scheduled-tasks/:id", (request, response) => {
    const task = automationStore.getScheduledTask(request.params.id);
    if (!task) {
      response.status(404).json({ error: "Scheduled task not found." });
      return;
    }
    response.json(task);
  });

  app.post("/api/scheduled-tasks", async (request, response) => {
    const name = String(request.body?.name ?? "").trim();
    const workflowUuid = String(request.body?.workflow_uuid ?? "").trim();
    const cronExpression = String(request.body?.cron_expression ?? "").trim();
    if (!name || !workflowUuid || !cronExpression) {
      response.status(400).json({ error: "name, workflow_uuid, and cron_expression are required." });
      return;
    }

    if (!automationStore.getWorkflow(workflowUuid)) {
      response.status(400).json({ error: `Unknown workflow: ${workflowUuid}` });
      return;
    }

    try {
      const task = await automationStore.createScheduledTask({
        name,
        workflow_uuid: workflowUuid,
        device_serialnos: Array.isArray(request.body?.device_serialnos)
          ? request.body.device_serialnos.map(String)
          : [],
        device_group_id:
          typeof request.body?.device_group_id === "string" ? request.body.device_group_id : null,
        cron_expression: cronExpression,
        enabled: request.body?.enabled !== false,
      });
      response.status(201).json(task);
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.put("/api/scheduled-tasks/:id", async (request, response) => {
    const task = automationStore.getScheduledTask(request.params.id);
    if (!task) {
      response.status(404).json({ error: "Scheduled task not found." });
      return;
    }

    const workflowUuid =
      request.body?.workflow_uuid === undefined ? task.workflow_uuid : String(request.body.workflow_uuid ?? "").trim();
    if (!workflowUuid || !automationStore.getWorkflow(workflowUuid)) {
      response.status(400).json({ error: `Unknown workflow: ${workflowUuid}` });
      return;
    }

    try {
      const updatedTask = await automationStore.updateScheduledTask(request.params.id, {
        name: typeof request.body?.name === "string" ? request.body.name : undefined,
        workflow_uuid: workflowUuid,
        device_serialnos: Array.isArray(request.body?.device_serialnos)
          ? request.body.device_serialnos.map(String)
          : request.body?.device_serialnos === null
            ? null
            : undefined,
        device_group_id:
          request.body?.device_group_id === null
            ? null
            : typeof request.body?.device_group_id === "string"
              ? request.body.device_group_id
              : undefined,
        cron_expression:
          typeof request.body?.cron_expression === "string" ? request.body.cron_expression : undefined,
        enabled: typeof request.body?.enabled === "boolean" ? request.body.enabled : undefined,
      });
      response.json(updatedTask);
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete("/api/scheduled-tasks/:id", async (request, response) => {
    const deleted = await automationStore.deleteScheduledTask(request.params.id);
    if (!deleted) {
      response.status(404).json({ error: "Scheduled task not found." });
      return;
    }
    response.json({ ok: true });
  });

  app.post("/api/scheduled-tasks/:id/run", async (request, response) => {
    const task = automationStore.getScheduledTask(request.params.id);
    if (!task) {
      response.status(404).json({ error: "Scheduled task not found." });
      return;
    }

    try {
      const result = await queueScheduledTaskRun(task.id, "manual");
      if (!result.queued) {
        response.status(409).json({ error: "Scheduled task is already running." });
        return;
      }
      response.status(202).json({
        ok: true,
        taskId: task.id,
      });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/auth/codex/login", async (_request, response) => {
    try {
      const login = await authService.startCodexLogin();
      response.status(202).json(login);
    } catch (error) {
      response.status(authErrorStatus(error instanceof Error ? error.message : String(error))).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/auth/codex/logout", async (_request, response) => {
    await authService.logoutCodex();
    response.json(await authService.getStatus());
  });

  app.get("/api/scenarios", (_request, response) => {
    response.json(
      scenarios.map((scenario) => ({
        manifest: scenario.manifest,
      })),
    );
  });

  app.get("/api/machines", async (_request, response) => {
    const heartbeat = await sidecar.heartbeat();
    response.json([
      {
        id: heartbeat.machineId,
        status: heartbeat.interactiveSession ? "online" : "offline",
        heartbeat,
      },
    ]);
  });

  app.get("/api/runs", (_request, response) => {
    response.json(store.listRuns());
  });

  app.get("/api/runs/:id", (request, response) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      response.status(404).json({ error: "Run not found." });
      return;
    }
    response.json({
      run,
      events: store.getEvents(run.id),
    });
  });

  app.post("/api/runs", async (request, response) => {
    const scenarioId = String(request.body?.scenarioId ?? "");
    const scenario = scenarioMap.get(scenarioId);
    if (!scenario) {
      response.status(400).json({ error: `Unknown scenario: ${scenarioId}` });
      return;
    }

    const requestedProvider = normalizeRequestedProvider(request.body?.authProvider);
    let auth;
    try {
      auth = await authService.getResponsesClient(requestedProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(authErrorStatus(message)).json({ error: message });
      return;
    }

    const heartbeat = await sidecar.heartbeat();
    const run = await store.createRun({
      scenarioId,
      machineId: heartbeat.machineId,
      payload: typeof request.body?.input === "object" && request.body?.input ? request.body.input : {},
      model: typeof request.body?.model === "string" ? request.body.model : config.model,
      authProvider: auth.authProvider,
    });

    void executeRun({
      store,
      run,
      scenario,
      client: auth.client,
      authProvider: auth.authProvider,
    });

    response.status(202).json(run);
  });

  app.post("/api/runs/:id/stop", async (request, response) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      response.status(404).json({ error: "Run not found." });
      return;
    }

    const updated = await store.requestStop(run.id);
    await store.appendEvent(run.id, {
      type: "status",
      level: "warning",
      message: "Stop requested by operator.",
    });
    response.json(updated);
  });

  app.post("/api/runs/:id/retry", async (request, response) => {
    const previous = store.getRun(request.params.id);
    if (!previous) {
      response.status(404).json({ error: "Run not found." });
      return;
    }

    const scenario = scenarioMap.get(previous.scenarioId);
    if (!scenario) {
      response.status(400).json({ error: `Scenario missing: ${previous.scenarioId}` });
      return;
    }

    let auth;
    try {
      auth = await authService.getResponsesClient(normalizeRequestedProvider(request.body?.authProvider) ?? previous.authProvider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(authErrorStatus(message)).json({ error: message });
      return;
    }

    const run = await store.createRun({
      scenarioId: previous.scenarioId,
      machineId: previous.machineId,
      payload: previous.input,
      model: previous.model,
      authProvider: auth.authProvider,
      retryOf: previous.id,
    });

    void executeRun({
      store,
      run,
      scenario,
      client: auth.client,
      authProvider: auth.authProvider,
    });

    response.status(202).json(run);
  });

  app.get("/api/runs/:id/events", (request, response) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      response.status(404).end();
      return;
    }

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const detach = store.attachStream(run.id, response);
    request.on("close", detach);
  });

  app.get("/api/runs/:id/replay", (request, response) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      response.status(404).json({ error: "Run not found." });
      return;
    }

    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename=\"${run.id}.zip\"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (error: Error) => {
      response.status(500).end(error.message);
    });
    archive.pipe(response);
    archive.directory(run.replayDir, false);
    void archive.finalize();
  });

  app.get("/api/live-sessions", (_request, response) => {
    response.json(liveStore.listSessions());
  });

  app.post("/api/live-sessions", async (request, response) => {
    const session = await liveStore.createSession(
      typeof request.body?.model === "string" ? request.body.model : config.model,
      normalizeRequestedProvider(request.body?.authProvider),
      normalizeAgentDriverId(request.body?.agentType ?? request.body?.agent_type),
      normalizeAgentConfig(request.body?.agentConfig ?? request.body?.agent_config_params),
    );
    const agentDriver = getAgentDriver(session.agentType);
    await liveStore.appendEvent(session.id, {
      type: "log",
      level: "info",
      message: `Agent driver selected: ${agentDriver.label}.`,
      payload: {
        driverId: agentDriver.id,
        driverLabel: agentDriver.label,
        agentConfig: session.agentConfig,
      },
    });
    await liveStore.appendEvent(session.id, {
      type: "status",
      level: "info",
      message: "Live session created.",
    });
    response.status(201).json(session);
  });

  app.get("/api/live-sessions/:id", (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Live session not found." });
      return;
    }

    response.json({
      session,
      events: liveStore.getEvents(session.id),
    });
  });

  app.get("/api/live-sessions/:id/events", (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).end();
      return;
    }

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const detach = liveStore.attachStream(session.id, response);
    request.on("close", detach);
  });

  app.post("/api/live-sessions/:id/observe", async (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Live session not found." });
      return;
    }

    await liveStore.updateSession(session.id, { status: "observing" });
    const [heartbeat, windows, screenshot] = await Promise.all([sidecar.heartbeat(), sidecar.listWindows(), sidecar.captureScreenshot()]);
    const screenshotUrl = await saveLiveObservation(session.artifactDir, session.id, screenshot.imageBase64);
    const updated = await liveStore.updateSession(session.id, {
      status: session.status === "acting" ? "acting" : "idle",
      latestScreenshotUrl: screenshotUrl,
    });

    response.json({
      session: updated,
      heartbeat,
      windows,
      screenshot: {
        url: screenshotUrl,
        width: screenshot.width,
        height: screenshot.height,
      },
    });
  });

  app.post("/api/live-sessions/:id/commands", async (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Live session not found." });
      return;
    }

    if (session.status === "acting" || session.executionLock) {
      response.status(409).json({ error: "Live session is already executing another command." });
      return;
    }

    if (session.status === "waiting_confirmation") {
      response.status(409).json({ error: "Waiting for user confirmation on a previous action." });
      return;
    }

    const instruction = String(request.body?.instruction ?? "").trim();
    if (!instruction) {
      response.status(400).json({ error: "instruction is required." });
      return;
    }

    const requestedProvider = normalizeRequestedProvider(request.body?.authProvider) ?? session.authProvider;
    const customBaseUrl = typeof request.body?.baseUrl === "string" ? request.body.baseUrl.trim() : "";
    const customApiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
    const requestedAgentDriver = getAgentDriver(
      request.body?.agentType ?? request.body?.agent_type ?? session.agentType,
    );
    const requestedAgentConfig = normalizeAgentConfig(
      request.body?.agentConfig ?? request.body?.agent_config_params ?? session.agentConfig,
    );

    let auth;
    try {
      if (requestedProvider !== "codex-oauth" && customBaseUrl && customApiKey) {
        auth = authService.getCustomResponsesClient(customBaseUrl, customApiKey);
      } else {
        auth = await authService.getResponsesClient(requestedProvider);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(authErrorStatus(message)).json({ error: message });
      return;
    }

    const updated = await liveStore.updateSession(session.id, {
      status: "acting",
      stopRequested: false,
      latestInstruction: instruction,
      model: typeof request.body?.model === "string" ? request.body.model : session.model,
      authProvider: auth.authProvider,
      agentType: requestedAgentDriver.id,
      agentConfig: requestedAgentConfig,
      error: undefined,
    });
    await liveStore.appendEvent(session.id, {
      type: "message",
      level: "info",
      message: "User instruction",
      payload: { text: instruction },
    });

    await liveStore.appendEvent(session.id, {
      type: "log",
      level: "info",
      message: "Auth provider selected.",
      payload: { authProvider: auth.authProvider },
    });
    await liveStore.appendEvent(session.id, {
      type: "log",
      level: "info",
      message: `Agent driver selected: ${requestedAgentDriver.label}.`,
      payload: {
        driverId: requestedAgentDriver.id,
        driverLabel: requestedAgentDriver.label,
        agentConfig: requestedAgentConfig,
      },
    });

    void (async () => {
      try {
        const capabilityContext = await loadCapabilityContext(pluginStore);
        const agentDriver = getAgentDriver(updated.agentType);
        const driverPrompt = agentDriver.buildDeveloperPrompt(
          buildLiveDeveloperPrompt({
            capabilityBrief: capabilityContext.capabilityBrief,
            skills: capabilityContext.skills,
          }),
          updated.agentConfig,
        );
        const verificationPrompt = agentDriver.buildDeveloperPrompt(
          buildLiveDeveloperPrompt(),
          updated.agentConfig,
        );
        const rootInstruction = agentDriver.decorateInstruction(
          instruction,
          "root",
          updated.agentConfig,
        );

        // Classify instruction to determine agent routing
        let classifiedRoute: AgentRoute = "desktop";
        try {
          classifiedRoute = await classifyInstruction(instruction, auth.client, updated.model);
        } catch {
          classifiedRoute = "desktop"; // Safe fallback
        }
        const executionRoute = agentDriver.resolveRoute({
          instruction,
          classifiedRoute,
          agentConfig: updated.agentConfig,
        });

        await liveStore.appendEvent(updated.id, {
          type: "agent_route",
          level: "info",
          message: `Routed ${agentDriver.label} to ${executionRoute} execution.`,
          payload: {
            agentType: executionRoute,
            classifiedRoute,
            driverId: agentDriver.id,
            driverLabel: agentDriver.label,
          },
        });

        if (executionRoute === "planner") {
          // Complex task: decompose into subtasks
          const windows = await sidecar.listWindows();
          let memoryCtx = "";
          try {
            memoryCtx = await memoryManager.buildMemoryContext(instruction, windows, undefined, updated.id);
          } catch { /* best effort */ }

          const plan = await planTasks(
            agentDriver.decorateInstruction(instruction, "plan", updated.agentConfig),
            {
              windows,
              memory: memoryCtx,
              capabilities: capabilityContext.capabilityBrief,
            },
            auth.client,
            updated.model,
          );

          await liveStore.appendEvent(updated.id, {
            type: "log",
            level: "info",
            message: `Task plan created with ${plan.tasks.length} subtasks.`,
            payload: { plan: formatPlan(plan) },
          });

          let plannerPreviousResponseId = canReuseResponseChain(auth.authProvider)
            ? updated.previousResponseId
            : undefined;

          // Execute subtasks sequentially
          while (!isPlanComplete(plan)) {
            if (liveStore.getSession(updated.id)?.stopRequested) {
              throw new Error("Live session stopped by operator.");
            }

            const task = getNextTask(plan);
            if (!task) break;

            updateTaskStatus(plan, task.id, "in_progress");
            await liveStore.appendEvent(updated.id, {
              type: "log",
              level: "info",
              message: `Starting subtask: ${task.title}`,
              payload: { taskId: task.id, plan: formatPlan(plan) },
            });

            try {
              if (task.agentType === "cli") {
                const subResult = await drivePiAgent({
                  instruction: agentDriver.decorateInstruction(
                    task.description,
                    "cli",
                    updated.agentConfig,
                  ),
                  client: auth.client,
                  model: updated.model,
                  artifactDir: updated.artifactDir,
                  onEvent: async (event) => {
                    await liveStore.appendEvent(updated.id, event);
                  },
                  shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
                  skills: capabilityContext.skills.length > 0 ? capabilityContext.skills : undefined,
                  capabilityBrief: capabilityContext.capabilityBrief,
                });
                updateTaskStatus(plan, task.id, "completed", subResult.summary);
              } else {
                await memoryManager.initSession(updated.id);
                const stepInstruction = buildTaskExecutionInstruction(task);
                const subResult = await driveDesktopAgent({
                  client: auth.client,
                  model: updated.model,
                  developerPrompt: driverPrompt,
                  userContent: `${stepInstruction}\n\n[User Task]\n${agentDriver.decorateInstruction(
                    task.description,
                    "task",
                    updated.agentConfig,
                  )}`,
                  previousResponseId: plannerPreviousResponseId,
                  sidecar,
                  artifactDir: updated.artifactDir,
                  screenshotBaseUrl: `/artifacts/live/${updated.id}`,
                  onEvent: async (event) => {
                    await liveStore.appendEvent(updated.id, event);
                  },
                  shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
                  maxTurns: agentDriver.plannerStepMaxTurns,
                  memoryManager,
                  browserSessionManager,
                  sessionId: updated.id,
                });

                let combinedSummary = subResult.summary;
                let latestScreenshotUrl = subResult.latestScreenshotUrl ?? updated.latestScreenshotUrl;
                let combinedToolCalls = [...subResult.toolCalls];
                let verification = evaluateTaskVerification(task, combinedToolCalls);
                plannerPreviousResponseId = canReuseResponseChain(auth.authProvider)
                  ? subResult.responseId
                  : undefined;

                if (!verification.verified) {
                  await liveStore.appendEvent(updated.id, {
                    type: "log",
                    level: "warning",
                    message: `Subtask missing verification evidence: ${task.title}`,
                    payload: {
                      taskId: task.id,
                      missingReason: verification.missingReason,
                      evidence: verification.evidence,
                    },
                  });

                  const verifyResult = await driveDesktopAgent({
                    client: auth.client,
                    model: updated.model,
                    developerPrompt: verificationPrompt,
                    userContent: buildVerificationFollowUpInstruction(task, verification),
                    previousResponseId: plannerPreviousResponseId,
                    sidecar,
                    artifactDir: updated.artifactDir,
                    screenshotBaseUrl: `/artifacts/live/${updated.id}`,
                    onEvent: async (event) => {
                      await liveStore.appendEvent(updated.id, event);
                    },
                    shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
                    maxTurns: agentDriver.verificationMaxTurns,
                    memoryManager,
                    browserSessionManager,
                    sessionId: updated.id,
                  });

                  combinedSummary = verifyResult.summary || combinedSummary;
                  latestScreenshotUrl = verifyResult.latestScreenshotUrl ?? latestScreenshotUrl;
                  combinedToolCalls = [...combinedToolCalls, ...verifyResult.toolCalls];
                  verification = evaluateTaskVerification(task, combinedToolCalls);
                  plannerPreviousResponseId = canReuseResponseChain(auth.authProvider)
                    ? verifyResult.responseId
                    : plannerPreviousResponseId;
                }

                if (!verification.verified && taskAllowsVisionFallback(task)) {
                  await liveStore.appendEvent(updated.id, {
                    type: "log",
                    level: "info",
                    message: `Attempting visual verification fallback: ${task.title}`,
                    payload: {
                      taskId: task.id,
                      missingReason: verification.missingReason,
                    },
                  });

                  const visualVerification = await runVisualVerificationPass({
                    client: auth.client,
                    model: updated.model,
                    sidecar,
                    task,
                  });

                  if (visualVerification.verified) {
                    verification = {
                      verified: true,
                      evidence: visualVerification.evidence.length > 0
                        ? visualVerification.evidence.map((item) => `visually verified: ${item}`)
                        : ["visually verified from current screenshot"],
                    };
                  } else if (visualVerification.reason) {
                    verification = {
                      ...verification,
                      missingReason: `${verification.missingReason ?? "Visual fallback did not verify the step."} Visual check: ${visualVerification.reason}`,
                    };
                  }
                }

                if (!verification.verified) {
                  throw new Error(verification.missingReason ?? "Subtask finished without verification evidence.");
                }

                const verifiedSummary =
                  verification.evidence.length > 0
                    ? `${combinedSummary} [verified: ${verification.evidence.join("; ")}]`
                    : combinedSummary;
                updateTaskStatus(plan, task.id, "completed", verifiedSummary);

                await liveStore.updateSession(updated.id, {
                  previousResponseId: plannerPreviousResponseId,
                  latestScreenshotUrl,
                });
              }
            } catch (taskError) {
              updateTaskStatus(plan, task.id, "failed", summarizeError(taskError));
            }
          }

          const completedSummaries = plan.tasks
            .filter((t) => t.summary)
            .map((t) => `${t.title}: ${t.summary}`)
            .join("; ");

          await liveStore.updateSession(updated.id, {
            status: "idle",
            latestSummary: completedSummaries || "Task plan completed.",
          });
          await liveStore.appendEvent(updated.id, {
            type: "status",
            level: "info",
            message: "Task plan completed.",
            payload: { summary: completedSummaries, plan: formatPlan(plan) },
          });
        } else if (executionRoute === "cli") {
          const result = await drivePiAgent({
            instruction: agentDriver.decorateInstruction(
              instruction,
              "cli",
              updated.agentConfig,
            ),
            client: auth.client,
            model: updated.model,
            artifactDir: updated.artifactDir,
            onEvent: async (event) => {
              await liveStore.appendEvent(updated.id, event);
            },
            shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
            skills: capabilityContext.skills.length > 0 ? capabilityContext.skills : undefined,
            capabilityBrief: capabilityContext.capabilityBrief,
          });

          await liveStore.updateSession(updated.id, {
            status: "idle",
            latestSummary: result.summary,
          });
          await liveStore.appendEvent(updated.id, {
            type: "status",
            level: "info",
            message: "Instruction completed.",
            payload: { summary: result.summary },
          });
        } else {
          // Initialize memory for this session
          await memoryManager.initSession(updated.id);

          const result = await driveDesktopAgent({
            client: auth.client,
            model: updated.model,
            developerPrompt: driverPrompt,
            userContent: rootInstruction,
            previousResponseId: canReuseResponseChain(auth.authProvider)
              ? updated.previousResponseId
              : undefined,
            sidecar,
            artifactDir: updated.artifactDir,
            screenshotBaseUrl: `/artifacts/live/${updated.id}`,
            onEvent: async (event) => {
              await liveStore.appendEvent(updated.id, event);
            },
            shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
            maxTurns: agentDriver.desktopMaxTurns,
            memoryManager,
            browserSessionManager,
            sessionId: updated.id,
          });

          await liveStore.updateSession(updated.id, {
            status: "idle",
            previousResponseId: canReuseResponseChain(auth.authProvider)
              ? result.responseId
              : undefined,
            latestSummary: result.summary,
            latestScreenshotUrl: result.latestScreenshotUrl ?? updated.latestScreenshotUrl,
          });
          await liveStore.appendEvent(updated.id, {
            type: "status",
            level: "info",
            message: "Instruction completed.",
            payload: { summary: result.summary },
          });

          // Finalize memory for this session
          try {
            await memoryManager.finalizeSession(
              updated.id,
              result.summary,
              liveStore.getEvents(updated.id),
              auth.client as unknown as import("../../../packages/memory/src/types.js").ResponsesClient,
              updated.model,
            );
          } catch {
            // Memory finalization is best-effort
          }
        }
      } catch (error) {
        await liveStore.updateSession(updated.id, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        await liveStore.appendEvent(updated.id, {
          type: "error",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    response.status(202).json(updated);
  });

  app.post("/api/live-sessions/:id/confirm", async (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Live session not found." });
      return;
    }

    if (!session.pendingConfirmation) {
      response.status(400).json({ error: "No pending confirmation." });
      return;
    }

    const choice = String(request.body?.choice ?? "");
    const updated = await liveStore.updateSession(session.id, {
      pendingConfirmation: {
        ...session.pendingConfirmation,
        resolveWith: choice || "confirmed",
      },
      status: "acting",
    });

    await liveStore.appendEvent(session.id, {
      type: "status",
      level: "info",
      message: `User confirmed: ${choice || "confirmed"}`,
      payload: { choice },
    });

    response.json(updated);
  });

  app.post("/api/live-sessions/:id/stop", async (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Live session not found." });
      return;
    }

    const updated = await liveStore.updateSession(session.id, {
      stopRequested: true,
    });
    await liveStore.appendEvent(session.id, {
      type: "status",
      level: "warning",
      message: "Stop requested by operator.",
    });
    response.json(updated);
  });

  // ─── Screen Frame Stream (SSE) ───────────────────────────────────────
  const frameStreamer = new FrameStreamer(sidecar, 2);

  app.get("/api/live-sessions/:id/screen-stream", (request, response) => {
    const session = liveStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Live session not found." });
      return;
    }

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const unsubscribe = frameStreamer.subscribe((frame) => {
      // Send frame as SSE event with JPEG base64
      response.write(`data: ${JSON.stringify({ timestamp: frame.timestamp, width: frame.width, height: frame.height, image: frame.base64 })}\n\n`);
    });

    request.on("close", unsubscribe);
  });

  // ─── Logs API ────────────────────────────────────────────────────────
  app.get("/api/logs/files", async (_request, response) => {
    const files = await logCollector.listFiles();
    response.json(files);
  });

  app.get("/api/logs/files/:filename", async (request, response) => {
    try {
      const content = await logCollector.readFile(request.params.filename);
      response.type("text/plain").send(content);
    } catch {
      response.status(404).json({ error: "Log file not found." });
    }
  });

  app.get("/api/logs/stream", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    // Send recent entries as catchup
    for (const entry of logCollector.getRecent(100)) {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = logCollector.subscribe((entry) => {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    request.on("close", unsubscribe);
  });

  // ─── Memory API ──────────────────────────────────────────────────────
  app.get("/api/memory/global", async (_request, response) => {
    const entries = await memoryManager.getStore().loadGlobal();
    response.json(entries);
  });

  app.get("/api/memory/apps", async (_request, response) => {
    const profiles = await memoryManager.getStore().listAppProfiles();
    response.json(profiles);
  });

  app.get("/api/memory/apps/:name", async (request, response) => {
    const profile = await memoryManager.getStore().loadAppProfile(request.params.name);
    if (!profile) {
      response.status(404).json({ error: "App profile not found." });
      return;
    }
    response.json(profile);
  });

  app.delete("/api/memory/:id", async (request, response) => {
    const deleted = await memoryManager.getStore().deleteById(request.params.id);
    if (!deleted) {
      response.status(404).json({ error: "Memory entry not found." });
      return;
    }
    response.json({ deleted: true });
  });

  app.post("/api/memory", async (request, response) => {
    const body = request.body;
    if (!body?.content) {
      response.status(400).json({ error: "content is required." });
      return;
    }
    const entry = await memoryManager.getLongTerm().storeEntry({
      updatedAt: new Date().toISOString(),
      category: body.category || "preference",
      appContext: body.appContext,
      scope: body.appContext ? "app" : "global",
      content: body.content,
      accessCount: 0,
      lastAccessedAt: new Date().toISOString(),
      tags: body.tags || [],
      confidence: body.confidence ?? 0.8,
    });
    response.status(201).json(entry);
  });

  // ─── Memory Consolidation API ───────────────────────────────────────

  app.post("/api/memories/consolidate", async (request, response) => {
    try {
      let client: import("../../../packages/memory/src/types.js").ResponsesClient | undefined;
      let model: string | undefined;
      try {
        const auth = await authService.getResponsesClient();
        client = auth.client as unknown as import("../../../packages/memory/src/types.js").ResponsesClient;
        model = typeof request.body?.model === "string" ? request.body.model : config.model;
      } catch {
        // No auth available — will run local-only consolidation
      }
      const result = await memoryManager.consolidate(client, model);
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: summarizeError(error) });
    }
  });

  app.get("/api/memories/consolidations", async (_request, response) => {
    try {
      const records = await memoryManager.getStore().loadConsolidations();
      response.json(records);
    } catch (error) {
      response.status(500).json({ error: summarizeError(error) });
    }
  });

  // ─── Unified History API ─────────────────────────────────────────────
  app.get("/api/history", (_request, response) => {
    const limit = Math.min(Math.max(Number(_request.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(_request.query.offset) || 0, 0);

    type HistoryItem = {
      id: string;
      type: "live-session" | "run";
      createdAt: string;
      updatedAt: string;
      status: string;
      instruction?: string;
      summary?: string;
      error?: string;
      hasToolEvents: boolean;
    };

    const items: HistoryItem[] = [];

    for (const session of liveStore.listSessions()) {
      const events = liveStore.getEvents(session.id);
      const hasToolEvents = events.some((e) => e.type === "tool_call" || e.type === "computer_action");
      items.push({
        id: session.id,
        type: "live-session",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.status,
        instruction: session.latestInstruction,
        summary: session.latestSummary,
        error: session.error,
        hasToolEvents,
      });
    }

    for (const run of store.listRuns()) {
      const events = store.getEvents(run.id);
      const hasToolEvents = events.some((e) => e.type === "tool_call" || e.type === "computer_action");
      items.push({
        id: run.id,
        type: "run",
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        status: run.status,
        summary: run.summary,
        error: run.error ? run.error.message : undefined,
        hasToolEvents,
      });
    }

    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const paged = items.slice(offset, offset + limit);
    response.json({ items: paged, total: items.length, limit, offset });
  });

  app.get("/api/history/:id", (request, response) => {
    const { id } = request.params;

    const session = liveStore.getSession(id);
    if (session) {
      response.json({
        type: "live-session",
        record: session,
        events: liveStore.getEvents(id),
      });
      return;
    }

    const run = store.getRun(id);
    if (run) {
      response.json({
        type: "run",
        record: run,
        events: store.getEvents(id),
      });
      return;
    }

    response.status(404).json({ error: "Record not found." });
  });

  app.delete("/api/history/:id", async (request, response) => {
    const { id } = request.params;

    if (await liveStore.deleteSession(id)) {
      response.json({ deleted: true });
      return;
    }

    if (await store.deleteRun(id)) {
      response.json({ deleted: true });
      return;
    }

    response.status(404).json({ error: "Record not found." });
  });

  // ─── Plugin Management ─────────────────────────────────────────────
  // ---- Plugin Management: Skill Repos ----

  app.get("/api/plugins/skill-repos", async (_request, response) => {
    response.json(await pluginStore.listRepos());
  });

  app.post("/api/plugins/skill-repos", async (request, response) => {
    const { owner, name, branch } = request.body ?? {};
    if (!owner || !name) {
      response.status(400).json({ error: "owner and name are required." });
      return;
    }
    try {
      const repo = await pluginStore.addRepo({
        owner: String(owner),
        name: String(name),
        branch: String(branch || "main"),
        enabled: true,
      });
      response.status(201).json(repo);
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/plugins/skill-repos/:owner/:name", async (request, response) => {
    const updated = await pluginStore.updateRepo(request.params.owner, request.params.name, request.body ?? {});
    if (!updated) {
      response.status(404).json({ error: "Repo not found." });
      return;
    }
    response.json(updated);
  });

  app.delete("/api/plugins/skill-repos/:owner/:name", async (request, response) => {
    const deleted = await pluginStore.deleteRepo(request.params.owner, request.params.name);
    if (!deleted) {
      response.status(404).json({ error: "Repo not found." });
      return;
    }
    response.json({ ok: true });
  });

  // ---- Plugin Management: Skill Discovery & Installation ----

  app.get("/api/plugins/skills/discover", async (request, response) => {
    try {
      const forceRefresh = request.query.refresh === "1";
      const result = await pluginStore.discoverSkills(forceRefresh);
      response.json(result);
    } catch (error) {
      response.status(500).json({ skills: [], errors: [error instanceof Error ? error.message : String(error)] });
    }
  });

  app.get("/api/plugins/skills", async (_request, response) => {
    response.json(await pluginStore.listInstalledSkills());
  });

  app.post("/api/plugins/skills/install", async (request, response) => {
    const skill = request.body;
    if (!skill?.key || !skill?.readmeUrl) {
      response.status(400).json({ error: "Invalid skill data." });
      return;
    }
    try {
      const installed = await pluginStore.installSkill(skill);
      response.status(201).json(installed);
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/plugins/skills/local", async (request, response) => {
    const { name, description, content } = request.body ?? {};
    if (!name || !content) {
      response.status(400).json({ error: "name and content are required." });
      return;
    }
    const skill = await pluginStore.createLocalSkill({
      name: String(name),
      description: String(description ?? ""),
      content: String(content),
    });
    response.status(201).json(skill);
  });

  app.put("/api/plugins/skills/:id", async (request, response) => {
    const id = decodeURIComponent(request.params.id);
    const updated = await pluginStore.updateInstalledSkill(id, request.body ?? {});
    if (!updated) {
      response.status(404).json({ error: "Skill not found." });
      return;
    }
    response.json(updated);
  });

  app.delete("/api/plugins/skills/:id", async (request, response) => {
    const id = decodeURIComponent(request.params.id);
    const deleted = await pluginStore.uninstallSkill(id);
    if (!deleted) {
      response.status(404).json({ error: "Skill not found." });
      return;
    }
    response.json({ ok: true });
  });

  // ---- Skill Resolution Cascade ----

  app.post("/api/plugins/skills/search", async (request, response) => {
    const { query } = request.body ?? {};
    if (!query) {
      response.status(400).json({ error: "query is required." });
      return;
    }
    try {
      const [clawResults, ghResults] = await Promise.all([
        pluginStore.searchClawHub(String(query)),
        pluginStore.searchGitHub(String(query)),
      ]);
      response.json({ clawhub: clawResults, github: ghResults });
    } catch (err: any) {
      response.status(500).json({ error: err.message });
    }
  });

  app.post("/api/plugins/skills/generate", async (request, response) => {
    const { description } = request.body ?? {};
    if (!description) {
      response.status(400).json({ error: "description is required." });
      return;
    }
    try {
      const generated = await pluginStore.autoGenerateSkill(
        String(description),
        await authService.getResponsesClient(),
        config.model ?? "gpt-5.4",
      );
      response.status(201).json(generated);
    } catch (err: any) {
      response.status(500).json({ error: err.message });
    }
  });

  app.get("/api/plugins/skills/resolve", async (request, response) => {
    const query = String(request.query.q ?? "");
    if (!query) {
      response.status(400).json({ error: "q query parameter is required." });
      return;
    }
    try {
      const result = await pluginStore.resolveSkill(
        query,
        await authService.getResponsesClient(),
        config.model ?? "gpt-5.4",
      );
      response.json(result);
    } catch (err: any) {
      response.status(500).json({ error: err.message });
    }
  });

  // ---- Plugin Management: MCP Servers ----

  app.get("/api/plugins/mcp-servers", async (_request, response) => {
    response.json(await pluginStore.listMcpServers());
  });

  app.post("/api/plugins/mcp-servers", async (request, response) => {
    const { name, type, command, args, url, env, enabled } = request.body ?? {};
    if (!name || !type) {
      response.status(400).json({ error: "name and type are required." });
      return;
    }
    const server = await pluginStore.createMcpServer({
      name: String(name),
      type: type as "stdio" | "sse" | "http",
      command: command ? String(command) : undefined,
      args: Array.isArray(args) ? args.map(String) : undefined,
      url: url ? String(url) : undefined,
      env: env && typeof env === "object" ? env : undefined,
      enabled: Boolean(enabled ?? true),
    });
    response.status(201).json(server);
  });

  app.put("/api/plugins/mcp-servers/:id", async (request, response) => {
    const updated = await pluginStore.updateMcpServer(request.params.id, request.body ?? {});
    if (!updated) {
      response.status(404).json({ error: "MCP server not found." });
      return;
    }
    response.json(updated);
  });

  app.delete("/api/plugins/mcp-servers/:id", async (request, response) => {
    const deleted = await pluginStore.deleteMcpServer(request.params.id);
    if (!deleted) {
      response.status(404).json({ error: "MCP server not found." });
      return;
    }
    response.json({ ok: true });
  });

  // ─── Catch-all SPA fallback ─────────────────────────────────────────
  app.get(/^(?!\/api|\/artifacts).*/, (_request, response) => {
    response.sendFile(path.join(operatorWebDir, "index.html"));
  });

  startAutomationScheduler();

  return app;
}

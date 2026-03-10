import express from "express";
import archiver from "archiver";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadScenarios } from "../../../packages/scenario-kit/src/loadScenarios.js";
import { RunStore } from "./store.js";
import { LiveSessionStore } from "./liveStore.js";
import { executeRun } from "../../../packages/runner-core/src/runExecutor.js";
import { DesktopSidecar } from "../../../packages/desktop-runtime/src/sidecar.js";
import { driveDesktopAgent } from "../../../packages/runner-core/src/desktopAgent.js";
import { drivePiAgent } from "../../../packages/runner-core/src/piAgent.js";
import { classifyInstruction, type AgentRoute } from "../../../packages/runner-core/src/instructionClassifier.js";
import { planTasks, getNextTask, updateTaskStatus, isPlanComplete, formatPlan } from "../../../packages/runner-core/src/taskPlanner.js";
import { AuthService } from "./authService.js";
import { getProxyStatus } from "./networkProxy.js";
import { LogCollector } from "./logCollector.js";
import { MemoryManager } from "../../../packages/memory/src/memoryManager.js";
import { FrameStreamer } from "../../../packages/runner-core/src/videoObserver.js";
import { BrowserSessionManager } from "../../../packages/browser-runtime/src/browserSessionManager.js";
import { PluginStore } from "./pluginStore.js";

function normalizeRequestedProvider(input: unknown) {
  return input === "api-key" || input === "codex-oauth" ? input : undefined;
}

function authErrorStatus(message: string) {
  return /not configured|not authenticated|No auth provider/i.test(message) ? 400 : 500;
}

function buildLiveDeveloperPrompt() {
  return [
    "You are a live Windows desktop assistant similar to an interactive computer-use operator.",
    "The human is watching the current desktop and will send one instruction at a time.",
    "For every instruction, inspect the current desktop state before acting.",
    "Prefer tools in this order: 1) browser_* tools for web pages in Chrome, Edge, or other Chromium browsers, 2) UI Automation and deterministic desktop tools, 3) process/file/window tools, 4) desktop_actions for coordinate-based visual fallback, 5) the computer tool when available.",
    "When the task is happening inside a web page, use browser_snapshot before interacting and prefer browser_click, browser_type, browser_press_keys, browser_tabs, and browser_read over desktop clicks.",
    "Never claim a desktop task is complete until you have used at least one tool during the current instruction.",
    "WeChat, WPS, and other Qt or custom-drawn apps often expose unreliable UI Automation trees. In those apps, prefer screenshot-driven desktop_actions over stubborn UIA retries.",
    "For chat apps such as WeChat, verify message delivery on the next screenshot. If the text is still in the input box, try the alternate send method such as Enter, Ctrl+Enter, or clicking the Send button.",
    "Only say a chat message was sent when a post-action screenshot shows the input box cleared or the message bubble appearing in the conversation.",
    "Do only what the current user instruction requires. When the instruction is complete, stop and summarize briefly.",
    "If the instruction is ambiguous, ask a short clarification instead of guessing.",
    "If you hit UAC, a security boundary, CAPTCHA, or a blocked state, stop and explain the blocker.",
    "When a desktop screenshot is attached, treat it as the current visual state. Use absolute pixel coordinates from that screenshot for desktop_actions.",
  ].join("\n");
}

async function saveLiveObservation(sessionArtifactDir: string, sessionId: string, base64Image: string) {
  const fileName = `observe-${Date.now()}.png`;
  const filePath = path.join(sessionArtifactDir, "screenshots", fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(base64Image, "base64"));
  return `/artifacts/live/${sessionId}/screenshots/${fileName}`;
}

export async function createServer(config: {
  rootDir: string;
  port: number;
  host: string;
  model: string;
  openAIApiKey?: string;
}) {
  const app = express();
  const operatorWebDir = path.join(config.rootDir, "apps", "operator-web", "dist");
  const store = new RunStore(path.join(config.rootDir, "data", "runs"));
  const liveStore = new LiveSessionStore(path.join(config.rootDir, "data", "live-sessions"));
  const sidecar = new DesktopSidecar();
  const authService = new AuthService(config.rootDir, config.openAIApiKey);
  const browserSessionManager = new BrowserSessionManager();
  const pluginStore = new PluginStore(config.rootDir);
  const scenarios = await loadScenarios(path.join(config.rootDir, "scenarios"));
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario.manifest.id, scenario]));

  // Initialize log collector
  const logCollector = new LogCollector(path.join(config.rootDir, "data", "logs"));
  await logCollector.init();

  // Initialize memory manager
  const memoryManager = new MemoryManager(path.join(config.rootDir, "data", "memory"));
  await memoryManager.init();

  // Restore persisted data from disk on startup
  await Promise.all([store.loadFromDisk(), liveStore.loadFromDisk()]);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(operatorWebDir));
  app.use("/artifacts", express.static(path.join(config.rootDir, "data", "runs")));
  app.use("/artifacts/live", express.static(path.join(config.rootDir, "data", "live-sessions")));

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

  app.get("/api/auth/status", async (_request, response) => {
    response.json(await authService.getStatus());
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
    );
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

    let auth;
    try {
      auth = await authService.getResponsesClient(normalizeRequestedProvider(request.body?.authProvider) ?? session.authProvider);
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

    void (async () => {
      try {
        // Classify instruction to determine agent routing
        let agentType: AgentRoute = "desktop";
        try {
          agentType = await classifyInstruction(instruction, auth.client, updated.model);
        } catch {
          agentType = "desktop"; // Safe fallback
        }

        await liveStore.appendEvent(updated.id, {
          type: "agent_route",
          level: "info",
          message: `Routed to ${agentType} agent.`,
          payload: { agentType },
        });

        if (agentType === "planner") {
          // Complex task: decompose into subtasks
          const windows = await sidecar.listWindows();
          let memoryCtx = "";
          try {
            memoryCtx = await memoryManager.buildMemoryContext(instruction, windows, undefined, updated.id);
          } catch { /* best effort */ }

          const plan = await planTasks(instruction, { windows, memory: memoryCtx }, auth.client, updated.model);

          await liveStore.appendEvent(updated.id, {
            type: "log",
            level: "info",
            message: `Task plan created with ${plan.tasks.length} subtasks.`,
            payload: { plan: formatPlan(plan) },
          });

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
                  instruction: task.description,
                  client: auth.client,
                  model: updated.model,
                  artifactDir: updated.artifactDir,
                  onEvent: async (event) => {
                    await liveStore.appendEvent(updated.id, event);
                  },
                  shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
                });
                updateTaskStatus(plan, task.id, "completed", subResult.summary);
              } else {
                await memoryManager.initSession(updated.id);
                const subResult = await driveDesktopAgent({
                  client: auth.client,
                  model: updated.model,
                  developerPrompt: buildLiveDeveloperPrompt(),
                  userContent: task.description,
                  previousResponseId: auth.authProvider === "api-key" ? updated.previousResponseId : undefined,
                  sidecar,
                  artifactDir: updated.artifactDir,
                  screenshotBaseUrl: `/artifacts/live/${updated.id}`,
                  onEvent: async (event) => {
                    await liveStore.appendEvent(updated.id, event);
                  },
                  shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
                  maxTurns: 20,
                  memoryManager,
                  browserSessionManager,
                  sessionId: updated.id,
                });
                updateTaskStatus(plan, task.id, "completed", subResult.summary);

                await liveStore.updateSession(updated.id, {
                  previousResponseId: auth.authProvider === "api-key" ? subResult.responseId : undefined,
                  latestScreenshotUrl: subResult.latestScreenshotUrl ?? updated.latestScreenshotUrl,
                });
              }
            } catch (taskError) {
              updateTaskStatus(plan, task.id, "failed", taskError instanceof Error ? taskError.message : String(taskError));
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
        } else if (agentType === "cli") {
          // Load enabled skills for injection into system prompt
          const enabledSkills = await pluginStore.getEnabledSkills();
          const skillsForAgent = enabledSkills.map((s) => ({ name: s.name, content: s.content }));

          const result = await drivePiAgent({
            instruction,
            client: auth.client,
            model: updated.model,
            artifactDir: updated.artifactDir,
            onEvent: async (event) => {
              await liveStore.appendEvent(updated.id, event);
            },
            shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
            skills: skillsForAgent.length > 0 ? skillsForAgent : undefined,
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
            developerPrompt: buildLiveDeveloperPrompt(),
            userContent: instruction,
            previousResponseId: auth.authProvider === "api-key" ? updated.previousResponseId : undefined,
            sidecar,
            artifactDir: updated.artifactDir,
            screenshotBaseUrl: `/artifacts/live/${updated.id}`,
            onEvent: async (event) => {
              await liveStore.appendEvent(updated.id, event);
            },
            shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
            maxTurns: 30,
            memoryManager,
            browserSessionManager,
            sessionId: updated.id,
          });

          await liveStore.updateSession(updated.id, {
            status: "idle",
            previousResponseId: auth.authProvider === "api-key" ? result.responseId : undefined,
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

  return app;
}

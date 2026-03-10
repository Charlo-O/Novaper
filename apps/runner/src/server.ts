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
import { classifyInstruction } from "../../../packages/runner-core/src/instructionClassifier.js";
import { AuthService } from "./authService.js";
import { getProxyStatus } from "./networkProxy.js";

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
    "Prefer tools in this order: 1) UI Automation and deterministic tools, 2) process/file/window tools, 3) desktop_actions for coordinate-based visual fallback, 4) the computer tool when available.",
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
  const scenarios = await loadScenarios(path.join(config.rootDir, "scenarios"));
  const scenarioMap = new Map(scenarios.map((scenario) => [scenario.manifest.id, scenario]));

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

    if (session.status === "acting") {
      response.status(409).json({ error: "Live session is already executing another command." });
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
        let agentType: "cli" | "desktop" = "desktop";
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

        if (agentType === "cli") {
          const result = await drivePiAgent({
            instruction,
            client: auth.client,
            model: updated.model,
            artifactDir: updated.artifactDir,
            onEvent: async (event) => {
              await liveStore.appendEvent(updated.id, event);
            },
            shouldStop: () => Boolean(liveStore.getSession(updated.id)?.stopRequested),
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

  app.get(/^(?!\/api|\/artifacts).*/, (_request, response) => {
    response.sendFile(path.join(operatorWebDir, "index.html"));
  });

  return app;
}

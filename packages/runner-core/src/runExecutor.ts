import type { RunStore } from "../../../apps/runner/src/store.js";
import type { AuthProvider, RunRecord } from "../../replay-schema/src/types.js";
import type { ScenarioDefinition } from "../../scenario-kit/src/types.js";
import { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import { runOpenAILoop } from "./openaiLoop.js";
import type { ResponsesClient } from "./responsesClient.js";

interface ExecutorOptions {
  store: RunStore;
  run: RunRecord;
  scenario: ScenarioDefinition;
  client: ResponsesClient;
  authProvider: AuthProvider;
}

function classifyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/UAC|security|CAPTCHA|blocked/i.test(message)) {
    return { code: "Blocked.SecurityBoundary", message };
  }
  if (/Run stopped by operator/i.test(message)) {
    return { code: "Stopped.ByOperator", message };
  }
  if (/UI element not found|Window not found/i.test(message)) {
    return { code: "Failed.ElementNotFound", message };
  }
  return { code: "Failed.ExecutionError", message };
}

export async function executeRun(options: ExecutorOptions): Promise<void> {
  const { store, run, scenario, client, authProvider } = options;
  const sidecar = new DesktopSidecar();

  try {
    await store.updateStatus(run.id, "PreparingMachine");
    await store.appendEvent(run.id, {
      type: "status",
      level: "info",
      message: "Preparing machine and validating desktop session.",
    });

    const heartbeat = await sidecar.heartbeat();
    await store.appendEvent(run.id, {
      type: "log",
      level: "info",
      message: "Machine heartbeat",
      payload: heartbeat,
    });
    await store.appendEvent(run.id, {
      type: "log",
      level: "info",
      message: "Auth provider selected.",
      payload: { authProvider },
    });

    await store.updateStatus(run.id, "Ready");
    await store.appendEvent(run.id, {
      type: "status",
      level: "info",
      message: "Machine ready. Starting agent loop.",
    });

    await store.updateStatus(run.id, "Running");
    const outcome = await runOpenAILoop({
      client,
      model: run.model,
      scenario,
      input: run.input,
      sidecar,
      runId: run.id,
      runDir: run.replayDir,
      onEvent: async (event) => {
        await store.appendEvent(run.id, event);
      },
      shouldStop: () => Boolean(store.getRun(run.id)?.stopRequested),
    });

    await store.updateStatus(run.id, "Verifying", { summary: outcome.summary });
    await store.appendEvent(run.id, {
      type: "status",
      level: "info",
      message: "Running scenario verifier.",
    });

    const verification = await scenario.verify({
      input: run.input,
      runDir: run.replayDir,
    });
    await store.appendEvent(run.id, {
      type: "verifier",
      level: verification.ok ? "info" : "error",
      message: verification.summary,
      payload: verification,
    });

    if (!verification.ok) {
      await store.updateStatus(run.id, "Failed", {
        error: {
          code: "Failed.VerifierRejected",
          message: verification.summary,
          details: verification.checks,
        },
      });
      await store.appendEvent(run.id, {
        type: "final",
        level: "error",
        message: "Run failed during verification.",
        payload: verification,
      });
      return;
    }

    await store.updateStatus(run.id, "Succeeded", { summary: verification.summary });
    await store.appendEvent(run.id, {
      type: "final",
      level: "info",
      message: "Run completed successfully.",
      payload: verification,
    });
  } catch (error) {
    const classified = classifyError(error);
    const finalStatus = classified.code === "Stopped.ByOperator" ? "Stopped" : classified.code.startsWith("Blocked.") ? "Blocked" : "Failed";

    await store.updateStatus(run.id, finalStatus, {
      error: classified,
    });
    await store.appendEvent(run.id, {
      type: "error",
      level: "error",
      message: classified.message,
      payload: classified,
    });
    await store.appendEvent(run.id, {
      type: "final",
      level: "error",
      message: `Run finished with status ${finalStatus}.`,
      payload: classified,
    });
  }
}

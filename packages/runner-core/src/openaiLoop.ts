import path from "node:path";
import type { RunEvent } from "../../replay-schema/src/types.js";
import type { ScenarioDefinition } from "../../scenario-kit/src/types.js";
import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import { driveDesktopAgent } from "./desktopAgent.js";
import type { ResponsesClient } from "./responsesClient.js";

interface LoopContext {
  client: ResponsesClient;
  model: string;
  scenario: ScenarioDefinition;
  input: Record<string, unknown>;
  sidecar: DesktopSidecar;
  runId: string;
  runDir: string;
  onEvent: (event: Omit<RunEvent, "id" | "runId" | "at">) => Promise<void>;
  shouldStop: () => boolean;
}

function buildDeveloperPrompt(scenario: ScenarioDefinition, input: Record<string, unknown>) {
  return [
    "You are the autonomous Windows execution engine for a dedicated enterprise machine.",
    "Operate only inside the scenario boundary and do not ask the human for confirmation.",
    "Tool preference order is strict: 1) UI Automation and file/process tools, 2) other deterministic tools, 3) desktop_actions for coordinate-based visual fallback, 4) the computer tool when available.",
    "If you hit UAC, a security prompt, CAPTCHA, or an impossible boundary, stop and explain the blocking condition instead of improvising.",
    "Keep actions minimal, reversible when possible, and aligned with the declared input.",
    "When a desktop screenshot is attached, treat it as the current visual state and use absolute pixel coordinates for desktop_actions.",
    `Scenario: ${scenario.manifest.title}`,
    `Description: ${scenario.manifest.description ?? scenario.manifest.title}`,
    `Target apps: ${scenario.manifest.target_apps.join(", ")}`,
    `Success criteria: ${scenario.manifest.success_criteria.join(" | ")}`,
    `Input JSON: ${JSON.stringify(input)}`,
    "Scenario-specific guidance follows.",
    scenario.prompt.trim(),
  ].join("\n");
}

export async function runOpenAILoop(context: LoopContext): Promise<{ summary: string }> {
  const result = await driveDesktopAgent({
    client: context.client,
    model: context.model,
    developerPrompt: buildDeveloperPrompt(context.scenario, context.input),
    userContent: JSON.stringify(context.input, null, 2),
    sidecar: context.sidecar,
    artifactDir: context.runDir,
    screenshotBaseUrl: `/artifacts/${path.basename(context.runDir)}`,
    onEvent: async (event) => {
      if (event.type === "message") {
        await context.onEvent({
          type: "log",
          level: event.level,
          message: event.message,
          payload: event.payload,
        });
        return;
      }
      await context.onEvent(event as Omit<RunEvent, "id" | "runId" | "at">);
    },
    shouldStop: context.shouldStop,
  });

  return { summary: result.summary };
}

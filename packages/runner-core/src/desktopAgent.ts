import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResponseComputerToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import type { ComputerAction } from "../../desktop-runtime/src/types.js";
import type { BrowserSessionManager } from "../../browser-runtime/src/browserSessionManager.js";
import { createToolRegistry } from "./toolRegistry.js";
import type { ResponsesClient } from "./responsesClient.js";
import type { MemoryManager } from "../../memory/src/memoryManager.js";

export interface DesktopAgentEvent {
  type: "status" | "log" | "tool_call" | "tool_result" | "computer_action" | "screenshot" | "error" | "message";
  level: "info" | "warning" | "error";
  message: string;
  payload?: unknown;
}

export interface DesktopAgentToolCall {
  name: string;
  args: unknown;
  result: unknown;
}

function serializeToolError(error: unknown) {
  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        message: error.message,
        name: error.name,
      },
    };
  }

  return {
    ok: false,
    error: {
      message: String(error),
      name: "ToolExecutionError",
    },
  };
}

interface DriveDesktopAgentContext {
  client: ResponsesClient;
  model: string;
  developerPrompt: string;
  userContent: string;
  sidecar: DesktopSidecar;
  artifactDir: string;
  screenshotBaseUrl: string;
  previousResponseId?: string;
  maxTurns?: number;
  onEvent: (event: DesktopAgentEvent) => Promise<void>;
  shouldStop?: () => boolean;
  memoryManager?: MemoryManager;
  browserSessionManager?: BrowserSessionManager;
  sessionId?: string;
}

interface VisualObservation {
  latestScreenshotUrl: string;
  input: ResponseInputItem;
}

/**
 * Lightweight screenshot hash: samples evenly-spaced bytes from the base64
 * string to produce a short fingerprint. Two screenshots with the same hash
 * are visually identical (within the sampling resolution).
 */
function screenshotHash(base64Image: string, samples = 64): string {
  const len = base64Image.length;
  if (len === 0) return "";
  const step = Math.max(1, Math.floor(len / samples));
  let hash = "";
  for (let i = 0; i < len; i += step) {
    hash += base64Image[i];
  }
  return hash;
}

const STALL_THRESHOLD = 3;

const STALL_RECOVERY_PROMPT =
  "No visual progress detected for multiple turns — your recent actions are not producing any change on screen. " +
  "Do NOT repeat the same approach. Try a completely different strategy: use a different tool, click different coordinates, or take a different workflow path. " +
  "If you are blocked by a CAPTCHA, verification code, or login wall that you cannot solve, skip it and try an alternative path to complete the task.";

function extractOutputText(response: { output_text?: string; output?: unknown[] }) {
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

function extractComputerActions(call: ResponseComputerToolCall): ComputerAction[] {
  const actions = Array.isArray(call.actions) ? (call.actions as ComputerAction[]) : [];
  if (actions.length > 0) {
    return actions;
  }

  if (call.action && typeof call.action === "object") {
    return [call.action as ComputerAction];
  }

  return [];
}

async function saveScreenshot(artifactDir: string, screenshotBaseUrl: string, base64Image: string, prefix: string) {
  const fileName = `${prefix}-${Date.now()}.png`;
  const filePath = path.join(artifactDir, "screenshots", fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(base64Image, "base64"));
  return {
    fileName,
    filePath,
    url: `${screenshotBaseUrl}/screenshots/${fileName}`,
  };
}

async function captureVisualObservation(
  context: Pick<DriveDesktopAgentContext, "sidecar" | "artifactDir" | "screenshotBaseUrl" | "onEvent" | "userContent">,
  label: string,
  stallDetected = false,
): Promise<VisualObservation & { hash: string }> {
  const screenshot = await context.sidecar.captureScreenshot();
  const saved = await saveScreenshot(context.artifactDir, context.screenshotBaseUrl, screenshot.imageBase64, label);
  await context.onEvent({
    type: "screenshot",
    level: "info",
    message: "Screenshot captured",
    payload: {
      url: saved.url,
      width: screenshot.width,
      height: screenshot.height,
    },
  });

  const lines = [
    "[Desktop Observation]",
    `Current instruction: ${context.userContent}`,
    `Screen size: ${screenshot.width}x${screenshot.height}. Coordinates must use absolute pixels on this screenshot.`,
    "Use desktop_actions for visual fallback when UI Automation cannot identify the target reliably.",
    "If the requested action has already been completed, do not repeat the same desktop_actions call. Summarize completion and stop.",
  ];

  if (stallDetected) {
    lines.push("");
    lines.push(`[STALL WARNING] ${STALL_RECOVERY_PROMPT}`);
  }

  return {
    hash: screenshotHash(screenshot.imageBase64),
    latestScreenshotUrl: saved.url,
    input: {
      role: "user",
      content: [
        {
          type: "input_text",
          text: lines.join("\n"),
        },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${screenshot.imageBase64}`,
          detail: "high",
        },
      ],
    },
  };
}

export async function driveDesktopAgent(context: DriveDesktopAgentContext): Promise<{
  summary: string;
  responseId: string;
  latestScreenshotUrl?: string;
  toolCalls: DesktopAgentToolCall[];
}> {
  const visualGroundingEnabled = context.client.supportsImageInput === true && context.client.supportsComputerTool === false;
  const toolSessionId = context.sessionId ?? `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toolDefinitions = createToolRegistry(context.sidecar, {
    browserSessionManager: context.browserSessionManager,
    browserSessionId: toolSessionId,
  });
  const tools = [
    ...(context.client.supportsComputerTool === false ? [] : [{ type: "computer" as const }]),
    ...toolDefinitions.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      strict: true,
      parameters: tool.parameters,
    })),
  ];
  const registry = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

  let latestScreenshotUrl: string | undefined;
  let executedToolCallCount = 0;
  let remindedToolUse = false;
  const collectedToolCalls: DesktopAgentToolCall[] = [];

  // Broader duplicate detection: track last 3 tool call signatures
  const recentToolSignatures: Array<{ name: string; signature: string }> = [];

  // Visual stall detection
  let lastScreenshotHash: string | undefined;
  let consecutiveStallCount = 0;

  // Build memory-enhanced developer prompt
  let enhancedPrompt = context.developerPrompt;
  if (context.memoryManager && context.sessionId) {
    try {
      const windows = await context.sidecar.listWindows();
      const foreground = windows.find((w) => w.isForeground);
      const memoryContext = await context.memoryManager.buildMemoryContext(
        context.userContent,
        windows,
        foreground,
        context.sessionId,
      );
      if (memoryContext) {
        enhancedPrompt = `${context.developerPrompt}\n${memoryContext}`;
      }
    } catch {
      // Memory building is best-effort
    }
  }

  const initialInput: ResponseInputItem[] = [];
  if (!context.previousResponseId) {
    initialInput.push({ role: "developer", content: enhancedPrompt });
  }

  if (visualGroundingEnabled) {
    const observation = await captureVisualObservation(context, "observe-initial");
    latestScreenshotUrl = observation.latestScreenshotUrl;
    lastScreenshotHash = observation.hash;
    initialInput.push(observation.input);
  } else {
    initialInput.push({ role: "user", content: context.userContent });
  }

  let response = await context.client.createResponse({
    model: context.model,
    tools,
    previous_response_id: context.previousResponseId,
    input: initialInput,
  });

  for (let turn = 0; turn < (context.maxTurns ?? 40); turn += 1) {
    if (context.shouldStop?.()) {
      throw new Error("Live session stopped by operator.");
    }

    const output = Array.isArray(response.output) ? response.output : [];
    const functionCalls = output.filter((item) => item.type === "function_call");
    const computerCalls = output.filter((item) => item.type === "computer_call");
    const outputText = extractOutputText(response);

    if (outputText) {
      await context.onEvent({
        type: "message",
        level: "info",
        message: "Assistant message",
        payload: { text: outputText },
      });
    }

    if (functionCalls.length === 0 && computerCalls.length === 0) {
      if (executedToolCallCount === 0) {
        if (remindedToolUse) {
          throw new Error("Model attempted to finish without using any operator tools for the current instruction.");
        }

        remindedToolUse = true;
        response = await context.client.createResponse({
          model: context.model,
          previous_response_id: response.id,
          tools,
          input: [
            {
              role: "user",
              content:
                "You have not used any operator tools for this instruction yet. Do not assume completion. Use at least one appropriate browser or desktop tool to inspect or act, then verify the result before answering.",
            },
          ],
        });
        continue;
      }

      // Record turn results in memory
      if (context.memoryManager && context.sessionId) {
        try {
          await context.memoryManager.recordTurnResult(
            context.sessionId,
            context.userContent,
            collectedToolCalls,
            outputText || "",
          );
        } catch {
          // Memory recording is best-effort
        }
      }

      return {
        summary: outputText || "Model finished without additional tool calls.",
        responseId: response.id,
        latestScreenshotUrl,
        toolCalls: collectedToolCalls,
      };
    }

    const nextInput: ResponseInputItem[] = [];

    for (const call of functionCalls) {
      const tool = registry.get(call.name);
      if (!tool) {
        throw new Error(`Unsupported tool requested by model: ${call.name}`);
      }

      const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
      await context.onEvent({
        type: "tool_call",
        level: "info",
        message: `Function call: ${call.name}`,
        payload: { name: call.name, arguments: args },
      });

      const signature = JSON.stringify(args);
      const currentSig = { name: call.name, signature };

      // Broader duplicate detection: skip if same tool+args appears 2+ times in last 3 calls
      const duplicateCount = recentToolSignatures.filter(
        (s) => s.name === currentSig.name && s.signature === currentSig.signature,
      ).length;

      const result =
        duplicateCount >= 2
          ? {
              skipped: true,
              reason:
                `The same ${call.name} call was already executed ${duplicateCount} times in recent turns. ` +
                "This approach is not working. Try a completely different action, tool, or workflow path.",
            }
          : await tool.execute(args).catch((error) => serializeToolError(error));

      executedToolCallCount += 1;

      // Track stall for non-visual mode: duplicate skips count as stalls
      if (!visualGroundingEnabled) {
        if (duplicateCount >= 2) {
          consecutiveStallCount += 1;
        } else {
          consecutiveStallCount = 0;
        }
      }

      // Maintain a sliding window of last 3 tool signatures
      recentToolSignatures.push(currentSig);
      if (recentToolSignatures.length > 3) {
        recentToolSignatures.shift();
      }
      await context.onEvent({
        type: "tool_result",
        level: result && typeof result === "object" && "ok" in result && result.ok === false ? "warning" : "info",
        message: `Function result: ${call.name}`,
        payload: result,
      });

      collectedToolCalls.push({ name: call.name, args, result });

      nextInput.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }

    for (const call of computerCalls) {
      const actions = extractComputerActions(call);
      let screenshot;
      executedToolCallCount += 1;

      if (actions.length === 0 || actions.every((action) => action.type === "screenshot")) {
        screenshot = await context.sidecar.captureScreenshot();
      } else {
        await context.onEvent({
          type: "computer_action",
          level: "info",
          message: "Computer actions requested",
          payload: actions,
        });
        const executed = await context.sidecar.execActions({ actions });
        screenshot = executed.screenshot;
      }

      const saved = await saveScreenshot(context.artifactDir, context.screenshotBaseUrl, screenshot.imageBase64, `turn-${turn}`);
      latestScreenshotUrl = saved.url;
      await context.onEvent({
        type: "screenshot",
        level: "info",
        message: "Screenshot captured",
        payload: {
          url: saved.url,
          width: screenshot.width,
          height: screenshot.height,
        },
      });

      nextInput.push({
        type: "computer_call_output",
        call_id: call.call_id,
        acknowledged_safety_checks: Array.isArray(call.pending_safety_checks)
          ? call.pending_safety_checks.map((check) => ({
              id: check.id,
              code: check.code ?? null,
              message: check.message ?? null,
            }))
          : [],
        output: {
          type: "computer_screenshot",
          image_url: `data:image/png;base64,${screenshot.imageBase64}`,
        },
      });
    }

    if (visualGroundingEnabled) {
      const stallDetected = consecutiveStallCount >= STALL_THRESHOLD;
      const observation = await captureVisualObservation(context, `observe-turn-${turn}`, stallDetected);
      latestScreenshotUrl = observation.latestScreenshotUrl;

      // Visual stall detection: compare screenshot hashes
      if (lastScreenshotHash && observation.hash === lastScreenshotHash) {
        consecutiveStallCount += 1;
      } else {
        consecutiveStallCount = 0;
      }
      lastScreenshotHash = observation.hash;

      if (stallDetected) {
        await context.onEvent({
          type: "log",
          level: "warning",
          message: `Stall detected: screen unchanged for ${consecutiveStallCount} consecutive turns. Injecting recovery prompt.`,
        });
      }

      nextInput.push(observation.input);
    } else if (consecutiveStallCount >= STALL_THRESHOLD) {
      // Even without visual grounding, inject recovery prompt after repeated stalls
      nextInput.push({
        role: "user",
        content: STALL_RECOVERY_PROMPT,
      });
      await context.onEvent({
        type: "log",
        level: "warning",
        message: `Stall detected: same tool calls repeated for ${consecutiveStallCount} turns. Injecting recovery prompt.`,
      });
    }

    response = await context.client.createResponse({
      model: context.model,
      previous_response_id: response.id,
      tools,
      input: nextInput,
    });
  }

  throw new Error(`Agent loop exceeded ${context.maxTurns ?? 40} turns.`);
}

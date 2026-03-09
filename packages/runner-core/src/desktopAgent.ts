import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResponseComputerToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import type { ComputerAction } from "../../desktop-runtime/src/types.js";
import { createToolRegistry } from "./toolRegistry.js";
import type { ResponsesClient } from "./responsesClient.js";

export interface DesktopAgentEvent {
  type: "status" | "log" | "tool_call" | "tool_result" | "computer_action" | "screenshot" | "error" | "message";
  level: "info" | "warning" | "error";
  message: string;
  payload?: unknown;
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
}

interface VisualObservation {
  latestScreenshotUrl: string;
  input: ResponseInputItem;
}

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
): Promise<VisualObservation> {
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

  return {
    latestScreenshotUrl: saved.url,
    input: {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "[Desktop Observation]",
            `Current instruction: ${context.userContent}`,
            `Screen size: ${screenshot.width}x${screenshot.height}. Coordinates must use absolute pixels on this screenshot.`,
            "Use desktop_actions for visual fallback when UI Automation cannot identify the target reliably.",
            "If the requested action has already been completed, do not repeat the same desktop_actions call. Summarize completion and stop.",
          ].join("\n"),
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
}> {
  const visualGroundingEnabled = context.client.supportsImageInput === true && context.client.supportsComputerTool === false;
  const tools = [
    ...(context.client.supportsComputerTool === false ? [] : [{ type: "computer" as const }]),
    ...createToolRegistry(context.sidecar).map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      strict: true,
      parameters: tool.parameters,
    })),
  ];
  const registry = new Map(createToolRegistry(context.sidecar).map((tool) => [tool.name, tool]));

  let latestScreenshotUrl: string | undefined;
  let lastExecutedToolSignature: { name: string; signature: string } | undefined;
  let executedToolCallCount = 0;
  let remindedToolUse = false;
  const initialInput: ResponseInputItem[] = [];
  if (!context.previousResponseId) {
    initialInput.push({ role: "developer", content: context.developerPrompt });
  }

  if (visualGroundingEnabled) {
    const observation = await captureVisualObservation(context, "observe-initial");
    latestScreenshotUrl = observation.latestScreenshotUrl;
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
          throw new Error("Model attempted to finish without using any desktop tools for the current instruction.");
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
                "You have not used any desktop tools for this instruction yet. Do not assume completion. Use at least one appropriate tool to inspect or act on the desktop, then verify the result before answering.",
            },
          ],
        });
        continue;
      }

      return {
        summary: outputText || "Model finished without additional tool calls.",
        responseId: response.id,
        latestScreenshotUrl,
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
      const result =
        call.name === "desktop_actions" &&
        lastExecutedToolSignature?.name === call.name &&
        lastExecutedToolSignature.signature === signature
          ? {
              skipped: true,
              reason:
                "The same desktop_actions request was already executed on the previous turn. Review the latest screenshot and either finish or choose a different action.",
            }
          : await tool.execute(args);

      executedToolCallCount += 1;

      lastExecutedToolSignature =
        call.name === "desktop_actions"
          ? {
              name: call.name,
              signature,
            }
          : undefined;
      await context.onEvent({
        type: "tool_result",
        level: "info",
        message: `Function result: ${call.name}`,
        payload: result,
      });

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
      const observation = await captureVisualObservation(context, `observe-turn-${turn}`);
      latestScreenshotUrl = observation.latestScreenshotUrl;
      nextInput.push(observation.input);
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

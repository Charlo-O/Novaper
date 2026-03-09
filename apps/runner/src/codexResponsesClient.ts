import type { Response, ResponseCreateParamsNonStreaming, ResponseInputItem, ResponseOutputItem, Tool } from "openai/resources/responses/responses";
import { fetch } from "undici";
import type { ResponsesClient } from "../../../packages/runner-core/src/responsesClient.js";
import { getProxyDispatcher } from "./networkProxy.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          const candidate = item as Record<string, unknown>;
          if (typeof candidate.text === "string") {
            return candidate.text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function normalizeInputItems(input: ResponseCreateParamsNonStreaming["input"]): ResponseInputItem[] {
  if (input == null) {
    return [];
  }

  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (Array.isArray(input)) {
    return input as ResponseInputItem[];
  }

  return [input as ResponseInputItem];
}

function isDeveloperMessage(item: ResponseInputItem): item is ResponseInputItem & { role: "developer"; content: unknown } {
  return Boolean(item && typeof item === "object" && "role" in item && item.role === "developer" && "content" in item);
}

function isVisualObservationMessage(item: ResponseInputItem) {
  if (!item || typeof item !== "object" || !("role" in item) || item.role !== "user" || !("content" in item) || !Array.isArray(item.content)) {
    return false;
  }

  const hasImage = item.content.some((part) => part && typeof part === "object" && "type" in part && part.type === "input_image");
  const hasMarkerText = item.content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "input_text" &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text.includes("[Desktop Observation]"),
  );

  return hasImage && hasMarkerText;
}

function deriveOutputText(response: Response) {
  const outputs = Array.isArray(response.output) ? response.output : [];
  return outputs
    .flatMap((item) => {
      if (!item || typeof item !== "object" || item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }

      return item.content
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

function filterHistoryOutputItems(output: Response["output"]): ResponseOutputItem[] {
  if (!Array.isArray(output)) {
    return [];
  }

  return output.filter((item) => item.type === "message" || item.type === "function_call");
}

function makeSchemaNullable(schema: Record<string, unknown>) {
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }

  if (typeof schema.type === "string" && schema.type !== "null") {
    return { ...schema, type: [schema.type, "null"] };
  }

  if (Array.isArray(schema.enum)) {
    return { anyOf: [schema, { type: "null" }] };
  }

  return schema;
}

function normalizeSchemaForCodex(schema: Record<string, unknown>): Record<string, unknown> {
  const next = { ...schema };

  if (next.properties && typeof next.properties === "object" && !Array.isArray(next.properties)) {
    const entries = Object.entries(next.properties as Record<string, unknown>);
    const normalizedProperties = Object.fromEntries(
      entries.map(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [key, value];
        }

        const normalized = normalizeSchemaForCodex(value as Record<string, unknown>);
        return [key, makeSchemaNullable(normalized)];
      }),
    );

    next.properties = normalizedProperties;
    next.required = Object.keys(normalizedProperties);
  }

  if (next.items && typeof next.items === "object" && !Array.isArray(next.items)) {
    next.items = normalizeSchemaForCodex(next.items as Record<string, unknown>);
  }

  return next;
}

function filterTools(tools?: Tool[]) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const filtered = tools
    .filter((tool) => tool.type !== "computer")
    .map((tool) => {
      if (tool.type !== "function") {
        return tool;
      }

      return {
        ...tool,
        parameters: normalizeSchemaForCodex(tool.parameters as Record<string, unknown>),
      };
    });
  return filtered.length > 0 ? filtered : undefined;
}

async function* parseSseEvents(response: { body?: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } | null }): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();

      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // Ignore malformed chunks from intermediary proxies.
        }
      }

      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function createCodexResponsesClient(config: {
  accessToken: string;
  accountId: string;
}): ResponsesClient {
  let instructions = "";
  let history: Array<ResponseInputItem | ResponseOutputItem> = [];

  return {
    supportsComputerTool: false,
    supportsImageInput: true,
    async createResponse(input: ResponseCreateParamsNonStreaming): Promise<Response> {
      const incoming = normalizeInputItems(input.input);
      const developerItems = incoming.filter(isDeveloperMessage);
      const nextInstructions = developerItems
        .map((item) => extractTextContent(item.content))
        .filter(Boolean)
        .join("\n\n")
        .trim();

      if (nextInstructions) {
        instructions = nextInstructions;
      }

      if (!instructions) {
        throw new Error("Codex OAuth requests require a developer prompt to seed instructions.");
      }

      const nextInput = incoming.filter((item) => !isDeveloperMessage(item));
      const prunedHistory = nextInput.some(isVisualObservationMessage)
        ? history.filter((item) => !("role" in item) || !isVisualObservationMessage(item as ResponseInputItem))
        : history;
      const requestInput = [...prunedHistory, ...nextInput];
      const tools = filterTools(input.tools);
      const body: Record<string, unknown> = {
        model: input.model,
        instructions,
        input: requestInput,
        store: false,
        stream: true,
      };

      if (tools) {
        body.tools = tools;
        body.tool_choice = "auto";
        body.parallel_tool_calls = input.parallel_tool_calls ?? true;
      }

      if (typeof input.temperature === "number") {
        body.temperature = input.temperature;
      }

      const response = await fetch(CODEX_RESPONSES_URL, {
        dispatcher: getProxyDispatcher(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
          "chatgpt-account-id": config.accountId,
          "OpenAI-Beta": "responses=experimental",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${response.status} status code${detail ? `: ${detail}` : " (no body)"}`);
      }

      let completed: Response | undefined;
      for await (const event of parseSseEvents(response)) {
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "error") {
          const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
          throw new Error(message);
        }

        if ((type === "response.completed" || type === "response.done") && event.response && typeof event.response === "object") {
          completed = event.response as Response;
          break;
        }

        if (type === "response.failed") {
          const errorMessage =
            event.response && typeof event.response === "object" && "error" in event.response
              ? JSON.stringify((event.response as Record<string, unknown>).error)
              : "Codex response failed.";
          throw new Error(errorMessage);
        }
      }

      if (!completed) {
        throw new Error("Codex response stream ended without a completed response.");
      }

      const outputText = deriveOutputText(completed);
      (completed as Response & { output_text?: string }).output_text = outputText;
      history = [...requestInput, ...filterHistoryOutputItems(completed.output)];
      return completed;
    },
  };
}

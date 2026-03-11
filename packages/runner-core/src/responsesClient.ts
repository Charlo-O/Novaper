import type OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming, ResponseOutputItem } from "openai/resources/responses/responses";

export interface ResponsesClient {
  supportsComputerTool?: boolean;
  supportsImageInput?: boolean;
  createResponse(input: ResponseCreateParamsNonStreaming): Promise<Response>;
}

export function createResponsesClient(getClient: () => Promise<OpenAI>): ResponsesClient {
  return {
    supportsComputerTool: true,
    supportsImageInput: true,
    async createResponse(input: ResponseCreateParamsNonStreaming) {
      const client = await getClient();
      return client.responses.create(input);
    },
  };
}

// ---------------------------------------------------------------------------
// Chat Completions adapter — translates the Responses API interface into
// /v1/chat/completions calls so that third-party OpenAI-compatible providers
// (BigModel, ModelScope, etc.) can be used by the existing agent loop.
// ---------------------------------------------------------------------------

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.ChatCompletionTool;

/** Convert Responses-API input items into Chat Completions messages. */
function inputItemsToMessages(items: ResponseCreateParamsNonStreaming["input"]): ChatMessage[] {
  if (typeof items === "string") {
    return [{ role: "user", content: items }];
  }

  const messages: ChatMessage[] = [];

  for (const rawItem of items as unknown[]) {
    const item = rawItem as Record<string, unknown>;
    const role = item.role as string | undefined;
    const type = item.type as string | undefined;

    if (role === "developer" || role === "system") {
      const content = item.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n")
          : "";
      messages.push({ role: "system", content: text });
    } else if (role === "user") {
      const content = item.content;
      if (typeof content === "string") {
        messages.push({ role: "user", content });
      } else if (Array.isArray(content)) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const part of content as Array<Record<string, unknown>>) {
          if (part.type === "input_text" && typeof part.text === "string") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "input_image") {
            const src = part.image_url ?? part.source;
            if (typeof src === "string") {
              parts.push({ type: "image_url", image_url: { url: src } });
            } else if (src && typeof src === "object") {
              const srcObj = src as Record<string, unknown>;
              const url = (srcObj.url ?? srcObj.data ?? "") as string;
              if (url) {
                parts.push({ type: "image_url", image_url: { url } });
              }
            }
          }
        }
        if (parts.length > 0) {
          messages.push({ role: "user", content: parts });
        }
      }
    } else if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id as string,
        content: item.output as string,
      });
    }
  }

  return messages;
}

/** Convert Responses-API tool defs into Chat Completions tool defs. */
function convertTools(tools: ResponseCreateParamsNonStreaming["tools"]): ChatTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const chatTools: ChatTool[] = [];
  for (const rawTool of tools) {
    const t = rawTool as unknown as Record<string, unknown>;
    // Only convert function tools; skip computer tools etc.
    if (t.type === "function") {
      chatTools.push({
        type: "function",
        function: {
          name: t.name as string,
          description: (t.description as string) || "",
          parameters: (t.parameters as Record<string, unknown>) || {},
          ...(t.strict ? { strict: true } : {}),
        },
      });
    }
  }

  return chatTools.length > 0 ? chatTools : undefined;
}

let responseIdCounter = 0;

/** Build a fake Responses API Response from a Chat Completions response. */
function chatCompletionToResponse(
  cc: OpenAI.Chat.ChatCompletion,
): Response {
  const id = `chatcmpl-adapter-${++responseIdCounter}`;
  const output: ResponseOutputItem[] = [];
  const choice = cc.choices?.[0];
  const msg = choice?.message as unknown as {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  } | undefined;

  if (msg?.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      } as unknown as ResponseOutputItem);
    }
  }

  const textContent = msg?.content;
  if (textContent) {
    output.push({
      type: "message",
      id: `msg-${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: textContent, annotations: [] }],
    } as unknown as ResponseOutputItem);
  }

  return {
    id,
    object: "response",
    created_at: cc.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    output,
    output_text: textContent ?? "",
    model: cc.model ?? "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    max_output_tokens: null,
    previous_response_id: null,
    reasoning: null,
    usage: null,
    user: null,
    background: null,
    service_tier: null,
  } as unknown as Response;
}

/**
 * Create a ResponsesClient that talks to a Chat Completions endpoint.
 * Maintains conversation history internally to support multi-turn.
 */
export function createChatCompletionsClient(getClient: () => Promise<OpenAI>): ResponsesClient {
  const responseHistory = new Map<string, ChatMessage[]>();

  return {
    supportsComputerTool: false,
    supportsImageInput: true,

    async createResponse(input: ResponseCreateParamsNonStreaming): Promise<Response> {
      const client = await getClient();

      let messages: ChatMessage[] = [];

      // If continuing a conversation, prepend stored history
      const prevId = input.previous_response_id;
      if (prevId && typeof prevId === "string" && responseHistory.has(prevId)) {
        messages = [...responseHistory.get(prevId)!];
      }

      // Add system instructions if provided
      if (input.instructions) {
        const existing = messages.find((m) => m.role === "system");
        if (!existing) {
          messages.unshift({ role: "system", content: input.instructions });
        }
      }

      // Convert and append new input items
      const newMessages = inputItemsToMessages(input.input);
      messages.push(...newMessages);

      // Convert tools
      const tools = convertTools(input.tools);

      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: input.model as string,
        messages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
      };

      const completion = await client.chat.completions.create(params);
      const response = chatCompletionToResponse(completion);

      // Store conversation history for the next turn
      const historySnapshot = [...messages];
      const choiceMsg = completion.choices?.[0]?.message;
      if (choiceMsg) {
        historySnapshot.push(choiceMsg as ChatMessage);
      }
      responseHistory.set(response.id, historySnapshot);

      return response;
    },
  };
}

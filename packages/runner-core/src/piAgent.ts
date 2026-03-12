/**
 * CLI coding agent — ported from pi-mono (github.com/badlogic/pi-mono)
 * Full coding agent capabilities:
 * - 7 CLI tools (read, bash, edit, write, grep, find, ls)
 * - Structured system prompt with tool descriptions and guidelines
 * - Auto-compaction when context grows too large
 * - Auto-retry on transient LLM failures
 * - Project context loading (.agents/ files)
 * - Uses the same ResponsesClient as the desktop agent (supports Codex OAuth)
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { DesktopAgentEvent } from "./desktopAgent.js";
import type { ResponsesClient } from "./responsesClient.js";
import { buildActiveSkillsPrompt } from "./capabilityProfile.js";
import { createCliTools, type CliTool } from "./piTools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrivePiAgentContext {
  instruction: string;
  client: ResponsesClient;
  model: string;
  artifactDir: string;
  onEvent: (event: DesktopAgentEvent) => Promise<void>;
  shouldStop: () => boolean;
  maxTurns?: number;
  skills?: Array<{ name: string; content: string }>;
  capabilityBrief?: string;
}

// ---------------------------------------------------------------------------
// System prompt — ported from pi-mono/coding-agent/src/core/system-prompt.ts
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make surgical edits to files (find exact text and replace)",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

function buildSystemPrompt(
  cwd: string,
  toolNames: string[],
  contextFiles: Array<{ path: string; content: string }>,
  skills?: Array<{ name: string; content: string }>,
  capabilityBrief?: string,
): string {
  const now = new Date();
  const dateTime = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  const toolsList = toolNames
    .map((name) => `- ${name}: ${TOOL_DESCRIPTIONS[name] ?? name}`)
    .join("\n");

  // Build guidelines based on available tools (from pi-mono system-prompt.ts)
  const guidelines: string[] = [];
  const hasBash = toolNames.includes("bash");
  const hasEdit = toolNames.includes("edit");
  const hasWrite = toolNames.includes("write");
  const hasGrep = toolNames.includes("grep");
  const hasFind = toolNames.includes("find");
  const hasRead = toolNames.includes("read");

  if (hasBash && !hasGrep && !hasFind) {
    guidelines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind)) {
    guidelines.push("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
  }
  if (hasRead && hasEdit) {
    guidelines.push("Use read to examine files before editing. You must use this tool instead of cat or sed.");
  }
  if (hasEdit) {
    guidelines.push("Use edit for precise changes (old text must match exactly)");
  }
  if (hasWrite) {
    guidelines.push("Use write only for new files or complete rewrites");
  }
  if (hasEdit || hasWrite) {
    guidelines.push("When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did");
  }
  guidelines.push("Be concise in your responses");
  guidelines.push("Show file paths clearly when working with files");

  const guidelinesText = guidelines.map((g) => `- ${g}`).join("\n");

  let prompt = `You are an expert coding assistant operating inside a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

Guidelines:
${guidelinesText}`;

  if (capabilityBrief?.trim()) {
    prompt += `\n\n${capabilityBrief.trim()}`;
  }

  // Append project context files
  if (contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `## ${filePath}\n\n${content}\n\n`;
    }
  }

  // Append active skills
  const skillsPrompt = buildActiveSkillsPrompt(skills);
  if (skillsPrompt) {
    prompt += `\n\n${skillsPrompt}`;
  }

  prompt += `\nCurrent date and time: ${dateTime}`;
  prompt += `\nCurrent working directory: ${cwd}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Project context loading — ported from pi-mono resource-loader
// ---------------------------------------------------------------------------

async function loadProjectContext(cwd: string): Promise<Array<{ path: string; content: string }>> {
  const contextFiles: Array<{ path: string; content: string }> = [];

  // Load from .agents/ directory (pi-mono convention)
  for (const dirName of [".agents", ".pi"]) {
    const agentsDir = path.join(cwd, dirName);
    try {
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
          const filePath = path.join(agentsDir, entry.name);
          const content = await fs.readFile(filePath, "utf-8");
          contextFiles.push({ path: `${dirName}/${entry.name}`, content: content.trim() });
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  // Also check for AGENTS.md or CLAUDE.md in project root
  for (const fileName of ["AGENTS.md", "CLAUDE.md", "CODING_AGENT.md"]) {
    const filePath = path.join(cwd, fileName);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      contextFiles.push({ path: fileName, content: content.trim() });
    } catch {
      // File doesn't exist, skip
    }
  }

  return contextFiles;
}

// ---------------------------------------------------------------------------
// Compaction — simplified from pi-mono compaction system
// ---------------------------------------------------------------------------

const COMPACTION_SYSTEM_PROMPT = [
  "You are a conversation summarizer. Given a conversation between a user and a coding assistant,",
  "create a concise summary that captures:",
  "- What the user asked for",
  "- What files were read, created, or modified",
  "- What commands were executed and their outcomes",
  "- The current state of the task (completed, in progress, blocked)",
  "- Any important context needed to continue the work",
  "",
  "Be concise but preserve all actionable information. Output only the summary.",
].join("\n");

const MAX_CONTEXT_MESSAGES = 40; // Trigger compaction after this many messages
const COMPACTION_KEEP_RECENT = 6; // Keep this many recent messages after compaction

function shouldCompact(messages: ResponseInputItem[]): boolean {
  return messages.length > MAX_CONTEXT_MESSAGES;
}

async function compactMessages(
  messages: ResponseInputItem[],
  client: ResponsesClient,
  model: string,
  onEvent: (event: DesktopAgentEvent) => Promise<void>,
): Promise<ResponseInputItem[]> {
  // Separate messages to summarize and messages to keep
  const toSummarize = messages.slice(0, -COMPACTION_KEEP_RECENT);
  const toKeep = messages.slice(-COMPACTION_KEEP_RECENT);

  // Build conversation text for summarization
  const conversationText = toSummarize
    .map((msg) => {
      if ("role" in msg && typeof msg.role === "string") {
        const content = "content" in msg ? msg.content : "";
        const text = typeof content === "string" ? content : JSON.stringify(content);
        return `[${msg.role}]: ${text.slice(0, 2000)}`;
      }
      if ("type" in msg && msg.type === "function_call_output") {
        const output = "output" in msg ? String(msg.output) : "";
        return `[tool_result]: ${output.slice(0, 1000)}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  await onEvent({
    type: "status",
    level: "info",
    message: "Auto-compacting conversation history...",
  });

  try {
    const response = await client.createResponse({
      model,
      input: [
        { role: "developer", content: COMPACTION_SYSTEM_PROMPT },
        { role: "user", content: `Summarize this conversation:\n\n${conversationText}` },
      ],
      tools: [],
    });

    const summary = typeof response.output_text === "string" ? response.output_text.trim() : "Conversation history was compacted.";

    await onEvent({
      type: "log",
      level: "info",
      message: `Compacted ${toSummarize.length} messages into summary.`,
      payload: { messagesBefore: messages.length, messagesAfter: toKeep.length + 1 },
    });

    // Return: developer prompt (first message) + compaction summary + recent messages
    const developerPrompt = messages.find((m) => "role" in m && m.role === "developer");
    const compacted: ResponseInputItem[] = [];

    if (developerPrompt) {
      compacted.push(developerPrompt);
    }

    compacted.push({
      role: "user",
      content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
    });

    compacted.push(...toKeep);
    return compacted;
  } catch {
    // If compaction fails, just truncate older messages
    await onEvent({
      type: "log",
      level: "warning",
      message: "Compaction LLM call failed, falling back to truncation.",
    });

    const developerPrompt = messages.find((m) => "role" in m && m.role === "developer");
    const truncated: ResponseInputItem[] = [];
    if (developerPrompt) truncated.push(developerPrompt);
    truncated.push(...toKeep);
    return truncated;
  }
}

// ---------------------------------------------------------------------------
// Auto-retry — ported from pi-mono agent-session
// ---------------------------------------------------------------------------

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overloaded|rate.?limit|529|503|502|too many requests/i.test(message);
}

async function retryDelay(attempt: number): Promise<void> {
  const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// ---------------------------------------------------------------------------
// Tool definitions for OpenAI function calling
// ---------------------------------------------------------------------------

function buildToolDefinitions(tools: CliTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    strict: true,
    parameters: tool.parameters,
  }));
}

function extractOutputText(response: { output_text?: string; output?: unknown[] }): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object" || !("type" in item) || item.type !== "message") return [];
      const content = "content" in item && Array.isArray(item.content) ? item.content : [];
      return content
        .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean);
    })
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

export async function drivePiAgent(context: DrivePiAgentContext): Promise<{ summary: string }> {
  const maxTurns = context.maxTurns ?? 30;
  const cwd = context.artifactDir;
  const tools = createCliTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = buildToolDefinitions(tools);
  const toolNames = tools.map((t) => t.name);

  // Load project context files
  const contextFiles = await loadProjectContext(cwd);
  if (contextFiles.length > 0) {
    await context.onEvent({
      type: "log",
      level: "info",
      message: `Loaded ${contextFiles.length} project context file(s).`,
      payload: { files: contextFiles.map((f) => f.path) },
    });
  }

  // Build structured system prompt (ported from pi-mono)
  const systemPrompt = buildSystemPrompt(
    cwd,
    toolNames,
    contextFiles,
    context.skills,
    context.capabilityBrief,
  );

  await context.onEvent({
    type: "status",
    level: "info",
    message: "CLI agent started.",
  });

  // Track all messages for compaction
  let allInput: ResponseInputItem[] = [
    { role: "developer", content: systemPrompt },
    { role: "user", content: context.instruction },
  ];

  let response = await callWithRetry(context, () =>
    context.client.createResponse({
      model: context.model,
      tools: toolDefs,
      input: allInput,
    }),
  );

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (context.shouldStop()) {
      throw new Error("CLI agent stopped by operator.");
    }

    const output = Array.isArray(response.output) ? response.output : [];
    const functionCalls = output.filter((item) => item.type === "function_call");
    const outputText = extractOutputText(response);

    if (outputText) {
      await context.onEvent({
        type: "message",
        level: "info",
        message: "Assistant message",
        payload: { text: outputText },
      });
    }

    if (functionCalls.length === 0) {
      return {
        summary: outputText || "CLI agent completed without additional output.",
      };
    }

    const nextInput: ResponseInputItem[] = [];

    for (const call of functionCalls) {
      const tool = toolMap.get(call.name);
      if (!tool) {
        await context.onEvent({
          type: "error",
          level: "error",
          message: `Unknown tool: ${call.name}`,
        });
        nextInput.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        });
        continue;
      }

      const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};

      await context.onEvent({
        type: "tool_call",
        level: "info",
        message: `Function call: ${call.name}`,
        payload: { name: call.name, arguments: args },
      });

      let resultText: string;
      try {
        resultText = await tool.execute(args, cwd);
      } catch (error) {
        resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }

      await context.onEvent({
        type: "tool_result",
        level: "info",
        message: `Function result: ${call.name}`,
        payload: { output: resultText.slice(0, 2000) },
      });

      nextInput.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: resultText,
      });
    }

    // Track messages for compaction
    allInput.push(...nextInput);

    // Auto-compaction check
    if (shouldCompact(allInput)) {
      allInput = await compactMessages(allInput, context.client, context.model, context.onEvent);
    }

    response = await callWithRetry(context, () =>
      context.client.createResponse({
        model: context.model,
        previous_response_id: response.id,
        tools: toolDefs,
        input: nextInput,
      }),
    );
  }

  throw new Error(`CLI agent loop exceeded ${maxTurns} turns.`);
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

async function callWithRetry<T>(
  context: DrivePiAgentContext,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= MAX_RETRY_ATTEMPTS) {
        throw error;
      }
      await context.onEvent({
        type: "log",
        level: "warning",
        message: `LLM call failed (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS + 1}), retrying...`,
        payload: { error: error instanceof Error ? error.message : String(error), attempt },
      });
      await retryDelay(attempt);
    }
  }
  throw lastError;
}

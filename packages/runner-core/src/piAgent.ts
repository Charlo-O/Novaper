import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { DesktopAgentEvent } from "./desktopAgent.js";
import type { ResponsesClient } from "./responsesClient.js";

export interface DrivePiAgentContext {
  instruction: string;
  client: ResponsesClient;
  model: string;
  artifactDir: string;
  onEvent: (event: DesktopAgentEvent) => Promise<void>;
  shouldStop: () => boolean;
  maxTurns?: number;
}

const CLI_SYSTEM_PROMPT = [
  "You are a CLI coding agent running on a Windows machine.",
  "You help users by executing shell commands, reading/writing files, and performing file system operations.",
  "Use the provided tools to complete the user's request. Work step by step.",
  "When you are done, provide a brief summary of what you did.",
  "If a command fails, analyze the error and try an alternative approach.",
  "Do not attempt GUI operations - you only have CLI tools available.",
].join("\n");

const CLI_TOOLS = [
  {
    type: "function" as const,
    name: "execute_command",
    description: "Execute a shell command and return its output. Use this for running CLI commands, scripts, git operations, etc.",
    strict: true,
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "The shell command to execute." },
        cwd: { type: "string" as const, description: "Working directory for the command. Defaults to the artifact directory." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "read_file",
    description: "Read the contents of a file at the given path.",
    strict: true,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Absolute or relative file path to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    strict: true,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Absolute or relative file path to write." },
        content: { type: "string" as const, description: "The content to write to the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "list_directory",
    description: "List files and directories at the given path.",
    strict: true,
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Directory path to list. Defaults to working directory." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function execCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: error ? (error as { code?: number }).code ?? 1 : 0,
      });
    });
  });
}

async function executeTool(name: string, args: Record<string, unknown>, cwd: string): Promise<unknown> {
  switch (name) {
    case "execute_command": {
      const command = String(args.command ?? "");
      const workDir = args.cwd ? resolvePath(String(args.cwd), cwd) : cwd;
      const result = await execCommand(command, workDir);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 10_000),
        stderr: result.stderr.slice(0, 5_000),
      };
    }
    case "read_file": {
      const filePath = resolvePath(String(args.path ?? ""), cwd);
      const content = await fs.readFile(filePath, "utf8");
      return { content: content.slice(0, 50_000) };
    }
    case "write_file": {
      const filePath = resolvePath(String(args.path ?? ""), cwd);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(args.content ?? ""), "utf8");
      return { success: true, path: filePath };
    }
    case "list_directory": {
      const dirPath = resolvePath(String(args.path ?? "."), cwd);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        })),
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function extractOutputText(response: { output_text?: string; output?: unknown[] }): string {
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

export async function drivePiAgent(context: DrivePiAgentContext): Promise<{ summary: string }> {
  const maxTurns = context.maxTurns ?? 30;
  const cwd = context.artifactDir;

  await context.onEvent({
    type: "status",
    level: "info",
    message: "CLI agent started.",
  });

  const initialInput: ResponseInputItem[] = [
    { role: "developer", content: CLI_SYSTEM_PROMPT },
    { role: "user", content: context.instruction },
  ];

  let response = await context.client.createResponse({
    model: context.model,
    tools: CLI_TOOLS,
    input: initialInput,
  });

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
      const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};

      await context.onEvent({
        type: "tool_call",
        level: "info",
        message: `Function call: ${call.name}`,
        payload: { name: call.name, arguments: args },
      });

      let result: unknown;
      try {
        result = await executeTool(call.name, args, cwd);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }

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

    response = await context.client.createResponse({
      model: context.model,
      previous_response_id: response.id,
      tools: CLI_TOOLS,
      input: nextInput,
    });
  }

  throw new Error(`CLI agent loop exceeded ${maxTurns} turns.`);
}

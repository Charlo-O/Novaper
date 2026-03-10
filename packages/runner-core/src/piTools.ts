/**
 * CLI coding agent tools — ported from pi-mono (github.com/badlogic/pi-mono)
 * packages/coding-agent/src/core/tools/
 *
 * Provides 7 tools: read, bash, edit, write, grep, find, ls
 * Adapted to work without external pi dependencies.
 */

import { exec, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Path utilities (from path-utils.ts)
// ---------------------------------------------------------------------------

function expandPath(filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return homedir() + normalized.slice(1);
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(cwd, expanded);
}

function resolveReadPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
}

// ---------------------------------------------------------------------------
// Truncation utilities (from truncate.ts)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
}

function truncateHead(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes, firstLineExceedsLimit: false };
  }

  const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
  if (firstLineBytes > maxBytes) {
    return { content: "", truncated: true, truncatedBy: "bytes", totalLines, totalBytes, outputLines: 0, outputBytes: 0, firstLineExceedsLimit: true };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) { truncatedBy = "bytes"; break; }
    outputLinesArr.push(lines[i]);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = "lines";
  const outputContent = outputLinesArr.join("\n");
  return { content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes, outputLines: outputLinesArr.length, outputBytes: Buffer.byteLength(outputContent, "utf-8"), firstLineExceedsLimit: false };
}

function truncateTail(content: string, maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes, firstLineExceedsLimit: false };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) { truncatedBy = "bytes"; break; }
    outputLinesArr.unshift(lines[i]);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = "lines";
  const outputContent = outputLinesArr.join("\n");
  return { content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes, outputLines: outputLinesArr.length, outputBytes: Buffer.byteLength(outputContent, "utf-8"), firstLineExceedsLimit: false };
}

// ---------------------------------------------------------------------------
// Edit diff utilities (from edit-diff.ts)
// ---------------------------------------------------------------------------

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function fuzzyFindText(content: string, oldText: string): { found: boolean; index: number; matchLength: number; contentForReplacement: string } {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) return { found: true, index: exactIndex, matchLength: oldText.length, contentForReplacement: content };

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) return { found: false, index: -1, matchLength: 0, contentForReplacement: content };

  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, contentForReplacement: fuzzyContent };
}

// ---------------------------------------------------------------------------
// Tool interface — compatible with OpenAI function calling
// ---------------------------------------------------------------------------

export interface CliTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// 1. read — Read file contents
// ---------------------------------------------------------------------------

function createReadTool(): CliTool {
  return {
    name: "read",
    description: `Read the contents of a file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const filePath = resolveReadPath(String(args.path ?? ""), cwd);
      await fs.access(filePath, constants.R_OK);
      const content = await fs.readFile(filePath, "utf-8");
      const allLines = content.split("\n");
      const totalFileLines = allLines.length;
      const startLine = args.offset ? Math.max(0, Number(args.offset) - 1) : 0;
      if (startLine >= allLines.length) throw new Error(`Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`);

      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (args.limit !== undefined) {
        const endLine = Math.min(startLine + Number(args.limit), allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      const startLineDisplay = startLine + 1;

      if (truncation.firstLineExceedsLimit) {
        return `[Line ${startLineDisplay} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
      }
      if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        return `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
      }
      if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      }
      return truncation.content;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. bash — Execute shell commands
// ---------------------------------------------------------------------------

function createBashTool(): CliTool {
  return {
    name: "bash",
    description: `Execute a shell command. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Optionally provide a timeout in seconds.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const command = String(args.command ?? "");
      const timeout = args.timeout ? Number(args.timeout) * 1000 : 120_000;
      return new Promise<string>((resolve, reject) => {
        const child = spawn(command, {
          cwd,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
        });

        const chunks: Buffer[] = [];

        child.stdout?.on("data", (data: Buffer) => chunks.push(data));
        child.stderr?.on("data", (data: Buffer) => chunks.push(data));

        child.on("error", (err) => reject(err));
        child.on("close", (code) => {
          const fullOutput = Buffer.concat(chunks).toString("utf-8");
          const truncation = truncateTail(fullOutput);
          let output = truncation.content || "(no output)";

          if (truncation.truncated) {
            const startLine = truncation.totalLines - truncation.outputLines + 1;
            output += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}.]`;
          }

          if (code !== 0 && code !== null) {
            output += `\n\nCommand exited with code ${code}`;
          }
          resolve(output);
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 3. edit — Replace text in files with fuzzy matching
// ---------------------------------------------------------------------------

function createEditTool(): CliTool {
  return {
    name: "edit",
    description: "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        oldText: { type: "string", description: "Exact text to find and replace (must match exactly)" },
        newText: { type: "string", description: "New text to replace the old text with" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const filePath = resolveToCwd(String(args.path ?? ""), cwd);
      await fs.access(filePath, constants.R_OK | constants.W_OK);

      const rawContent = await fs.readFile(filePath, "utf-8");
      const { bom, text: content } = stripBom(rawContent);
      const normalizedContent = normalizeToLF(content);
      const normalizedOldText = normalizeToLF(String(args.oldText ?? ""));
      const normalizedNewText = normalizeToLF(String(args.newText ?? ""));

      const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
      if (!matchResult.found) {
        throw new Error(`Could not find the exact text in ${args.path}. The old text must match exactly including all whitespace and newlines.`);
      }

      // Check for multiple occurrences
      const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
      const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
      const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
      if (occurrences > 1) {
        throw new Error(`Found ${occurrences} occurrences of the text in ${args.path}. Please provide more context to make it unique.`);
      }

      const baseContent = matchResult.contentForReplacement;
      const newContent = baseContent.substring(0, matchResult.index) + normalizedNewText + baseContent.substring(matchResult.index + matchResult.matchLength);

      if (baseContent === newContent) {
        throw new Error(`No changes made to ${args.path}. The replacement produced identical content.`);
      }

      // Detect original line endings and restore
      const originalEnding = rawContent.includes("\r\n") ? "\r\n" : "\n";
      const finalContent = bom + (originalEnding === "\r\n" ? newContent.replace(/\n/g, "\r\n") : newContent);
      await fs.writeFile(filePath, finalContent, "utf-8");

      return `Successfully replaced text in ${args.path}.`;
    },
  };
}

// ---------------------------------------------------------------------------
// 4. write — Write content to files
// ---------------------------------------------------------------------------

function createWriteTool(): CliTool {
  return {
    name: "write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const filePath = resolveToCwd(String(args.path ?? ""), cwd);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const content = String(args.content ?? "");
      await fs.writeFile(filePath, content, "utf-8");
      return `Successfully wrote ${content.length} bytes to ${args.path}`;
    },
  };
}

// ---------------------------------------------------------------------------
// 5. grep — Search file contents
// ---------------------------------------------------------------------------

function createGrepTool(): CliTool {
  return {
    name: "grep",
    description: "Search file contents for a pattern using regex or literal string. Returns matching lines with file paths and line numbers. Respects .gitignore.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: { type: "string", description: "Directory or file to search (default: current directory)" },
        glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
        literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
        limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const pattern = String(args.pattern ?? "");
      const searchPath = resolveToCwd(String(args.path ?? "."), cwd);
      const limit = Number(args.limit ?? 100);

      // Try ripgrep first, fall back to findstr/grep
      const rgArgs = ["--line-number", "--color=never", "--hidden", "--max-count", String(limit)];
      if (args.ignoreCase) rgArgs.push("--ignore-case");
      if (args.literal) rgArgs.push("--fixed-strings");
      if (args.glob) rgArgs.push("--glob", String(args.glob));
      rgArgs.push(pattern, searchPath);

      // Try rg, then grep, then findstr
      for (const cmd of ["rg", "grep -rn"]) {
        try {
          const result = await execPromise(
            cmd === "rg" ? `rg ${rgArgs.map(shellEscape).join(" ")}` : `grep -rn ${args.ignoreCase ? "-i" : ""} ${shellEscape(pattern)} ${shellEscape(searchPath)}`,
            cwd,
          );
          const output = result.stdout.trim();
          if (!output) return "No matches found";
          const truncation = truncateHead(output);
          if (truncation.truncated) {
            return `${truncation.content}\n\n[Output truncated. ${truncation.totalLines} total lines.]`;
          }
          return truncation.content;
        } catch (error: unknown) {
          const err = error as { stdout?: string; exitCode?: number };
          if (err.exitCode === 1) return "No matches found";
          // Try next command
          continue;
        }
      }

      // Fallback: simple Node.js grep
      return nodeGrep(pattern, searchPath, Boolean(args.ignoreCase), limit);
    },
  };
}

// ---------------------------------------------------------------------------
// 6. find — Search for files by pattern
// ---------------------------------------------------------------------------

function createFindTool(): CliTool {
  return {
    name: "find",
    description: "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files, e.g. '*.ts', '**/*.json'" },
        path: { type: "string", description: "Directory to search in (default: current directory)" },
        limit: { type: "number", description: "Maximum number of results (default: 1000)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const pattern = String(args.pattern ?? "");
      const searchPath = resolveToCwd(String(args.path ?? "."), cwd);
      const limit = Number(args.limit ?? 1000);

      // Try fd first, then fall back to dir/find
      for (const strategy of ["fd", "shell", "node"]) {
        try {
          if (strategy === "fd") {
            const result = await execPromise(`fd --glob --color=never --hidden --max-results ${limit} ${shellEscape(pattern)} ${shellEscape(searchPath)}`, cwd);
            return formatFindResults(result.stdout, searchPath, limit);
          }
          if (strategy === "shell") {
            // Windows: dir, Unix: find
            const isWin = process.platform === "win32";
            const cmd = isWin
              ? `dir /s /b ${shellEscape(searchPath + "\\" + pattern)} 2>nul`
              : `find ${shellEscape(searchPath)} -name ${shellEscape(pattern)} -maxdepth 10 2>/dev/null | head -${limit}`;
            const result = await execPromise(cmd, cwd);
            return formatFindResults(result.stdout, searchPath, limit);
          }
        } catch {
          continue;
        }
      }

      // Node.js fallback
      return nodeFindFiles(searchPath, pattern, limit);
    },
  };
}

// ---------------------------------------------------------------------------
// 7. ls — List directory contents
// ---------------------------------------------------------------------------

function createLsTool(): CliTool {
  return {
    name: "ls",
    description: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: current directory)" },
        limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, cwd) {
      const dirPath = resolveToCwd(String(args.path ?? "."), cwd);
      const limit = Number(args.limit ?? 500);

      if (!existsSync(dirPath)) throw new Error(`Path not found: ${dirPath}`);
      const stat = statSync(dirPath);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

      const entries = readdirSync(dirPath);
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const results: string[] = [];
      for (const entry of entries) {
        if (results.length >= limit) break;
        const fullPath = path.join(dirPath, entry);
        try {
          const entryStat = statSync(fullPath);
          results.push(entryStat.isDirectory() ? `${entry}/` : entry);
        } catch {
          continue;
        }
      }

      if (results.length === 0) return "(empty directory)";
      let output = results.join("\n");
      if (results.length >= limit) {
        output += `\n\n[${limit} entries limit reached.]`;
      }
      return output;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  if (process.platform === "win32") {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function execPromise(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (error as unknown as { code?: number }).code ?? 1 : 0;
      if (exitCode !== 0 && !stdout) {
        reject({ stdout: String(stdout), stderr: String(stderr), exitCode });
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      }
    });
  });
}

function formatFindResults(stdout: string, searchPath: string, limit: number): string {
  const output = stdout.trim();
  if (!output) return "No files found matching pattern";

  const lines = output.split("\n").filter((l) => l.trim());
  const relativized = lines.map((line) => {
    const clean = line.replace(/\r$/, "").trim();
    if (clean.startsWith(searchPath)) return clean.slice(searchPath.length + 1);
    return path.relative(searchPath, clean);
  });

  const truncation = truncateHead(relativized.join("\n"));
  let result = truncation.content;
  if (relativized.length >= limit) {
    result += `\n\n[${limit} results limit reached.]`;
  }
  if (truncation.truncated) {
    result += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)}.]`;
  }
  return result;
}

async function nodeGrep(pattern: string, searchPath: string, ignoreCase: boolean, limit: number): Promise<string> {
  const results: string[] = [];
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");

  async function searchDir(dir: string) {
    if (results.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await searchDir(fullPath);
      } else {
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && results.length < limit; i++) {
            if (regex.test(lines[i])) {
              const rel = path.relative(searchPath, fullPath);
              results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 500)}`);
            }
          }
        } catch { /* skip binary/unreadable */ }
      }
    }
  }

  const stat = statSync(searchPath);
  if (stat.isFile()) {
    try {
      const content = await fs.readFile(searchPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (regex.test(lines[i])) {
          results.push(`${path.basename(searchPath)}:${i + 1}: ${lines[i].slice(0, 500)}`);
        }
      }
    } catch { /* skip */ }
  } else {
    await searchDir(searchPath);
  }

  if (results.length === 0) return "No matches found";
  return results.join("\n");
}

async function nodeFindFiles(searchPath: string, pattern: string, limit: number): Promise<string> {
  const results: string[] = [];
  // Convert glob to simple regex
  const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
  const regex = new RegExp(`^${regexPattern}$`, "i");

  async function searchDir(dir: string) {
    if (results.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await searchDir(fullPath);
      }
      if (regex.test(entry.name)) {
        results.push(path.relative(searchPath, fullPath));
      }
    }
  }

  await searchDir(searchPath);
  if (results.length === 0) return "No files found matching pattern";
  return results.join("\n");
}

// ---------------------------------------------------------------------------
// Export all 7 tools
// ---------------------------------------------------------------------------

export function createCliTools(): CliTool[] {
  return [
    createReadTool(),
    createBashTool(),
    createEditTool(),
    createWriteTool(),
    createGrepTool(),
    createFindTool(),
    createLsTool(),
  ];
}

/** Coding tools (full access) — matches pi-mono's default set */
export function createCodingTools(): CliTool[] {
  return [createReadTool(), createBashTool(), createEditTool(), createWriteTool()];
}

/** Read-only tools — for exploration without modification */
export function createReadOnlyTools(): CliTool[] {
  return [createReadTool(), createGrepTool(), createFindTool(), createLsTool()];
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUILTIN_BROWSER_MCP_SERVER } from "../../runner-core/src/pluginTypes.js";

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

export type ChromeMcpSnapshotNode = {
  id?: string;
  role?: string;
  name?: string;
  value?: string | number | boolean;
  description?: string;
  children?: ChromeMcpSnapshotNode[];
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
};

const DEFAULT_CHROME_MCP_COMMAND = BUILTIN_BROWSER_MCP_SERVER.command ?? "npx";
const DEFAULT_CHROME_MCP_ARGS = [...(BUILTIN_BROWSER_MCP_SERVER.args ?? [])];

const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, Promise<ChromeMcpSession>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeUserDataDir(userDataDir?: string) {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function buildCacheKey(profileName: string, userDataDir?: string) {
  return JSON.stringify([profileName, normalizeUserDataDir(userDataDir) ?? ""]);
}

function cacheKeyMatchesProfileName(cacheKey: string, profileName: string) {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

function extractStructuredContent(result: ChromeMcpToolResult) {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractMessageText(result: ChromeMcpToolResult) {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  return extractTextContent(result).find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string) {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages = extractStructuredContent(result).pages;
  if (!Array.isArray(pages)) {
    return [];
  }

  const parsed: ChromeMcpStructuredPage[] = [];
  for (const entry of pages) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }

    parsed.push({
      id: record.id,
      url: typeof record.url === "string" ? record.url : undefined,
      selected: record.selected === true,
    });
  }

  return parsed;
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const snapshot = asRecord(extractStructuredContent(result).snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as ChromeMcpSnapshotNode;
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const message = extractMessageText(result).trim();
  if (!message) {
    return null;
  }

  const fencedMatch = message.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? message;
  return candidate ? JSON.parse(candidate) : null;
}

function parsePageId(pageId: number | string) {
  const parsed =
    typeof pageId === "number" ? pageId : Number.parseInt(String(pageId).trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Chrome MCP page id: ${String(pageId)}`);
  }
  return parsed;
}

function buildChromeMcpArgs(userDataDir?: string): string[] {
  const normalized = normalizeUserDataDir(userDataDir);
  return normalized
    ? [...DEFAULT_CHROME_MCP_ARGS, "--userDataDir", normalized]
    : [...DEFAULT_CHROME_MCP_ARGS];
}

async function createSession(profileName: string, userDataDir?: string): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: DEFAULT_CHROME_MCP_COMMAND,
    args: buildChromeMcpArgs(userDataDir),
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "novaper-browser",
      version: "0.0.0",
    },
    {},
  );

  const ready = (async () => {
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "list_pages")) {
        throw new Error("Chrome MCP server did not expose the expected page tools.");
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      const targetLabel = userDataDir
        ? `the configured Chromium user data dir (${userDataDir})`
        : "Google Chrome's default profile";
      throw new Error(
        `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
          `Make sure ${targetLabel} is running locally with remote debugging enabled. ` +
          `Details: ${String(error)}`,
      );
    }
  })();

  return {
    client,
    transport,
    ready,
  };
}

async function getSession(profileName: string, userDataDir?: string): Promise<ChromeMcpSession> {
  const cacheKey = buildCacheKey(profileName, userDataDir);

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }

  if (!session) {
    let pending = pendingSessions.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const created = await createSession(profileName, userDataDir);
        if (pendingSessions.get(cacheKey) === pending) {
          sessions.set(cacheKey, created);
        } else {
          await created.client.close().catch(() => undefined);
        }
        return created;
      })();
      pendingSessions.set(cacheKey, pending);
    }

    try {
      session = await pending;
    } finally {
      if (pendingSessions.get(cacheKey) === pending) {
        pendingSessions.delete(cacheKey);
      }
    }
  }

  await session.ready;
  return session;
}

async function callTool(
  profileName: string,
  userDataDir: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ChromeMcpToolResult> {
  const session = await getSession(profileName, userDataDir);
  const cacheKey = buildCacheKey(profileName, userDataDir);

  let result: ChromeMcpToolResult;
  try {
    result = (await session.client.callTool({
      name,
      arguments: args,
    })) as ChromeMcpToolResult;
  } catch (error) {
    sessions.delete(cacheKey);
    await session.client.close().catch(() => undefined);
    throw error;
  }

  if (result.isError) {
    throw new Error(extractToolErrorMessage(result, name));
  }

  return result;
}

export async function ensureChromeMcpAvailable(profileName: string, userDataDir?: string) {
  await getSession(profileName, userDataDir);
}

export async function closeChromeMcpSession(profileName: string) {
  let closed = false;

  for (const key of Array.from(pendingSessions.keys())) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      pendingSessions.delete(key);
      closed = true;
    }
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (!cacheKeyMatchesProfileName(key, profileName)) {
      continue;
    }

    sessions.delete(key);
    closed = true;
    await session.client.close().catch(() => undefined);
  }

  return closed;
}

export async function listChromeMcpPages(profileName: string, userDataDir?: string) {
  const result = await callTool(profileName, userDataDir, "list_pages");
  return extractStructuredPages(result);
}

export async function newChromeMcpPage(profileName: string, url: string, userDataDir?: string) {
  const result = await callTool(profileName, userDataDir, "new_page", { url });
  const pages = extractStructuredPages(result);
  const selected = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!selected) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  return selected;
}

export async function selectChromeMcpPage(
  profileName: string,
  pageId: number | string,
  userDataDir?: string,
) {
  await callTool(profileName, userDataDir, "select_page", {
    pageId: parsePageId(pageId),
    bringToFront: true,
  });
}

export async function closeChromeMcpPage(
  profileName: string,
  pageId: number | string,
  userDataDir?: string,
) {
  await callTool(profileName, userDataDir, "close_page", {
    pageId: parsePageId(pageId),
  });
}

export async function navigateChromeMcpPage(params: {
  profileName: string;
  pageId: number | string;
  url: string;
  userDataDir?: string;
  timeoutMs?: number;
}) {
  await callTool(params.profileName, params.userDataDir, "navigate_page", {
    pageId: parsePageId(params.pageId),
    type: "url",
    url: params.url,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
}

export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  pageId: number | string;
  userDataDir?: string;
}) {
  const result = await callTool(params.profileName, params.userDataDir, "take_snapshot", {
    pageId: parsePageId(params.pageId),
  });
  return extractSnapshot(result);
}

export async function clickChromeMcpElement(params: {
  profileName: string;
  pageId: number | string;
  uid: string;
  userDataDir?: string;
  doubleClick?: boolean;
}) {
  await callTool(params.profileName, params.userDataDir, "click", {
    pageId: parsePageId(params.pageId),
    uid: params.uid,
    ...(params.doubleClick ? { dblClick: true } : {}),
  });
}

export async function fillChromeMcpElement(params: {
  profileName: string;
  pageId: number | string;
  uid: string;
  value: string;
  userDataDir?: string;
}) {
  await callTool(params.profileName, params.userDataDir, "fill", {
    pageId: parsePageId(params.pageId),
    uid: params.uid,
    value: params.value,
  });
}

export async function pressChromeMcpKey(params: {
  profileName: string;
  pageId: number | string;
  key: string;
  userDataDir?: string;
}) {
  await callTool(params.profileName, params.userDataDir, "press_key", {
    pageId: parsePageId(params.pageId),
    key: params.key,
  });
}

export async function evaluateChromeMcpScript(params: {
  profileName: string;
  pageId: number | string;
  fn: string;
  userDataDir?: string;
  args?: string[];
}) {
  const result = await callTool(params.profileName, params.userDataDir, "evaluate_script", {
    pageId: parsePageId(params.pageId),
    function: params.fn,
    ...(params.args?.length ? { args: params.args } : {}),
  });
  return extractJsonMessage(result);
}

export async function waitForChromeMcpText(params: {
  profileName: string;
  pageId: number | string;
  text: string[];
  userDataDir?: string;
  timeoutMs?: number;
}) {
  await callTool(params.profileName, params.userDataDir, "wait_for", {
    pageId: parsePageId(params.pageId),
    text: params.text,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
}

import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import type { ComputerAction } from "../../desktop-runtime/src/types.js";
import type { BrowserSessionManager } from "../../browser-runtime/src/browserSessionManager.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

function normalizeDesktopActions(value: unknown): ComputerAction[] {
  if (!Array.isArray(value)) {
    throw new Error("desktop_actions requires an actions array.");
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each desktop action must be an object.");
    }

    const action = entry as Record<string, unknown>;
    const type = String(action.type ?? "");
    switch (type) {
      case "click":
      case "double_click":
      case "move":
        return {
          type,
          x: Number(action.x),
          y: Number(action.y),
          button: action.button === "right" ? "right" : "left",
        } as ComputerAction;
      case "scroll":
        return {
          type,
          x: typeof action.x === "number" ? action.x : undefined,
          y: typeof action.y === "number" ? action.y : undefined,
          scroll_x: typeof action.scroll_x === "number" ? action.scroll_x : undefined,
          scroll_y: typeof action.scroll_y === "number" ? action.scroll_y : undefined,
        } as ComputerAction;
      case "type":
        return {
          type,
          text: String(action.text ?? ""),
        } as ComputerAction;
      case "keypress":
        return {
          type,
          keys: Array.isArray(action.keys) ? action.keys.map((item) => String(item)) : [],
        } as ComputerAction;
      case "wait":
        return {
          type,
          duration_ms: typeof action.duration_ms === "number" ? action.duration_ms : undefined,
        } as ComputerAction;
      case "drag":
        if (!Array.isArray(action.path)) {
          throw new Error("Drag action requires a path array.");
        }
        return {
          type,
          path: action.path.map((point) => {
            if (!point || typeof point !== "object") {
              throw new Error("Each drag path point must be an object.");
            }
            const record = point as Record<string, unknown>;
            return {
              x: Number(record.x),
              y: Number(record.y),
            };
          }),
        } as ComputerAction;
      case "screenshot":
        return { type } as ComputerAction;
      default:
        throw new Error(`Unsupported desktop action type: ${type}`);
    }
  });
}

const MAX_TOOL_RESPONSE_LENGTH = 5000;

/** Truncate tool response to prevent context overflow */
function truncateResult(result: unknown): unknown {
  const str = JSON.stringify(result);
  if (str.length <= MAX_TOOL_RESPONSE_LENGTH) return result;
  return {
    _truncated: true,
    _originalLength: str.length,
    data: str.slice(0, MAX_TOOL_RESPONSE_LENGTH) + "... (truncated)",
  };
}

export function createToolRegistry(
  sidecar: DesktopSidecar,
  options?: {
    browserSessionManager?: BrowserSessionManager;
    browserSessionId?: string;
  },
): ToolDefinition[] {
  const browserTools: ToolDefinition[] = [];
  if (options?.browserSessionManager && options.browserSessionId) {
    const browserSessionManager = options.browserSessionManager;
    const browserSessionId = options.browserSessionId;

    browserTools.push(
      {
        name: "browser_open",
        description: "Open or reuse a managed Chromium browser session for this operator. Uses Playwright with a persisted automation profile. If the result reports requiresDesktopActions=true, switch to desktop_actions.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string" },
            newTab: { type: "boolean" },
          },
        },
        execute: async (args) =>
          browserSessionManager.open(browserSessionId, {
            url: typeof args.url === "string" ? args.url : undefined,
            newTab: args.newTab === true,
          }),
      },
      {
        name: "browser_tabs",
        description: "List, open, switch, or close browser tabs in the managed Chromium session.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: ["list", "switch", "new", "close"],
            },
            index: { type: "number" },
            url: { type: "string" },
          },
        },
        execute: async (args) =>
          browserSessionManager.tabs(browserSessionId, {
            action: String(args.action) as "list" | "switch" | "new" | "close",
            index: typeof args.index === "number" ? args.index : undefined,
            url: typeof args.url === "string" ? args.url : undefined,
          }),
      },
      {
        name: "browser_navigate",
        description: "Navigate the active browser tab to a URL.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string" },
          },
        },
        execute: async (args) => browserSessionManager.navigate(browserSessionId, { url: String(args.url) }),
      },
      {
        name: "browser_snapshot",
        description: "Inspect the active page using DOM data. Returns tabs, page metadata, actionable elements, and an optional text preview. If the result falls back to visual mode, continue with desktop_actions.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxElements: { type: "number" },
            includeText: { type: "boolean" },
            textLimit: { type: "number" },
          },
        },
        execute: async (args) =>
          truncateResult(
            await browserSessionManager.snapshot(browserSessionId, {
              maxElements: typeof args.maxElements === "number" ? args.maxElements : undefined,
              includeText: args.includeText !== false,
              textLimit: typeof args.textLimit === "number" ? args.textLimit : undefined,
            }),
          ),
      },
      {
        name: "browser_click",
        description: "Click an element in the active page by CSS selector, visible text, or page coordinates. If visual fallback is active, stop using browser selectors and continue with desktop_actions.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
            index: { type: "number" },
            button: { type: "string", enum: ["left", "right"] },
            x: { type: "number" },
            y: { type: "number" },
          },
        },
        execute: async (args) =>
          browserSessionManager.click(browserSessionId, {
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            index: typeof args.index === "number" ? args.index : undefined,
            button: args.button === "right" ? "right" : "left",
            x: typeof args.x === "number" ? args.x : undefined,
            y: typeof args.y === "number" ? args.y : undefined,
          }),
      },
      {
        name: "browser_type",
        description: "Type into the active page by selector or current focus. Use clear=true for replacing existing text.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
            clear: { type: "boolean" },
            submit: { type: "boolean" },
          },
        },
        execute: async (args) =>
          browserSessionManager.type(browserSessionId, {
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: String(args.text ?? ""),
            clear: args.clear === true,
            submit: args.submit === true,
          }),
      },
      {
        name: "browser_press_keys",
        description: "Send keyboard shortcuts to the active browser tab, for example Ctrl+L or Ctrl+Enter.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["keys"],
          properties: {
            keys: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        execute: async (args) =>
          browserSessionManager.pressKeys(browserSessionId, {
            keys: Array.isArray(args.keys) ? args.keys.map((key) => String(key)) : [],
          }),
      },
      {
        name: "browser_wait_for",
        description: "Wait for a selector, page text, or a fixed timeout in the active browser tab.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
            timeoutMs: { type: "number" },
          },
        },
        execute: async (args) =>
          browserSessionManager.waitFor(browserSessionId, {
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          }),
      },
      {
        name: "browser_scroll",
        description: "Scroll the active browser tab by pixel offsets.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
        },
        execute: async (args) =>
          browserSessionManager.scroll(browserSessionId, {
            x: typeof args.x === "number" ? args.x : undefined,
            y: typeof args.y === "number" ? args.y : undefined,
          }),
      },
      {
        name: "browser_read",
        description: "Read visible text from the page or a specific selector in the active browser tab.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            selector: { type: "string" },
            maxLength: { type: "number" },
          },
        },
        execute: async (args) =>
          truncateResult(
            await browserSessionManager.read(browserSessionId, {
              selector: typeof args.selector === "string" ? args.selector : undefined,
              maxLength: typeof args.maxLength === "number" ? args.maxLength : undefined,
            }),
          ),
      },
    );
  }

  return [
    ...browserTools,
    {
      name: "list_windows",
      description: "List visible top-level windows and identify the current foreground window. Use this before interacting with desktop apps.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: async () => sidecar.listWindows(),
    },
    {
      name: "focus_window",
      description: "Bring an existing window to the foreground by handle or partial title. Prefer this over blind clicks.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          handle: { type: "string" },
          titleContains: { type: "string" },
        },
      },
      execute: async (args) => sidecar.focusWindow({ handle: args.handle as string | undefined, titleContains: args.titleContains as string | undefined }),
    },
    {
      name: "launch_process",
      description: "Launch a desktop executable or shell command on the Windows machine.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
      },
      execute: async (args) =>
        sidecar.launchProcess({
          command: String(args.command),
          args: Array.isArray(args.args) ? (args.args as string[]) : undefined,
          cwd: args.cwd as string | undefined,
        }),
    },
    {
      name: "kill_process",
      description: "Terminate a process by pid or process name.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pid: { type: "number" },
          processName: { type: "string" },
        },
      },
      execute: async (args) =>
        sidecar.killProcess({
          pid: typeof args.pid === "number" ? args.pid : undefined,
          processName: args.processName as string | undefined,
        }),
    },
    {
      name: "desktop_actions",
      description:
        "Execute low-level visual desktop actions by screen coordinates or keyboard input. Use this when you must click, move, scroll, drag, type, press keys, wait, or request a new screenshot based on the attached desktop image.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["actions"],
        properties: {
          actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: ["click", "double_click", "drag", "move", "scroll", "type", "keypress", "wait", "screenshot"],
                },
                x: { type: "number" },
                y: { type: "number" },
                button: { type: "string", enum: ["left", "right"] },
                text: { type: "string" },
                keys: { type: "array", items: { type: "string" } },
                duration_ms: { type: "number" },
                scroll_x: { type: "number" },
                scroll_y: { type: "number" },
                path: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      execute: async (args) => {
        const result = await sidecar.execActions({ actions: normalizeDesktopActions(args.actions) });
        return {
          actions: result.actions,
          screenshot: {
            width: result.screenshot.width,
            height: result.screenshot.height,
          },
        };
      },
    },
    {
      name: "uia_find",
      description: "Find accessible UI Automation elements in a Windows app. Prefer this over vision clicks whenever possible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector"],
        properties: {
          selector: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              automationId: { type: "string" },
              className: { type: "string" },
              controlType: { type: "string" },
              processId: { type: "number" },
              processName: { type: "string" },
              windowTitleContains: { type: "string" },
              scope: { type: "string", enum: ["children", "descendants"] },
              maxResults: { type: "number" },
            },
          },
        },
      },
      execute: async (args) => sidecar.uiaFind({ selector: args.selector as never }),
    },
    {
      name: "uia_invoke",
      description: "Invoke or click the first matching accessible UI element.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector"],
        properties: {
          selector: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              automationId: { type: "string" },
              className: { type: "string" },
              controlType: { type: "string" },
              processId: { type: "number" },
              processName: { type: "string" },
              windowTitleContains: { type: "string" },
              scope: { type: "string", enum: ["children", "descendants"] },
            },
          },
        },
      },
      execute: async (args) => sidecar.uiaInvoke({ selector: args.selector as never }),
    },
    {
      name: "uia_set_value",
      description: "Set text into the first matching accessible edit field. Prefer this over simulated typing for forms.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["selector", "value"],
        properties: {
          selector: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              automationId: { type: "string" },
              className: { type: "string" },
              controlType: { type: "string" },
              processId: { type: "number" },
              processName: { type: "string" },
              windowTitleContains: { type: "string" },
              scope: { type: "string", enum: ["children", "descendants"] },
            },
          },
          value: { type: "string" },
        },
      },
      execute: async (args) => sidecar.uiaSetValue({ selector: args.selector as never, value: String(args.value) }),
    },
    {
      name: "check_file",
      description: "Check whether a file exists and optionally read its UTF-8 text content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          readText: { type: "boolean" },
        },
      },
      execute: async (args) => sidecar.checkFile({ path: String(args.path), readText: Boolean(args.readText) }),
    },
    {
      name: "move_file",
      description: "Move a file or directory to a destination path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "destination"],
        properties: {
          path: { type: "string" },
          destination: { type: "string" },
        },
      },
      execute: async (args) => sidecar.moveFile({ path: String(args.path), destination: String(args.destination) }),
    },
    {
      name: "rename_file",
      description: "Rename a file while keeping it in the same directory.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "newName"],
        properties: {
          path: { type: "string" },
          newName: { type: "string" },
        },
      },
      execute: async (args) => sidecar.renameFile({ path: String(args.path), newName: String(args.newName) }),
    },
    {
      name: "detect_elements",
      description:
        "Detect structured UI elements on the current screen using UI Automation. Returns clickable elements and text elements for structured interaction planning.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          include_text: {
            type: "boolean",
            description: "Include text/label elements (default true)",
          },
          include_clickable: {
            type: "boolean",
            description: "Include clickable elements like buttons, links (default true)",
          },
          processName: {
            type: "string",
            description: "Filter to a specific process name",
          },
          windowTitleContains: {
            type: "string",
            description: "Filter to windows matching this title substring",
          },
        },
      },
      execute: async (args) => {
        const includeText = args.include_text !== false;
        const includeClickable = args.include_clickable !== false;
        const controlTypes: string[] = [];
        if (includeClickable) controlTypes.push("Button", "Hyperlink", "MenuItem", "ListItem", "TabItem", "TreeItem");
        if (includeText) controlTypes.push("Text", "Edit", "Document");

        const results = [];
        for (const ct of controlTypes) {
          try {
            const elements = await sidecar.uiaFind({
              selector: {
                controlType: ct,
                processName: args.processName as string | undefined,
                windowTitleContains: args.windowTitleContains as string | undefined,
                scope: "descendants",
                maxResults: 20,
              },
            });
            results.push(...elements.map((el) => ({ ...el, controlType: ct })));
          } catch {
            // some control types may not exist
          }
        }

        return truncateResult(results);
      },
    },
    {
      name: "google_search",
      description: "Open a Google search in the default browser. Use this when you need to look up information online.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "The search query" },
        },
      },
      execute: async (args) => {
        const query = encodeURIComponent(String(args.query));
        if (options?.browserSessionManager && options.browserSessionId) {
          return options.browserSessionManager.open(options.browserSessionId, {
            url: `https://www.google.com/search?q=${query}`,
          });
        }
        return sidecar.launchProcess({
          command: "cmd",
          args: ["/c", "start", `https://www.google.com/search?q=${query}`],
        });
      },
    },
  ];
}

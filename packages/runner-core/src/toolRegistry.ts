import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import type { ComputerAction } from "../../desktop-runtime/src/types.js";

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

export function createToolRegistry(sidecar: DesktopSidecar): ToolDefinition[] {
  return [
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
  ];
}

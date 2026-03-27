import type { WebContents } from "electron";
import type { WebViewManager } from "./webviewManager.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";
export const DEFAULT_REMOTE_DEBUG_PORT = Number(
  process.env.NOVAPER_REMOTE_DEBUG_PORT ?? 9333
);

type JsonObject = Record<string, unknown>;

interface DebugTargetSummary {
  id: string;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isShow: boolean;
  isActive: boolean;
  debuggerAttached: boolean;
  ownedByBridge: boolean;
}

export class WebViewDebugBridge {
  private nextOwnedTargetId = 1000;
  private readonly ownedTargetIds = new Set<string>();

  constructor(
    private readonly webViewManager: WebViewManager,
    private readonly options: { remoteDebuggingPort?: number } = {}
  ) {}

  public getStatus() {
    const targets = this.listTargets();
    const remoteDebuggingPort = this.getRemoteDebuggingPort();
    return {
      bridgeEnabled: true,
      defaultTargetId: this.getDefaultTargetId(),
      inspectBaseUrl: `http://127.0.0.1:${remoteDebuggingPort}`,
      inspectTargetsUrl: `http://127.0.0.1:${remoteDebuggingPort}/json`,
      remoteDebuggingPort,
      targetCount: targets.length,
      targets,
      transport: "electron-debugger",
    };
  }

  public getTarget(targetId?: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    return this.listTargets().find((target) => target.id === resolvedTargetId) ?? null;
  }

  public listTargets(): DebugTargetSummary[] {
    return this.webViewManager
      .listWebviews()
      .filter(
        (state) =>
          state.isActive ||
          state.isShow ||
          (state.url !== "about:blank?use=0" && state.url !== "about:blank")
      )
      .map((state) => {
        const webContents = this.webViewManager.getWebContents(state.id);
        return {
          ...state,
          debuggerAttached: Boolean(webContents?.debugger.isAttached()),
          ownedByBridge: this.ownedTargetIds.has(state.id),
        };
      });
  }

  public async createTarget(args?: {
    id?: string;
    show?: boolean;
    url?: string;
  }) {
    const targetId = args?.id?.trim() || `debug-${this.nextOwnedTargetId++}`;
    const createResult = await this.webViewManager.createWebview(
      targetId,
      "about:blank?use=0"
    );
    if (
      createResult?.success !== true &&
      !String(createResult?.error ?? "").includes(
        `Webview with id ${targetId} already exists`
      )
    ) {
      throw new Error(
        String(createResult?.error ?? `Failed to create embedded target ${targetId}.`)
      );
    }

    if (args?.url && args.url !== "about:blank") {
      const navigateResult = await this.webViewManager.navigateWebview(
        targetId,
        args.url
      );
      if (navigateResult?.success !== true) {
        throw new Error(String(navigateResult?.error ?? "Navigation failed."));
      }
    }

    if (args?.show) {
      await this.webViewManager.showWebview(targetId);
    } else {
      await this.webViewManager.hideWebview(targetId);
    }

    this.ownedTargetIds.add(targetId);
    return this.getTarget(targetId);
  }

  public async closeTarget(targetId?: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const result = this.webViewManager.destroyWebview(resolvedTargetId);
    if (result?.success !== true) {
      throw new Error(String(result?.error ?? "Failed to close embedded target."));
    }
    this.ownedTargetIds.delete(resolvedTargetId);
    return {
      closed: true,
      targetId: resolvedTargetId,
    };
  }

  public async navigate(targetId: string | undefined, url: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const result = await this.webViewManager.navigateWebview(resolvedTargetId, url);
    if (result?.success !== true) {
      throw new Error(String(result?.error ?? "Navigation failed."));
    }
    return this.getTarget(resolvedTargetId);
  }

  public async back(targetId?: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const result = this.webViewManager.goBackWebview(resolvedTargetId);
    if (result?.success !== true) {
      throw new Error(String(result?.error ?? "Back navigation failed."));
    }
    return this.getTarget(resolvedTargetId);
  }

  public async openDevTools(targetId?: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const webContents = this.requireWebContents(resolvedTargetId);
    webContents.openDevTools({ activate: false, mode: "detach" });
    return {
      opened: true,
      targetId: resolvedTargetId,
    };
  }

  public async getInfo(targetId?: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const webContents = this.requireWebContents(resolvedTargetId);
    const state = this.getTarget(resolvedTargetId);
    const readyState = await webContents
      .executeJavaScript("document.readyState")
      .catch(() => "unknown");

    return {
      ...state,
      readyState,
    };
  }

  public async evaluate(targetId: string | undefined, expression: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const response = await this.sendDebuggerCommand<{
      exceptionDetails?: { text?: string };
      result?: {
        description?: string;
        subtype?: string;
        type?: string;
        value?: unknown;
      };
    }>(resolvedTargetId, "Runtime.evaluate", {
      allowUnsafeEvalBlockedByCSP: true,
      awaitPromise: true,
      expression,
      returnByValue: true,
      userGesture: true,
    });

    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.text || "Embedded browser evaluation failed."
      );
    }

    return {
      description: response.result?.description,
      subtype: response.result?.subtype,
      targetId: resolvedTargetId,
      type: response.result?.type,
      value: response.result?.value,
    };
  }

  public async click(targetId: string | undefined, selector: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const webContents = this.requireWebContents(resolvedTargetId);
    const result = await webContents.executeJavaScript(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) {
          return { error: 'Could not find element for selector: ${selector.replace(/'/g, "\\'")}' };
        }
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return {
          clicked: true,
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || '').trim().slice(0, 120),
        };
      })()
    `);

    if (result?.error) {
      throw new Error(String(result.error));
    }

    return {
      selector,
      targetId: resolvedTargetId,
      ...result,
    };
  }

  public async clickAt(targetId: string | undefined, selector: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const webContents = this.requireWebContents(resolvedTargetId);
    const result = await webContents.executeJavaScript(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) {
          return { error: 'Could not find element for selector: ${selector.replace(/'/g, "\\'")}' };
        }
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || '').trim().slice(0, 120),
        };
      })()
    `);

    if (result?.error) {
      throw new Error(String(result.error));
    }

    webContents.sendInputEvent({
      type: "mouseDown",
      x: result.x,
      y: result.y,
      button: "left",
      clickCount: 1,
    });
    webContents.sendInputEvent({
      type: "mouseUp",
      x: result.x,
      y: result.y,
      button: "left",
      clickCount: 1,
    });

    return {
      clicked: true,
      selector,
      targetId: resolvedTargetId,
      ...result,
    };
  }

  public async setFiles(
    targetId: string | undefined,
    selector: string,
    files: string[]
  ) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    await this.sendDebuggerCommand(resolvedTargetId, "DOM.enable");
    const documentRoot = await this.sendDebuggerCommand<{
      root: { nodeId: number };
    }>(resolvedTargetId, "DOM.getDocument");
    const queryResult = await this.sendDebuggerCommand<{
      nodeId?: number;
    }>(resolvedTargetId, "DOM.querySelector", {
      nodeId: documentRoot.root.nodeId,
      selector,
    });

    if (!queryResult.nodeId) {
      throw new Error(`Could not find file input for selector: ${selector}`);
    }

    await this.sendDebuggerCommand(resolvedTargetId, "DOM.setFileInputFiles", {
      files,
      nodeId: queryResult.nodeId,
    });

    return {
      files,
      selector,
      success: true,
      targetId: resolvedTargetId,
    };
  }

  public async scroll(
    targetId: string | undefined,
    args?: { direction?: "up" | "down" | "top" | "bottom"; y?: number }
  ) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const webContents = this.requireWebContents(resolvedTargetId);
    const delta = Math.abs(Math.trunc(args?.y ?? 3000));
    const direction = args?.direction ?? "down";
    const expression =
      direction === "top"
        ? `window.scrollTo(0, 0); 'scrolled to top'`
        : direction === "bottom"
          ? `window.scrollTo(0, document.body.scrollHeight); 'scrolled to bottom'`
          : direction === "up"
            ? `window.scrollBy(0, -${delta}); 'scrolled up ${delta}px'`
            : `window.scrollBy(0, ${delta}); 'scrolled down ${delta}px'`;

    const value = await webContents.executeJavaScript(expression);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      direction,
      targetId: resolvedTargetId,
      value,
      y: delta,
    };
  }

  public async screenshot(targetId?: string) {
    const resolvedTargetId = this.resolveTargetId(targetId);
    const webContents = this.requireWebContents(resolvedTargetId);
    const image = await webContents.capturePage();
    return {
      buffer: image.toPNG(),
      mimeType: "image/png",
      targetId: resolvedTargetId,
    };
  }

  private getDefaultTargetId() {
    const targets = this.listTargets();
    return (
      targets.find((target) => target.isShow)?.id ||
      targets.find((target) => target.isActive)?.id ||
      targets.at(-1)?.id ||
      null
    );
  }

  private getRemoteDebuggingPort() {
    const configuredPort = Number(this.options.remoteDebuggingPort ?? DEFAULT_REMOTE_DEBUG_PORT);
    return Number.isFinite(configuredPort) && configuredPort > 0
      ? configuredPort
      : DEFAULT_REMOTE_DEBUG_PORT;
  }

  private resolveTargetId(targetId?: string) {
    const normalizedTargetId = targetId?.trim();
    if (normalizedTargetId) {
      return normalizedTargetId;
    }

    const fallbackTargetId = this.getDefaultTargetId();
    if (!fallbackTargetId) {
      throw new Error("No embedded browser target is available.");
    }
    return fallbackTargetId;
  }

  private requireWebContents(targetId: string): WebContents {
    const webContents = this.webViewManager.getWebContents(targetId);
    if (!webContents) {
      throw new Error(`Embedded browser target "${targetId}" was not found.`);
    }
    return webContents;
  }

  private async sendDebuggerCommand<T extends JsonObject>(
    targetId: string,
    method: string,
    params?: JsonObject
  ) {
    const webContents = this.requireWebContents(targetId);
    try {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach(DEBUGGER_PROTOCOL_VERSION);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already attached/i.test(message)) {
        throw error;
      }
    }
    return (await webContents.debugger.sendCommand(method, params ?? {})) as T;
  }
}

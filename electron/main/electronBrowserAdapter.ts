/**
 * Duck-typed adapter that implements the same public API as BrowserSessionManager
 * but delegates to Electron's WebContentsView pool via WebViewManager + browserBridge.
 *
 * Used when the runner boots inside Electron so browser tasks use the built-in
 * WebContentsView instead of launching an external Chromium via Playwright.
 */

import type { WebViewManager } from "./webviewManager.js";
import {
  snapshotWebContents,
  clickElement,
  typeInElement,
  navigateWebContents,
  pressKeys,
} from "./browserBridge.js";

interface ElectronSnapshotResult {
  strategy: "electron";
  browser: "electron";
  browserLabel: string;
  profileMode: "electron_webview";
  title: string;
  url: string;
  readyState: string;
  viewport: { width: number; height: number };
  tabs: Array<{ index: number; title: string; url: string; isActive: boolean }>;
  elements: Array<{
    selector: string;
    tag: string;
    role: string | null;
    text: string;
    ariaLabel: string | null;
    name: string | null;
    placeholder: string | null;
    type: string | null;
    href: string | null;
    disabled: boolean;
    valuePreview?: string;
  }>;
  textPreview?: string;
  note?: string;
}

const META = {
  strategy: "electron" as const,
  browser: "electron" as const,
  browserLabel: "Electron WebView",
  profileMode: "electron_webview" as const,
};

export class ElectronBrowserAdapter {
  private wvm: WebViewManager;
  /** Maps sessionId → webviewId */
  private sessions = new Map<string, string>();
  private nextWebviewId = 100;

  constructor(webViewManager: WebViewManager) {
    this.wvm = webViewManager;
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private getWebContents(sessionId: string) {
    const wvId = this.sessions.get(sessionId);
    if (!wvId) throw new Error(`No Electron session for "${sessionId}"`);
    // Access the internal map through the public API
    return (this.wvm as any).webViews?.get(wvId)?.view?.webContents as Electron.WebContents | undefined;
  }

  private requireWC(sessionId: string): Electron.WebContents {
    const wc = this.getWebContents(sessionId);
    if (!wc || wc.isDestroyed()) {
      throw new Error(`WebContents destroyed or missing for session "${sessionId}"`);
    }
    return wc;
  }

  private async buildResult(sessionId: string, extra?: Partial<ElectronSnapshotResult>): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    const snapshotOptions =
      extra && typeof extra === "object"
        ? {
            includeText:
              "textPreview" in extra ? extra.textPreview !== undefined : undefined,
          }
        : undefined;
    const snap = await snapshotWebContents(wc, snapshotOptions);
    return {
      ...META,
      title: snap.title,
      url: snap.url,
      readyState: snap.readyState,
      viewport: snap.viewport,
      tabs: snap.tabs,
      elements: snap.elements,
      textPreview: snap.textPreview,
      ...extra,
    };
  }

  /** Claim an inactive webview from the pool, mark it active, navigate to url. */
  private async claimWebview(sessionId: string, url: string): Promise<string> {
    // Look for an inactive (unused) webview
    const allViews: Map<string, any> = (this.wvm as any).webViews;
    let claimedId: string | null = null;

    for (const [id, info] of allViews.entries()) {
      if (
        !info.isActive &&
        !info.isShow &&
        (info.currentUrl === "about:blank?use=0" || info.currentUrl === "about:blank")
      ) {
        claimedId = id;
        break;
      }
    }

    if (!claimedId) {
      // Create a new one
      claimedId = String(this.nextWebviewId++);
      await this.wvm.createWebview(claimedId, "about:blank?use=0");
    }

    this.sessions.set(sessionId, claimedId);

    // Mark active + show
    const info = allViews.get(claimedId);
    if (info) {
      info.isActive = true;
    }
    await this.wvm.showWebview(claimedId);

    // Navigate
    if (url && url !== "about:blank") {
      const wc = info?.view?.webContents as Electron.WebContents;
      if (wc && !wc.isDestroyed()) {
        await navigateWebContents(wc, url);
      }
    }

    return claimedId;
  }

  // ─── public API (matches BrowserSessionManager) ────────────────────

  async open(
    sessionId: string,
    args: { url?: string; newTab?: boolean } = {}
  ): Promise<ElectronSnapshotResult> {
    const url = args.url || "about:blank";

    if (this.sessions.has(sessionId) && !args.newTab) {
      // Re-use existing session, just navigate
      const wc = this.requireWC(sessionId);
      if (url !== "about:blank") {
        await navigateWebContents(wc, url);
      }
    } else {
      await this.claimWebview(sessionId, url);
    }

    return this.buildResult(sessionId, {
      note: "Opened in Electron WebView",
    });
  }

  async navigate(
    sessionId: string,
    args: { url: string }
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    await navigateWebContents(wc, args.url);
    return this.buildResult(sessionId);
  }

  async snapshot(
    sessionId: string,
    args: { maxElements?: number; includeText?: boolean; textLimit?: number } = {}
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    const snap = await snapshotWebContents(wc, args);
    return {
      ...META,
      title: snap.title,
      url: snap.url,
      readyState: snap.readyState,
      viewport: snap.viewport,
      tabs: snap.tabs,
      elements: snap.elements,
      textPreview: snap.textPreview,
    };
  }

  async click(
    sessionId: string,
    args: {
      selector?: string;
      text?: string;
      index?: number;
      button?: "left" | "right";
      x?: number;
      y?: number;
    }
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);

    if (args.selector) {
      await clickElement(wc, args.selector);
    } else if (args.text) {
      // Find element by visible text and click it
      const escaped = args.text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      await wc.executeJavaScript(`
        (function() {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode;
            const txt = (el.textContent || '').trim();
            if (txt === '${escaped}' || txt.includes('${escaped}')) {
              el.click();
              return true;
            }
          }
          return false;
        })();
      `);
    } else if (args.x !== undefined && args.y !== undefined) {
      wc.sendInputEvent({
        type: "mouseDown",
        x: args.x,
        y: args.y,
        button: args.button === "right" ? "right" : "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        x: args.x,
        y: args.y,
        button: args.button === "right" ? "right" : "left",
        clickCount: 1,
      });
    }

    // Small delay for DOM to settle
    await new Promise((r) => setTimeout(r, 150));
    return this.buildResult(sessionId);
  }

  async type(
    sessionId: string,
    args: { selector?: string; text: string; clear?: boolean; submit?: boolean }
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);

    if (args.clear) {
      // Select all and delete
      await pressKeys(wc, ["a"]); // Ctrl+A handled below
      wc.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: ["control"] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: ["control"] });
      wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
      await new Promise((r) => setTimeout(r, 50));
    }

    if (args.selector) {
      await typeInElement(wc, args.selector, args.text);
    } else {
      // Type into the currently focused element
      await wc.insertText(args.text);
    }

    if (args.submit) {
      await pressKeys(wc, ["Enter"]);
    }

    await new Promise((r) => setTimeout(r, 100));
    return this.buildResult(sessionId);
  }

  async pressKeys(
    sessionId: string,
    args: { keys: string[] }
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    await pressKeys(wc, args.keys);
    await new Promise((r) => setTimeout(r, 100));
    return this.buildResult(sessionId);
  }

  async waitFor(
    sessionId: string,
    args: { selector?: string; text?: string; timeoutMs?: number }
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    const timeout = args.timeoutMs ?? 10000;
    const start = Date.now();
    const interval = 250;

    while (Date.now() - start < timeout) {
      const found = await wc.executeJavaScript(`
        (function() {
          ${args.selector ? `if (document.querySelector('${args.selector.replace(/'/g, "\\'")}')) return true;` : ""}
          ${args.text ? `if (document.body && document.body.innerText.includes('${args.text.replace(/'/g, "\\'")}')) return true;` : ""}
          return false;
        })();
      `);
      if (found) break;
      await new Promise((r) => setTimeout(r, interval));
    }

    return this.buildResult(sessionId);
  }

  async scroll(
    sessionId: string,
    args: { x?: number; y?: number }
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    const dx = args.x ?? 0;
    const dy = args.y ?? 0;
    await wc.executeJavaScript(`window.scrollBy(${dx}, ${dy})`);
    await new Promise((r) => setTimeout(r, 100));
    return this.buildResult(sessionId);
  }

  async read(
    sessionId: string,
    args: { selector?: string; maxLength?: number } = {}
  ): Promise<ElectronSnapshotResult> {
    const wc = this.requireWC(sessionId);
    const maxLen = args.maxLength ?? 50000;
    const selectorEsc = args.selector ? args.selector.replace(/'/g, "\\'") : "";

    const text: string = await wc.executeJavaScript(`
      (function() {
        ${args.selector ? `const el = document.querySelector('${selectorEsc}'); return el ? el.innerText.slice(0, ${maxLen}) : '';` : `return (document.body ? document.body.innerText.slice(0, ${maxLen}) : '');`}
      })();
    `);

    return this.buildResult(sessionId, { textPreview: text });
  }

  async tabs(
    sessionId: string,
    args: { action: "list" | "switch" | "new" | "close"; index?: number; url?: string }
  ): Promise<ElectronSnapshotResult> {
    switch (args.action) {
      case "list": {
        // List all active webviews as "tabs"
        const allViews: Map<string, any> = (this.wvm as any).webViews;
        const currentWvId = this.sessions.get(sessionId);
        const tabList: Array<{ index: number; title: string; url: string; isActive: boolean }> = [];
        let idx = 0;
        for (const [id, info] of allViews.entries()) {
          if (info.isActive) {
            tabList.push({
              index: idx,
              title: info.currentUrl,
              url: info.currentUrl,
              isActive: id === currentWvId,
            });
            idx++;
          }
        }
        return this.buildResult(sessionId, { tabs: tabList });
      }

      case "new": {
        const newId = String(this.nextWebviewId++);
        await this.wvm.createWebview(newId, args.url || "about:blank");
        const allViews2: Map<string, any> = (this.wvm as any).webViews;
        const info = allViews2.get(newId);
        if (info) info.isActive = true;
        await this.wvm.showWebview(newId);
        // Point session at the new tab
        this.sessions.set(sessionId, newId);
        if (args.url) {
          const wc = info?.view?.webContents;
          if (wc && !wc.isDestroyed()) {
            await navigateWebContents(wc, args.url);
          }
        }
        return this.buildResult(sessionId);
      }

      case "switch": {
        if (args.index === undefined) break;
        const allViews3: Map<string, any> = (this.wvm as any).webViews;
        const activeIds = Array.from(allViews3.entries())
          .filter(([, info]) => info.isActive)
          .map(([id]) => id);
        const targetId = activeIds[args.index];
        if (targetId) {
          // Hide current
          const curId = this.sessions.get(sessionId);
          if (curId) this.wvm.hideWebview(curId);
          // Show target
          this.sessions.set(sessionId, targetId);
          await this.wvm.showWebview(targetId);
        }
        return this.buildResult(sessionId);
      }

      case "close": {
        const wvId = this.sessions.get(sessionId);
        if (wvId) {
          this.wvm.destroyWebview(wvId);
          this.sessions.delete(sessionId);
        }
        // Try to return snapshot from remaining session, or empty result
        if (this.sessions.size > 0) {
          const [remainingSession] = this.sessions.keys();
          return this.buildResult(remainingSession);
        }
        return {
          ...META,
          title: "",
          url: "",
          readyState: "complete",
          viewport: { width: 0, height: 0 },
          tabs: [],
          elements: [],
        };
      }
    }

    // Fallback
    return this.buildResult(sessionId);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const wvId = this.sessions.get(sessionId);
    if (wvId) {
      // Reset to blank instead of destroying, so the pool can reuse it
      const allViews: Map<string, any> = (this.wvm as any).webViews;
      const info = allViews.get(wvId);
      if (info) {
        info.isActive = false;
        const wc = info.view?.webContents;
        if (wc && !wc.isDestroyed()) {
          await wc.loadURL("about:blank?use=0");
        }
      }
      this.wvm.hideWebview(wvId);
      this.sessions.delete(sessionId);
    }
  }

  async disposeAll(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.disposeSession(sessionId);
    }
  }
}

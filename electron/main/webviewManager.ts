import { BrowserWindow, WebContentsView } from "electron";
import { EMBEDDED_BROWSER_PARTITION } from "./chromiumProfile.js";

interface RecordedActionData {
  id: string;
  seq: number;
  type: string;
  timestamp: number;
  target: {
    selector: string;
    xpath?: string;
    text?: string;
    tag: string;
    attributes?: Record<string, string>;
  };
  value?: string;
  position?: { x: number; y: number };
  description?: string;
}

interface RecordingState {
  webviewId: string;
  actions: RecordedActionData[];
  startTime: number;
  messageHandler: (event: Electron.Event, channel: string, ...args: any[]) => void;
}

interface WebViewInfo {
  id: string;
  view: WebContentsView;
  initialUrl: string;
  currentUrl: string;
  isActive: boolean;
  isShow: boolean;
}

interface Size {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WebviewState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isShow: boolean;
}

// Anti-fingerprinting stealth script injected into every webview
const STEALTH_SCRIPT = `
  const originalLanguages = navigator.languages ? [...navigator.languages] : ['en-US', 'en'];
  const originalHardwareConcurrency = navigator.hardwareConcurrency || 8;
  const originalDeviceMemory = navigator.deviceMemory || 8;

  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined, configurable: true
  });

  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = {
        length: 3,
        0: { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        1: { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        2: { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' },
        item: function(index) { return this[index] || null; },
        namedItem: function(name) {
          for (let i = 0; i < this.length; i++) { if (this[i].name === name) return this[i]; }
          return null;
        },
        refresh: function() {},
        [Symbol.iterator]: function* () { for (let i = 0; i < this.length; i++) yield this[i]; }
      };
      return plugins;
    }, configurable: true
  });

  Object.defineProperty(navigator, 'languages', {
    get: () => originalLanguages, configurable: true
  });
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => Math.min(Math.max(originalHardwareConcurrency, 4), 16), configurable: true
  });
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => Math.min(Math.max(originalDeviceMemory, 4), 16), configurable: true
  });

  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
    return getParameter.call(this, parameter);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel(R) Iris(TM) Graphics 6100';
      return getParameter2.call(this, parameter);
    };
  }

  if (!window.chrome) window.chrome = {};

  const automationVars = ['__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_fn',
    '__driver_evaluate', '__fxdriver_evaluate', '__driver_unwrapped', 'domAutomation', 'domAutomationController'];
  automationVars.forEach(v => {
    Object.defineProperty(window, v, {
      get: () => undefined, set: () => {}, configurable: true, enumerable: false
    });
  });
`;

export class WebViewManager {
  private webViews = new Map<string, WebViewInfo>();
  private recordings = new Map<string, RecordingState>();
  private win: BrowserWindow | null = null;
  private size: Size = { x: 0, y: 0, width: 0, height: 0 };
  private maxInactiveWebviews = 5;
  private lastCleanupTime = Date.now();

  constructor(window: BrowserWindow) {
    this.win = window;
    // Pre-initialize a pool of webviews
    this.initPool();
  }

  private async initPool() {
    for (let i = 1; i <= 8; i++) {
      await this.createWebview(String(i), "about:blank?use=0");
    }
  }

  public async captureWebview(webviewId: string) {
    const info = this.webViews.get(webviewId);
    if (!info) return null;
    const image = await info.view.webContents.capturePage();
    const jpegBuffer = image.toJPEG(10);
    return "data:image/jpeg;base64," + jpegBuffer.toString("base64");
  }

  public setSize(size: Size) {
    this.size = size;
    this.webViews.forEach((webview) => {
      if (webview.isActive && webview.isShow) {
        this.changeViewSize(webview.id, size);
      }
    });
  }

  public getActiveWebview() {
    return Array.from(this.webViews.values())
      .filter((wv) => wv.isActive)
      .map((wv) => wv.id);
  }

  public getShowWebview() {
    return Array.from(this.webViews.values())
      .filter((wv) => wv.isShow)
      .map((wv) => wv.id);
  }

  public getWebviewState(id: string): WebviewState | null {
    const info = this.webViews.get(id);
    if (!info || info.view.webContents.isDestroyed()) {
      return null;
    }

    const { webContents } = info.view;
    return {
      id,
      url: webContents.getURL() || info.currentUrl || "about:blank",
      title: webContents.getTitle(),
      canGoBack: webContents.canGoBack(),
      canGoForward: webContents.canGoForward(),
      isLoading: webContents.isLoading(),
      isShow: info.isShow,
    };
  }

  public async createWebview(id: string = "1", url: string = "about:blank?use=0") {
    if (this.webViews.has(id)) {
      return { success: false, error: `Webview with id ${id} already exists` };
    }

    try {
      const view = new WebContentsView({
        webPreferences: {
          partition: `persist:${EMBEDDED_BROWSER_PARTITION}`,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: true,
          offscreen: false,
          sandbox: true,
          disableBlinkFeatures: "Accelerated2dCanvas,AutomationControlled",
          enableBlinkFeatures: "IdleDetection",
          autoplayPolicy: "document-user-activation-required",
        },
      });

      // Inject stealth on load
      view.webContents.on("did-finish-load", () => {
        view.webContents.executeJavaScript(STEALTH_SCRIPT).catch(() => {});
      });

      // Muted by default
      view.webContents.audioMuted = true;

      // Position off-screen
      const numId = Number(id);
      view.setBounds({
        x: -9999 + numId * 100,
        y: -9999 + numId * 100,
        width: 100,
        height: 100,
      });
      view.setBorderRadius(16);

      await view.webContents.loadURL(url);

      const webViewInfo: WebViewInfo = {
        id,
        view,
        initialUrl: url,
        currentUrl: url,
        isActive: false,
        isShow: false,
      };

      // Track navigation
      view.webContents.on("did-navigate", (_event, navigationUrl) => {
        webViewInfo.currentUrl = navigationUrl;
        if (navigationUrl !== webViewInfo.initialUrl) {
          webViewInfo.isActive = true;
        }
        if (
          webViewInfo.isActive &&
          webViewInfo.isShow &&
          navigationUrl !== "about:blank?use=0" &&
          navigationUrl !== "about:blank"
        ) {
          this.win?.webContents.send("url-updated", navigationUrl);
        }
        this.win?.webContents.send("webview-navigated", id, navigationUrl);
        this.maybePoolRefill();
      });

      view.webContents.on("did-navigate-in-page", (_event, url) => {
        if (
          webViewInfo.isActive &&
          webViewInfo.isShow &&
          url !== "about:blank?use=0" &&
          url !== "about:blank"
        ) {
          this.win?.webContents.send("url-updated", url);
        }
      });

      // Deny popup windows, load in same view
      view.webContents.setWindowOpenHandler(({ url }) => {
        view.webContents.loadURL(url);
        return { action: "deny" };
      });

      this.webViews.set(id, webViewInfo);
      this.win?.contentView.addChildView(view);

      return { success: true, id, hidden: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  public changeViewSize(id: string, size: Size) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    const { x, y, width, height } = size;
    if (info.isActive && info.isShow) {
      info.view.setBounds({ x, y, width: Math.max(width, 100), height: Math.max(height, 100) });
    } else {
      const numId = Number(id);
      info.view.setBounds({
        x: -9999 + numId * 100,
        y: -9999 + numId * 100,
        width: Math.max(width, 100),
        height: Math.max(height, 100),
      });
    }
    return { success: true };
  }

  public hideWebview(id: string) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    const numId = Number(id);
    info.view.setBounds({ x: -9999 + numId * 100, y: -9999 + numId * 100, width: 100, height: 100 });
    info.isShow = false;
    if (!info.view.webContents.isDestroyed()) {
      info.view.webContents.setBackgroundThrottling(true);
    }
    this.win?.webContents.send("webview-hide", id);
    return { success: true };
  }

  public hideAllWebview() {
    this.webViews.forEach((wv) => {
      const numId = Number(wv.id);
      wv.view.setBounds({ x: -9999 + numId * 100, y: -9999 + numId * 100, width: 100, height: 100 });
      wv.isShow = false;
      if (!wv.view.webContents.isDestroyed()) {
        wv.view.webContents.setBackgroundThrottling(true);
      }
      this.win?.webContents.send("webview-hide", wv.id);
    });
  }

  public async showWebview(id: string) {
    let info = this.webViews.get(id);
    if (!info) {
      const result = await this.createWebview(id, "about:blank?use=0");
      if (!result.success) return { success: false, error: `Failed to create webview ${id}` };
      info = this.webViews.get(id)!;
    }

    const currentUrl = info.view.webContents.getURL();
    this.win?.webContents.send("url-updated", currentUrl);
    info.isShow = true;
    this.changeViewSize(id, this.size);
    if (!info.view.webContents.isDestroyed()) {
      info.view.webContents.setBackgroundThrottling(false);
    }
    this.win?.webContents.send("webview-show", id);
    return { success: true };
  }

  public async navigateWebview(id: string, url: string) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    try {
      await info.view.webContents.loadURL(url);
      return { success: true, state: this.getWebviewState(id) };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  public goBackWebview(id: string) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    if (info.view.webContents.canGoBack()) {
      info.view.webContents.goBack();
    }
    return { success: true, state: this.getWebviewState(id) };
  }

  public goForwardWebview(id: string) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    if (info.view.webContents.canGoForward()) {
      info.view.webContents.goForward();
    }
    return { success: true, state: this.getWebviewState(id) };
  }

  public reloadWebview(id: string) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    info.view.webContents.reload();
    return { success: true, state: this.getWebviewState(id) };
  }

  public destroyWebview(id: string) {
    const info = this.webViews.get(id);
    if (!info) return { success: false, error: `Webview ${id} not found` };

    if (!info.view.webContents.isDestroyed()) {
      info.view.webContents.removeAllListeners();
      info.view.webContents.session.clearCache();
    }
    this.win?.contentView.removeChildView(info.view);
    info.view.webContents.close();
    this.webViews.delete(id);
    return { success: true };
  }

  public destroy() {
    Array.from(this.webViews.keys()).forEach((id) => this.destroyWebview(id));
    this.webViews.clear();
  }

  public async startRecording(webviewId: string): Promise<{ success: boolean; error?: string }> {
    const info = this.webViews.get(webviewId);
    if (!info) return { success: false, error: `Webview ${webviewId} not found` };
    if (this.recordings.has(webviewId)) return { success: false, error: "Already recording" };

    const recordingState: RecordingState = {
      webviewId,
      actions: [],
      startTime: Date.now(),
      messageHandler: () => {},
    };

    // Inject recording script into the webview page
    const recordingScript = `
      (function() {
        if (window.__novaper_recording) return;
        window.__novaper_recording = true;
        const startTime = Date.now();
        let seq = 0;

        function getSelector(el) {
          if (!el || !el.tagName) return '';
          if (el.id) return '#' + CSS.escape(el.id);
          const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
          if (testId) return '[data-testid="' + testId + '"]';
          const parts = [];
          let current = el;
          while (current && current !== document.body && current !== document.documentElement) {
            let part = current.tagName.toLowerCase();
            if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
              if (siblings.length > 1) {
                const idx = siblings.indexOf(current) + 1;
                part += ':nth-of-type(' + idx + ')';
              }
            }
            parts.unshift(part);
            current = current.parentElement;
          }
          return parts.join(' > ') || el.tagName.toLowerCase();
        }

        function getXPath(el) {
          if (!el || !el.tagName) return '';
          const parts = [];
          let current = el;
          while (current && current.nodeType === 1) {
            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
              if (siblings.length > 1) {
                part += '[' + (siblings.indexOf(current) + 1) + ']';
              }
            }
            parts.unshift(part);
            current = current.parentElement;
          }
          return '/' + parts.join('/');
        }

        function getKeyAttrs(el) {
          const attrs = {};
          for (const a of ['id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'role', 'href']) {
            const v = el.getAttribute(a);
            if (v) attrs[a] = v.slice(0, 200);
          }
          return attrs;
        }

        function record(type, event, extra) {
          const target = event.target;
          if (!target || !target.tagName) return;
          const action = {
            id: crypto.randomUUID(),
            seq: seq++,
            type: type,
            timestamp: Date.now() - startTime,
            target: {
              selector: getSelector(target),
              xpath: getXPath(target),
              text: (target.innerText || '').slice(0, 100).trim(),
              tag: target.tagName.toLowerCase(),
              attributes: getKeyAttrs(target),
            },
            ...extra,
          };
          window.postMessage({ type: 'novaper-recorded-action', action: action }, '*');
        }

        document.addEventListener('click', function(e) {
          record('click', e, { position: { x: e.clientX, y: e.clientY } });
        }, true);
        document.addEventListener('dblclick', function(e) {
          record('dblclick', e, { position: { x: e.clientX, y: e.clientY } });
        }, true);

        let inputTimer = null;
        let lastInputTarget = null;
        document.addEventListener('input', function(e) {
          const el = e.target;
          if (lastInputTarget === el && inputTimer) { clearTimeout(inputTimer); }
          lastInputTarget = el;
          inputTimer = setTimeout(function() {
            record('type', e, { value: el.value || el.innerText || '' });
            lastInputTarget = null;
          }, 500);
        }, true);

        document.addEventListener('keydown', function(e) {
          if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'].includes(e.key) || e.ctrlKey || e.metaKey) {
            record('keypress', e, { value: (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Meta+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key });
          }
        }, true);

        document.addEventListener('scroll', function(e) {
          record('scroll', { target: document.documentElement }, { position: { x: window.scrollX, y: window.scrollY } });
        }, { capture: true, passive: true });

        document.addEventListener('change', function(e) {
          const el = e.target;
          if (el.tagName === 'SELECT') {
            record('select', e, { value: el.value });
          }
        }, true);
      })();
    `;

    try {
      await info.view.webContents.executeJavaScript(recordingScript);

      // Listen for messages from the webview
      const handler = (_event: any, channel: string, ...args: any[]) => {
        if (channel === "novaper-recorded-action") {
          const actionData = args[0] as RecordedActionData;
          recordingState.actions.push(actionData);
          this.win?.webContents.send("recorded-action", webviewId, actionData);
        }
      };
      recordingState.messageHandler = handler;

      // Use webContents.on('ipc-message') to listen for postMessage
      // Instead, use executeJavaScript to set up a bridge
      info.view.webContents.on("console-message" as any, () => {});

      // Poll for messages via a bridge
      const bridgeScript = `
        window.addEventListener('message', function(e) {
          if (e.data && e.data.type === 'novaper-recorded-action') {
            // We'll use console with a special prefix to communicate back
            console.log('__NOVAPER_ACTION__' + JSON.stringify(e.data.action));
          }
        });
      `;
      await info.view.webContents.executeJavaScript(bridgeScript);

      // Listen for console messages to capture actions
      const consoleHandler = (_event: any, _level: number, message: string) => {
        if (message.startsWith("__NOVAPER_ACTION__")) {
          try {
            const actionData = JSON.parse(message.slice("__NOVAPER_ACTION__".length)) as RecordedActionData;
            recordingState.actions.push(actionData);
            this.win?.webContents.send("recorded-action", webviewId, actionData);
          } catch {}
        }
      };
      info.view.webContents.on("console-message", consoleHandler);
      recordingState.messageHandler = consoleHandler as any;

      // Re-inject on navigation
      const navHandler = () => {
        info.view.webContents.executeJavaScript(recordingScript).catch(() => {});
        info.view.webContents.executeJavaScript(bridgeScript).catch(() => {});

        // Record navigation action
        const navAction: RecordedActionData = {
          id: crypto.randomUUID(),
          seq: recordingState.actions.length,
          type: "navigate",
          timestamp: Date.now() - recordingState.startTime,
          target: { selector: "", tag: "document" },
          value: info.view.webContents.getURL(),
        };
        recordingState.actions.push(navAction);
        this.win?.webContents.send("recorded-action", webviewId, navAction);
      };
      info.view.webContents.on("did-navigate", navHandler);
      // Store nav handler ref for cleanup
      (recordingState as any)._navHandler = navHandler;

      this.recordings.set(webviewId, recordingState);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  public stopRecording(webviewId: string): { success: boolean; actions?: RecordedActionData[]; error?: string } {
    const recording = this.recordings.get(webviewId);
    if (!recording) return { success: false, error: "Not recording" };

    const info = this.webViews.get(webviewId);
    if (info) {
      // Remove console listener
      info.view.webContents.removeListener("console-message", recording.messageHandler as any);
      // Remove nav handler
      if ((recording as any)._navHandler) {
        info.view.webContents.removeListener("did-navigate", (recording as any)._navHandler);
      }
      // Clean up recording script
      info.view.webContents.executeJavaScript(`
        window.__novaper_recording = false;
      `).catch(() => {});
    }

    const actions = [...recording.actions];
    this.recordings.delete(webviewId);
    return { success: true, actions };
  }

  public async captureActionScreenshot(webviewId: string): Promise<string | null> {
    const info = this.webViews.get(webviewId);
    if (!info) return null;
    const image = await info.view.webContents.capturePage();
    const pngBuffer = image.toPNG();
    return "data:image/png;base64," + pngBuffer.toString("base64");
  }

  private maybePoolRefill() {
    const activeSize = this.getActiveWebview().length;
    const allSize = this.webViews.size;
    const inactiveSize = allSize - activeSize;

    if (inactiveSize > this.maxInactiveWebviews && Date.now() - this.lastCleanupTime > 30000) {
      this.cleanupInactiveWebviews();
      this.lastCleanupTime = Date.now();
    }

    if (inactiveSize <= 2) {
      const existingKeys = Array.from(this.webViews.keys()).map(Number).filter((n) => !isNaN(n));
      const maxId = existingKeys.length > 0 ? Math.max(...existingKeys) : 0;
      for (let i = 0; i < 2; i++) {
        this.createWebview(String(maxId + 1 + i), "about:blank?use=0");
      }
    }
  }

  private cleanupInactiveWebviews() {
    const inactive = Array.from(this.webViews.entries())
      .filter(([, info]) => !info.isActive && !info.isShow && info.currentUrl === "about:blank?use=0")
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    inactive.slice(this.maxInactiveWebviews).forEach(([id]) => this.destroyWebview(id));
  }
}

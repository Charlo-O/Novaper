import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type ElementHandle, type KeyInput, type Page } from "puppeteer-core";

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
  isActive: boolean;
}

export interface BrowserSnapshotElement {
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
}

export interface BrowserSnapshotResult {
  title: string;
  url: string;
  readyState: string;
  viewport: {
    width: number;
    height: number;
  };
  tabs: BrowserTabInfo[];
  elements: BrowserSnapshotElement[];
  textPreview?: string;
}

interface BrowserSessionState {
  browser: Browser;
  activePage: Page;
  userDataDir: string;
}

interface BrowserSnapshotDomResult {
  title: string;
  url: string;
  readyState: string;
  viewport: {
    width: number;
    height: number;
  };
  elements: BrowserSnapshotElement[];
  textPreview?: string;
}

function sanitizeSessionId(sessionId: string) {
  return sessionId.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 48) || "session";
}

function createTempUserDataDir(sessionId: string) {
  const prefix = `novaper-browser-${sanitizeSessionId(sessionId)}-`;
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupUserDataDir(userDataDir: string) {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function findWindowsBrowserPath() {
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

  const candidates = [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const executable of ["chrome.exe", "msedge.exe", "brave.exe"]) {
    try {
      const result = execFileSync("where", [executable], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && fs.existsSync(line));
      if (match) {
        return match;
      }
    } catch {
      // Try the next executable.
    }
  }

  return null;
}

function findPosixBrowserPath() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const executable of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium", "microsoft-edge", "brave-browser"]) {
    try {
      const result = execFileSync("which", [executable], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && fs.existsSync(line));
      if (match) {
        return match;
      }
    } catch {
      // Try the next executable.
    }
  }

  return null;
}

function findBrowserExecutable() {
  return process.platform === "win32" ? findWindowsBrowserPath() : findPosixBrowserPath();
}

function normalizeBrowserKey(key: string): KeyInput {
  const upper = key.trim().toUpperCase();
  switch (upper) {
    case "CTRL":
      return "Control" as KeyInput;
    case "CMD":
    case "COMMAND":
    case "META":
    case "WIN":
    case "WINDOWS":
      return "Meta" as KeyInput;
    case "ALT":
      return "Alt" as KeyInput;
    case "SHIFT":
      return "Shift" as KeyInput;
    case "ESC":
      return "Escape" as KeyInput;
    case "RETURN":
      return "Enter" as KeyInput;
    case "SPACE":
      return " " as KeyInput;
    case "PAGEUP":
      return "PageUp" as KeyInput;
    case "PAGEDOWN":
      return "PageDown" as KeyInput;
    case "UP":
      return "ArrowUp" as KeyInput;
    case "DOWN":
      return "ArrowDown" as KeyInput;
    case "LEFT":
      return "ArrowLeft" as KeyInput;
    case "RIGHT":
      return "ArrowRight" as KeyInput;
    default:
      return (key.length === 1 ? key : key[0].toUpperCase() + key.slice(1)) as KeyInput;
  }
}

function trimText(value: string | null | undefined, maxLength = 160) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();

  private async launchSession(sessionId: string) {
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
      throw new Error("No supported Chromium browser found. Install Google Chrome, Microsoft Edge, or Brave.");
    }

    const userDataDir = createTempUserDataDir(sessionId);

    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: false,
        defaultViewport: null,
        userDataDir,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });

      let activePage = (await browser.pages()).find((page) => !page.isClosed() && !page.url().startsWith("devtools://"));
      if (!activePage) {
        activePage = await browser.newPage();
      }
      await activePage.bringToFront();

      const state: BrowserSessionState = {
        browser,
        activePage,
        userDataDir,
      };

      browser.on("disconnected", () => {
        const current = this.sessions.get(sessionId);
        if (current?.browser === browser) {
          this.sessions.delete(sessionId);
          cleanupUserDataDir(userDataDir);
        }
      });

      this.sessions.set(sessionId, state);
      return state;
    } catch (error) {
      cleanupUserDataDir(userDataDir);
      throw error;
    }
  }

  private async getSession(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.browser.connected) {
      if (existing.activePage.isClosed()) {
        existing.activePage = await this.ensurePage(existing);
      }
      return existing;
    }

    if (existing) {
      this.sessions.delete(sessionId);
      cleanupUserDataDir(existing.userDataDir);
    }

    return this.launchSession(sessionId);
  }

  private async listPages(state: BrowserSessionState) {
    const pages = await state.browser.pages();
    return pages.filter((page) => !page.isClosed() && !page.url().startsWith("devtools://"));
  }

  private async ensurePage(state: BrowserSessionState) {
    const pages = await this.listPages(state);
    if (pages.length === 0) {
      const page = await state.browser.newPage();
      state.activePage = page;
      return page;
    }

    if (!state.activePage.isClosed() && pages.includes(state.activePage)) {
      return state.activePage;
    }

    state.activePage = pages[0];
    return state.activePage;
  }

  private async resolveActivePage(sessionId: string) {
    const state = await this.getSession(sessionId);
    const page = await this.ensurePage(state);
    await page.bringToFront();
    return { state, page };
  }

  private async getTabs(state: BrowserSessionState) {
    const pages = await this.listPages(state);
    return Promise.all(
      pages.map(async (page, index) => ({
        index,
        title: trimText(await page.title(), 120) || "Untitled",
        url: page.url(),
        isActive: page === state.activePage,
      })),
    );
  }

  async open(sessionId: string, args: { url?: string; newTab?: boolean } = {}) {
    const state = await this.getSession(sessionId);
    const page = args.newTab ? await state.browser.newPage() : await this.ensurePage(state);
    state.activePage = page;
    await page.bringToFront();

    if (args.url) {
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    return {
      opened: true,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async navigate(sessionId: string, args: { url: string }) {
    const { state, page } = await this.resolveActivePage(sessionId);
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });

    return {
      navigated: true,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async tabs(sessionId: string, args: { action: "list" | "switch" | "new" | "close"; index?: number; url?: string }) {
    const state = await this.getSession(sessionId);
    const pages = await this.listPages(state);

    switch (args.action) {
      case "list":
        return { tabs: await this.getTabs(state) };
      case "new": {
        const page = await state.browser.newPage();
        state.activePage = page;
        await page.bringToFront();
        if (args.url) {
          await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        }
        return {
          opened: true,
          index: (await this.listPages(state)).findIndex((entry) => entry === page),
          url: page.url(),
          tabs: await this.getTabs(state),
        };
      }
      case "switch": {
        if (typeof args.index !== "number" || args.index < 0 || args.index >= pages.length) {
          throw new Error("browser_tabs switch requires a valid tab index.");
        }
        state.activePage = pages[args.index];
        await state.activePage.bringToFront();
        return {
          switched: true,
          index: args.index,
          title: trimText(await state.activePage.title(), 120) || "Untitled",
          url: state.activePage.url(),
          tabs: await this.getTabs(state),
        };
      }
      case "close": {
        const targetIndex = typeof args.index === "number" ? args.index : pages.findIndex((page) => page === state.activePage);
        if (targetIndex < 0 || targetIndex >= pages.length) {
          throw new Error("browser_tabs close requires a valid tab index.");
        }

        const target = pages[targetIndex];
        await target.close({ runBeforeUnload: true });

        const remaining = await this.listPages(state);
        if (remaining.length === 0) {
          await state.browser.close().catch(() => undefined);
          this.sessions.delete(sessionId);
          cleanupUserDataDir(state.userDataDir);
          return {
            closed: true,
            browserClosed: true,
            tabs: [],
          };
        }

        state.activePage = remaining[Math.max(0, Math.min(targetIndex, remaining.length - 1))];
        await state.activePage.bringToFront();
        return {
          closed: true,
          browserClosed: false,
          tabs: await this.getTabs(state),
        };
      }
      default:
        throw new Error(`Unsupported browser tab action: ${String(args.action)}`);
    }
  }

  async snapshot(sessionId: string, args: { maxElements?: number; includeText?: boolean; textLimit?: number } = {}): Promise<BrowserSnapshotResult> {
    const { state, page } = await this.resolveActivePage(sessionId);
    const maxElements = Math.max(1, Math.min(100, Math.trunc(args.maxElements ?? 40)));
    const textLimit = Math.max(200, Math.min(5000, Math.trunc(args.textLimit ?? 1200)));

    const domResult = await page.evaluate(
      ({ maxElements: limit, includeText, textLimit: maxTextLength }) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };

        const shorten = (value: string | null | undefined, maxLength = 160) => {
          const normalized = (value ?? "").replace(/\s+/g, " ").trim();
          return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
        };

        const escapeSelector = (value: string) => {
          if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
            return CSS.escape(value);
          }
          return value.replace(/([ !\"#$%&'()*+,./:;<=>?@[\\\\\\]^`{|}~])/g, "\\$1");
        };

        const buildSelector = (element: Element): string => {
          if (element.id) {
            return `#${escapeSelector(element.id)}`;
          }

          const htmlElement = element as HTMLElement;
          for (const [attribute, value] of [
            ["data-testid", htmlElement.getAttribute("data-testid")],
            ["aria-label", htmlElement.getAttribute("aria-label")],
            ["name", htmlElement.getAttribute("name")],
            ["placeholder", htmlElement.getAttribute("placeholder")],
          ]) {
            if (!value) {
              continue;
            }

            const selector = `${element.tagName.toLowerCase()}[${attribute}="${escapeSelector(value)}"]`;
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
          }

          const segments: string[] = [];
          let current: Element | null = element;
          while (current && current !== document.body && segments.length < 6) {
            const parentElement: Element | null = current.parentElement;
            let segment = current.tagName.toLowerCase();
            if (parentElement) {
              const siblings = (Array.from(parentElement.children) as Element[]).filter((child: Element) => child.tagName === current?.tagName);
              if (siblings.length > 1) {
                segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
              }
            }
            segments.unshift(segment);
            const selector = segments.join(" > ");
            if (document.querySelectorAll(selector).length === 1) {
              return selector;
            }
            current = parentElement;
          }

          return segments.join(" > ") || element.tagName.toLowerCase();
        };

        const actionableSelector =
          "a, button, input, textarea, select, option, [role='button'], [role='link'], [role='tab'], [role='checkbox'], [contenteditable='true']";
        const candidates = Array.from(document.querySelectorAll(actionableSelector)).filter(visible).slice(0, limit);
        const elements = candidates.map((element) => {
          const htmlElement = element as HTMLElement & {
            href?: string;
            disabled?: boolean;
            value?: string;
            type?: string;
            name?: string;
            placeholder?: string;
          };

          const type = typeof htmlElement.type === "string" ? htmlElement.type : null;
          const valuePreview =
            type && type.toLowerCase() === "password"
              ? undefined
              : shorten(typeof htmlElement.value === "string" ? htmlElement.value : undefined, 80);

          return {
            selector: buildSelector(element),
            tag: element.tagName.toLowerCase(),
            role: htmlElement.getAttribute("role"),
            text: shorten(htmlElement.innerText || element.textContent || htmlElement.getAttribute("aria-label") || "", 160),
            ariaLabel: htmlElement.getAttribute("aria-label"),
            name: typeof htmlElement.name === "string" && htmlElement.name.length > 0 ? htmlElement.name : null,
            placeholder: typeof htmlElement.placeholder === "string" && htmlElement.placeholder.length > 0 ? htmlElement.placeholder : null,
            type,
            href: typeof htmlElement.href === "string" ? htmlElement.href : null,
            disabled: Boolean(htmlElement.disabled),
            valuePreview: valuePreview && valuePreview.length > 0 ? valuePreview : undefined,
          };
        });

        return {
          title: document.title || "Untitled",
          url: location.href,
          readyState: document.readyState,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          elements,
          textPreview: includeText ? shorten(document.body?.innerText || "", maxTextLength) : undefined,
        };
      },
      {
        maxElements,
        includeText: args.includeText !== false,
        textLimit,
      },
    ) as BrowserSnapshotDomResult;

    return {
      ...domResult,
      title: trimText(domResult.title, 120) || "Untitled",
      tabs: await this.getTabs(state),
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
    },
  ) {
    const { state, page } = await this.resolveActivePage(sessionId);
    const button = args.button === "right" ? "right" : "left";

    if (typeof args.x === "number" && typeof args.y === "number") {
      await page.mouse.click(args.x, args.y, { button });
    } else if (args.selector) {
      const element = await page.waitForSelector(args.selector, { timeout: 15000 });
      if (!element) {
        throw new Error(`Could not find browser element for selector: ${args.selector}`);
      }
      await page.evaluate((node) => {
        (node as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
      }, element);
      await element.click({ button });
    } else if (args.text) {
      const handle = await page.evaluateHandle(
        ({ text, index }) => {
          const visible = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };

          const selector =
            "a, button, input, textarea, select, option, [role='button'], [role='link'], [role='tab'], [contenteditable='true']";
          const matches = Array.from(document.querySelectorAll(selector)).filter((element) => {
            if (!visible(element)) {
              return false;
            }

            const content = `${(element as HTMLElement).innerText || element.textContent || ""} ${(element as HTMLElement).getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
            return content.includes(text);
          });

          return matches[index ?? 0] ?? null;
        },
        { text: args.text, index: args.index ?? 0 },
      );

      const element = handle.asElement() as ElementHandle<Element> | null;
      if (!element) {
        await handle.dispose();
        throw new Error(`Could not find browser element containing text: ${args.text}`);
      }

      await page.evaluate((node) => {
        (node as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
      }, element);
      await element.click({ button });
      await handle.dispose();
    } else {
      throw new Error("browser_click requires selector, text, or x/y coordinates.");
    }

    return {
      clicked: true,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async type(sessionId: string, args: { selector?: string; text: string; clear?: boolean; submit?: boolean }) {
    const { state, page } = await this.resolveActivePage(sessionId);

    if (args.selector) {
      const element = await page.waitForSelector(args.selector, { timeout: 15000 });
      if (!element) {
        throw new Error(`Could not find browser input for selector: ${args.selector}`);
      }

      await page.evaluate((node) => {
        (node as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
        (node as HTMLElement).focus();
      }, element);
      await element.click({ clickCount: args.clear ? 3 : 1 });
    }

    if (args.clear) {
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
    }

    await page.keyboard.type(args.text, { delay: 20 });
    if (args.submit) {
      await page.keyboard.press("Enter");
    }

    return {
      typed: true,
      submitted: Boolean(args.submit),
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async pressKeys(sessionId: string, args: { keys: string[] }) {
    const { state, page } = await this.resolveActivePage(sessionId);
    if (!Array.isArray(args.keys) || args.keys.length === 0) {
      throw new Error("browser_press_keys requires at least one key.");
    }

    const keys = args.keys.map((key) => normalizeBrowserKey(String(key)));
    if (keys.length === 1) {
      await page.keyboard.press(keys[0]);
    } else {
      const modifiers = keys.slice(0, -1);
      const mainKey = keys[keys.length - 1];
      for (const key of modifiers) {
        await page.keyboard.down(key);
      }
      await page.keyboard.press(mainKey);
      for (const key of modifiers.reverse()) {
        await page.keyboard.up(key);
      }
    }

    return {
      pressed: true,
      keys,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async waitFor(sessionId: string, args: { selector?: string; text?: string; timeoutMs?: number }) {
    const { state, page } = await this.resolveActivePage(sessionId);
    const timeoutMs = Math.max(100, Math.min(30000, Math.trunc(args.timeoutMs ?? 5000)));

    if (args.selector) {
      await page.waitForSelector(args.selector, { timeout: timeoutMs });
      return {
        matched: "selector",
        selector: args.selector,
        timeoutMs,
        title: trimText(await page.title(), 120) || "Untitled",
        url: page.url(),
        tabs: await this.getTabs(state),
      };
    }

    if (args.text) {
      await page.waitForFunction(
        (text) => Boolean(document.body && document.body.innerText.includes(text)),
        { timeout: timeoutMs },
        args.text,
      );
      return {
        matched: "text",
        text: args.text,
        timeoutMs,
        title: trimText(await page.title(), 120) || "Untitled",
        url: page.url(),
        tabs: await this.getTabs(state),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return {
      matched: "timeout",
      timeoutMs,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async scroll(sessionId: string, args: { x?: number; y?: number }) {
    const { state, page } = await this.resolveActivePage(sessionId);
    const x = typeof args.x === "number" ? args.x : 0;
    const y = typeof args.y === "number" ? args.y : 600;

    await page.evaluate(
      ({ scrollX, scrollY }) => {
        window.scrollBy(scrollX, scrollY);
      },
      { scrollX: x, scrollY: y },
    );

    const currentScroll = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
    }));

    return {
      scrolled: true,
      scroll: currentScroll,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async read(sessionId: string, args: { selector?: string; maxLength?: number } = {}) {
    const { state, page } = await this.resolveActivePage(sessionId);
    const maxLength = Math.max(200, Math.min(12000, Math.trunc(args.maxLength ?? 4000)));

    let text: string;
    if (args.selector) {
      const element = await page.waitForSelector(args.selector, { timeout: 15000 });
      if (!element) {
        throw new Error(`Could not find browser element for selector: ${args.selector}`);
      }
      text = await page.evaluate((node) => (node as HTMLElement).innerText || node.textContent || "", element);
    } else {
      text = await page.evaluate(() => document.body?.innerText || "");
    }

    const normalized = text.replace(/\s+/g, " ").trim();
    return {
      text: normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized,
      title: trimText(await page.title(), 120) || "Untitled",
      url: page.url(),
      tabs: await this.getTabs(state),
    };
  }

  async disposeSession(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return;
    }

    this.sessions.delete(sessionId);
    try {
      await state.browser.close();
    } catch {
      // Best effort shutdown.
    } finally {
      cleanupUserDataDir(state.userDataDir);
    }
  }

  async disposeAll() {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)));
  }
}

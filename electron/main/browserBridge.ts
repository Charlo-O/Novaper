import type { WebContents } from "electron";

interface SnapshotElement {
  index: number;
  ariaLabel: string | null;
  bounds?: { x: number; y: number; width: number; height: number };
  description?: string;
  disabled: boolean;
  href: string | null;
  name: string | null;
  placeholder: string | null;
  role: string | null;
  selector: string;
  tag: string;
  text: string;
  type: string | null;
  valuePreview?: string;
}

interface SnapshotOptions {
  includeText?: boolean;
  maxElements?: number;
  textLimit?: number;
}

function escapeForScript(value: string) {
  return JSON.stringify(value);
}

async function waitForLoad(webContents: WebContents) {
  if (!webContents.isLoadingMainFrame()) {
    return;
  }

  const eventTarget = webContents as WebContents & {
    on: (event: string, listener: (...args: any[]) => void) => void;
    removeListener: (event: string, listener: (...args: any[]) => void) => void;
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 15000);

    const cleanup = () => {
      clearTimeout(timeout);
      webContents.removeListener("did-finish-load", onFinish);
      eventTarget.removeListener("did-fail-load", onFail);
    };

    const onFinish = () => {
      cleanup();
      resolve();
    };

    const onFail = (
      _event: Event,
      errorCode: number,
      errorDescription: string
    ) => {
      cleanup();
      reject(new Error(`Navigation failed (${errorCode}): ${errorDescription}`));
    };

    webContents.on("did-finish-load", onFinish);
    eventTarget.on("did-fail-load", onFail);
  });
}

export async function navigateWebContents(webContents: WebContents, url: string) {
  await webContents.loadURL(url);
  await waitForLoad(webContents);
}

export async function snapshotWebContents(
  webContents: WebContents,
  options: SnapshotOptions = {}
) {
  const maxElements = Math.max(
    10,
    Math.min(400, Math.trunc(options.maxElements ?? 200))
  );
  const textLimit = Math.max(
    1000,
    Math.min(200000, Math.trunc(options.textLimit ?? 4000))
  );
  const includeText = options.includeText !== false;

  const snapshot = await webContents.executeJavaScript(`
    (() => {
      const MAX_ELEMENTS = ${maxElements};
      const TEXT_LIMIT = ${textLimit};
      const INCLUDE_TEXT = ${includeText};
      const interactiveSelector = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="combobox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[tabindex]'
      ].join(',');

      const buildSelector = (element) => {
        if (!(element instanceof Element)) return "";
        if (element.id) return "#" + element.id;
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
          let part = current.tagName.toLowerCase();
          if (current.classList.length > 0) {
            part += "." + Array.from(current.classList).slice(0, 2).join(".");
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(" > ");
      };

      const isVisible = (element) => {
        if (!(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const getLabel = (element) => {
        if (!(element instanceof Element)) return null;
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.trim();
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelText = labelledBy
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || '')
            .filter(Boolean)
            .join(' ');
          if (labelText) return labelText.slice(0, 200);
        }
        const labeledElement = element;
        if ('labels' in labeledElement && labeledElement.labels) {
          const text = Array.from(labeledElement.labels)
            .map((label) => label.textContent?.trim() || '')
            .filter(Boolean)
            .join(' ');
          if (text) return text.slice(0, 200);
        }
        const placeholder = element.getAttribute('placeholder');
        return placeholder ? placeholder.trim().slice(0, 200) : null;
      };

      const getDisabled = (element) => {
        return 'disabled' in element ? Boolean(element.disabled) : false;
      };

      const candidates = Array.from(
        document.querySelectorAll(interactiveSelector)
      )
        .filter((element, index, array) => array.indexOf(element) === index)
        .filter((element) => isVisible(element))
        .slice(0, MAX_ELEMENTS)
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          const text = (element.textContent || "").trim().slice(0, 200);
          const label = getLabel(element);
          return {
            index: index + 1,
            selector: buildSelector(element),
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            text,
            ariaLabel: element.getAttribute("aria-label"),
            name: element.getAttribute("name"),
            placeholder: element.getAttribute("placeholder"),
            type: element.getAttribute("type"),
            href: element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href"),
            disabled: getDisabled(element),
            valuePreview: "value" in element ? String(element.value || "").slice(0, 120) : undefined,
            description: [label, text].filter(Boolean).join(" | ").slice(0, 240),
            bounds: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        });

      return {
        elements: candidates,
        readyState: document.readyState,
        textPreview: INCLUDE_TEXT ? (document.body?.innerText || "").slice(0, TEXT_LIMIT) : undefined,
        title: document.title,
        url: location.href,
        lang: document.documentElement?.lang || null,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      };
    })()
  `);

  return {
    title: snapshot.title || webContents.getTitle(),
    url: snapshot.url || webContents.getURL(),
    readyState: snapshot.readyState,
    viewport: snapshot.viewport,
    tabs: [
      {
        index: 0,
        title: snapshot.title || webContents.getTitle(),
        url: snapshot.url || webContents.getURL(),
        isActive: true,
      },
    ],
    elements: snapshot.elements as SnapshotElement[],
    textPreview: snapshot.textPreview as string | undefined,
  };
}

export async function clickElement(webContents: WebContents, selector: string) {
  const position = await webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${escapeForScript(selector)});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()
  `);

  if (!position) {
    throw new Error(`Could not find element for selector: ${selector}`);
  }

  webContents.sendInputEvent({
    type: "mouseDown",
    x: position.x,
    y: position.y,
    button: "left",
    clickCount: 1,
  });
  webContents.sendInputEvent({
    type: "mouseUp",
    x: position.x,
    y: position.y,
    button: "left",
    clickCount: 1,
  });
}

export async function typeInElement(
  webContents: WebContents,
  selector: string,
  text: string
) {
  const changed = await webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${escapeForScript(selector)});
      if (
        !(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLTextAreaElement) &&
        !(element instanceof HTMLElement)
      ) {
        return false;
      }

      element.focus();

      if ("value" in element) {
        element.value = ${escapeForScript(text)};
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      if (element.isContentEditable) {
        element.textContent = ${escapeForScript(text)};
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${escapeForScript(text)} }));
        return true;
      }

      return false;
    })()
  `);

  if (!changed) {
    throw new Error(`Could not type into selector: ${selector}`);
  }
}

export async function pressKeys(webContents: WebContents, keys: string[]) {
  for (const key of keys) {
    if (key.length === 1) {
      await webContents.insertText(key);
      continue;
    }

    webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    webContents.sendInputEvent({ type: "keyUp", keyCode: key });
  }
}

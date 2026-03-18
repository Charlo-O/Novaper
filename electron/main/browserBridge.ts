import type { WebContents } from "electron";

interface SnapshotElement {
  ariaLabel: string | null;
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

function escapeForScript(value: string) {
  return JSON.stringify(value);
}

async function waitForLoad(webContents: WebContents) {
  if (!webContents.isLoadingMainFrame()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 15000);

    const cleanup = () => {
      clearTimeout(timeout);
      webContents.removeListener("did-finish-load", onFinish);
      webContents.removeListener("did-fail-load", onFail);
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
    webContents.on("did-fail-load", onFail);
  });
}

export async function navigateWebContents(webContents: WebContents, url: string) {
  await webContents.loadURL(url);
  await waitForLoad(webContents);
}

export async function snapshotWebContents(webContents: WebContents) {
  const snapshot = await webContents.executeJavaScript(`
    (() => {
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

      const candidates = Array.from(
        document.querySelectorAll("a,button,input,textarea,select,[role],summary")
      )
        .slice(0, 200)
        .map((element) => ({
          selector: buildSelector(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          text: (element.textContent || "").trim().slice(0, 200),
          ariaLabel: element.getAttribute("aria-label"),
          name: element.getAttribute("name"),
          placeholder: element.getAttribute("placeholder"),
          type: element.getAttribute("type"),
          href: element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href"),
          disabled: "disabled" in element ? Boolean(element.disabled) : false,
          valuePreview: "value" in element ? String(element.value || "").slice(0, 120) : undefined,
        }));

      return {
        elements: candidates,
        readyState: document.readyState,
        textPreview: (document.body?.innerText || "").slice(0, 4000),
        title: document.title,
        url: location.href,
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
    textPreview: snapshot.textPreview as string,
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

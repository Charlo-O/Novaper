import { contextBridge, ipcRenderer, webUtils } from "electron";

// ==================== Exposed API ====================
contextBridge.exposeInMainWorld("electronAPI", {
  // Window control
  closeWindow: () => ipcRenderer.send("window-close"),
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("window-toggle-maximize"),
  isFullScreen: () => ipcRenderer.invoke("is-fullscreen"),

  // App info
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getBackendPort: () => ipcRenderer.invoke("get-backend-port"),

  // File operations
  selectFile: (options?: any) => ipcRenderer.invoke("select-file", options),
  readFile: (filePath: string) => ipcRenderer.invoke("read-file", filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Log
  exportLog: () => ipcRenderer.invoke("export-log"),

  // WebView control
  createWebView: (id: string, url: string) =>
    ipcRenderer.invoke("create-webview", id, url),
  showWebview: (id: string) => ipcRenderer.invoke("show-webview", id),
  hideWebView: (id: string) => ipcRenderer.invoke("hide-webview", id),
  hideAllWebview: () => ipcRenderer.invoke("hide-all-webview"),
  changeViewSize: (id: string, size: any) =>
    ipcRenderer.invoke("change-view-size", id, size),
  getActiveWebview: () => ipcRenderer.invoke("get-active-webview"),
  captureWebview: (id: string) => ipcRenderer.invoke("capture-webview", id),
  webviewDestroy: (id: string) => ipcRenderer.invoke("webview-destroy", id),
  setSize: (size: any) => ipcRenderer.invoke("set-size", size),
  getShowWebview: () => ipcRenderer.invoke("get-show-webview"),

  // Browser profiles
  listBrowserProfiles: () => ipcRenderer.invoke("list-browser-profiles"),
  importBrowserProfile: (browserKey: string, profileDir: string) =>
    ipcRenderer.invoke("import-browser-profile", browserKey, profileDir),
  switchBrowserProfile: (profileName: string) =>
    ipcRenderer.invoke("switch-browser-profile", profileName),

  // Skills
  getSkillsDir: () => ipcRenderer.invoke("get-skills-dir"),
  skillsScan: () => ipcRenderer.invoke("skills-scan"),
  skillWrite: (skillDirName: string, content: string) =>
    ipcRenderer.invoke("skill-write", skillDirName, content),
  skillDelete: (skillDirName: string) =>
    ipcRenderer.invoke("skill-delete", skillDirName),

  // Recording
  startRecording: (webviewId: string) =>
    ipcRenderer.invoke("start-recording", webviewId),
  stopRecording: (webviewId: string) =>
    ipcRenderer.invoke("stop-recording", webviewId),
  captureActionScreenshot: (webviewId: string, actionSeq: number, workflowUuid: string) =>
    ipcRenderer.invoke("capture-action-screenshot", webviewId, actionSeq, workflowUuid),
  onRecordedAction: (callback: (webviewId: string, action: any) => void) => {
    const listener = (_event: any, webviewId: string, action: any) =>
      callback(webviewId, action);
    ipcRenderer.on("recorded-action", listener);
    return () => ipcRenderer.off("recorded-action", listener);
  },

  // System
  restartApp: () => ipcRenderer.invoke("restart-app"),
  getPlatform: () => process.platform,

  // Event listeners
  onWebviewNavigated: (callback: (id: string, url: string) => void) => {
    const listener = (_event: any, id: string, url: string) =>
      callback(id, url);
    ipcRenderer.on("webview-navigated", listener);
    return () => ipcRenderer.off("webview-navigated", listener);
  },
  onUrlUpdated: (callback: (url: string) => void) => {
    const listener = (_event: any, url: string) => callback(url);
    ipcRenderer.on("url-updated", listener);
    return () => ipcRenderer.off("url-updated", listener);
  },
  onProtocolUrl: (callback: (url: string) => void) => {
    const listener = (_event: any, url: string) => callback(url);
    ipcRenderer.on("protocol-url", listener);
    return () => ipcRenderer.off("protocol-url", listener);
  },
  onBackendReady: (callback: (data: { success: boolean; port?: number; error?: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on("backend-ready", listener);
    return () => ipcRenderer.off("backend-ready", listener);
  },

  // Generic listener removal
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});

// ==================== Loading spinner ====================
function domReady(
  condition: DocumentReadyState[] = ["complete", "interactive"]
) {
  return new Promise((resolve) => {
    if (condition.includes(document.readyState)) {
      resolve(true);
    } else {
      document.addEventListener("readystatechange", () => {
        if (condition.includes(document.readyState)) {
          resolve(true);
        }
      });
    }
  });
}

function createLoading() {
  const styleContent = `
@keyframes novaper-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}
.novaper-loading-wrap {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0f1a;
  z-index: 9999;
}
.novaper-loading-dot {
  width: 12px;
  height: 12px;
  margin: 0 6px;
  border-radius: 50%;
  background: #14b8a6;
  animation: novaper-pulse 1.4s ease-in-out infinite;
}
.novaper-loading-dot:nth-child(2) { animation-delay: 0.2s; }
.novaper-loading-dot:nth-child(3) { animation-delay: 0.4s; }
`;
  const oStyle = document.createElement("style");
  oStyle.id = "novaper-loading-style";
  oStyle.innerHTML = styleContent;

  const oDiv = document.createElement("div");
  oDiv.className = "novaper-loading-wrap";
  oDiv.innerHTML = `
    <div class="novaper-loading-dot"></div>
    <div class="novaper-loading-dot"></div>
    <div class="novaper-loading-dot"></div>
  `;

  return {
    appendLoading() {
      document.head.appendChild(oStyle);
      document.body.appendChild(oDiv);
    },
    removeLoading() {
      oStyle.remove();
      oDiv.remove();
    },
  };
}

const { appendLoading, removeLoading } = createLoading();
domReady().then(appendLoading);

window.onmessage = (ev) => {
  if (ev.data?.payload === "removeLoading") removeLoading();
};

setTimeout(removeLoading, 4999);

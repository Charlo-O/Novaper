/// <reference types="vite/client" />

declare const __BACKEND_VERSION__: string;

/** Electron preload API — only available when running inside the Electron shell. */
interface ElectronAPI {
  closeWindow: () => void;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => void;
  isFullScreen: () => Promise<boolean>;
  getAppVersion: () => Promise<string>;
  getBackendPort: () => Promise<number>;
  selectFile: (options?: any) => Promise<string | null>;
  readFile: (filePath: string) => Promise<string>;
  getPathForFile: (file: File) => string;
  exportLog: () => Promise<string | null>;
  createWebView: (id: string, url: string) => Promise<any>;
  showWebview: (id: string) => Promise<any>;
  hideWebView: (id: string) => Promise<any>;
  hideAllWebview: () => Promise<void>;
  changeViewSize: (id: string, size: { x: number; y: number; width: number; height: number }) => Promise<any>;
  getActiveWebview: () => Promise<string[]>;
  captureWebview: (id: string) => Promise<string | null>;
  webviewDestroy: (id: string) => Promise<any>;
  setSize: (size: { x: number; y: number; width: number; height: number }) => Promise<void>;
  getShowWebview: () => Promise<string[]>;
  listBrowserProfiles: () => Promise<any[]>;
  importBrowserProfile: (browserKey: string, profileDir: string) => Promise<any>;
  switchBrowserProfile: (profileName: string) => Promise<any>;
  getSkillsDir: () => Promise<string>;
  skillsScan: () => Promise<Array<{ name: string; content: string }>>;
  skillWrite: (skillDirName: string, content: string) => Promise<{ success: boolean }>;
  skillDelete: (skillDirName: string) => Promise<{ success: boolean }>;
  startRecording: (webviewId: string) => Promise<{ success: boolean; error?: string }>;
  stopRecording: (webviewId: string) => Promise<{ success: boolean; actions?: any[]; error?: string }>;
  captureActionScreenshot: (webviewId: string, actionSeq: number, workflowUuid: string) => Promise<string | null>;
  onRecordedAction: (callback: (webviewId: string, action: any) => void) => () => void;
  restartApp: () => void;
  getPlatform: () => string;
  onWebviewNavigated: (callback: (id: string, url: string) => void) => () => void;
  onUrlUpdated: (callback: (url: string) => void) => () => void;
  onProtocolUrl: (callback: (url: string) => void) => () => void;
  onBackendReady: (callback: (data: { success: boolean; port?: number; error?: string }) => void) => () => void;
  removeAllListeners: (channel: string) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare module '*.webp' {
  const value: string;
  export default value;
}

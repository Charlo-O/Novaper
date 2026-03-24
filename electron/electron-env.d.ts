declare namespace NodeJS {
  interface ProcessVersions {
    readonly electron: string;
    readonly chrome: string;
  }
}

interface ElectronAPI {
  // Window control
  closeWindow: () => void;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => void;
  isFullScreen: () => Promise<boolean>;

  // App info
  getAppVersion: () => Promise<string>;
  getBackendPort: () => Promise<number>;

  // File operations
  selectFile: (options?: any) => Promise<string | null>;
  readFile: (filePath: string) => Promise<string>;
  getPathForFile: (file: File) => string;

  // Log
  exportLog: () => Promise<string | null>;

  // WebView control
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

  // Browser profiles
  listBrowserProfiles: () => Promise<any[]>;
  importBrowserProfile: (browserKey: string, profileDir: string) => Promise<any>;
  switchBrowserProfile: (profileName: string) => Promise<any>;

  // Skills
  getSkillsDir: () => Promise<string>;
  skillsScan: () => Promise<Array<{ name: string; content: string }>>;
  skillWrite: (skillDirName: string, content: string) => Promise<{ success: boolean }>;
  skillDelete: (skillDirName: string) => Promise<{ success: boolean }>;

  // System
  restartApp: () => void;
  getPlatform: () => NodeJS.Platform;

  // Event listeners (return cleanup function)
  onWebviewNavigated: (callback: (id: string, url: string) => void) => () => void;
  onUrlUpdated: (callback: (url: string) => void) => () => void;
  onProtocolUrl: (callback: (url: string) => void) => () => void;
  onBackendReady: (callback: (data: { success: boolean; port?: number; error?: string }) => void) => () => void;

  // Generic
  removeAllListeners: (channel: string) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}

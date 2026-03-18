import { BrowserWindow } from "electron";
import path from "node:path";

interface CreateMainWindowOptions {
  preload: string;
  rendererUrl: string;
}

export function createWindowManager() {
  return {
    createMainWindow({ preload }: CreateMainWindowOptions) {
      return new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 720,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#0b1120",
        title: "Novaper",
        webPreferences: {
          preload: path.resolve(preload),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          webSecurity: true,
        },
      });
    },
  };
}

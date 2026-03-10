import type { AppProfile, WindowInfo } from "./types.js";
import { MemoryStore } from "./memoryStore.js";

/** Default app profiles for common Windows applications */
const DEFAULT_PROFILES: AppProfile[] = [
  {
    appName: "WeChat",
    processNames: ["WeChat.exe", "WeChatApp.exe"],
    windowTitlePatterns: ["微信", "WeChat"],
    knownBehaviors: [
      "Qt-based UI, UIA tree is unreliable",
      "Send button may require click or Enter/Ctrl+Enter",
      "Message delivery should be verified by checking input box cleared",
    ],
    preferredInteraction: "vision",
    complexity: "complex",
    memories: [],
  },
  {
    appName: "Chrome",
    processNames: ["chrome.exe"],
    windowTitlePatterns: ["Google Chrome", "Chrome"],
    knownBehaviors: [
      "Standard Chromium UIA support",
      "Tab switching via Ctrl+Tab or clicking tab",
      "Address bar accessible via Ctrl+L",
    ],
    preferredInteraction: "hybrid",
    complexity: "moderate",
    memories: [],
  },
  {
    appName: "WPS Office",
    processNames: ["wps.exe", "et.exe", "wpp.exe"],
    windowTitlePatterns: ["WPS", "金山文档"],
    knownBehaviors: [
      "Custom-drawn UI, UIA partially works",
      "Ribbon interface similar to MS Office",
      "File operations may trigger WPS cloud prompts",
    ],
    preferredInteraction: "hybrid",
    complexity: "complex",
    memories: [],
  },
  {
    appName: "Notepad",
    processNames: ["notepad.exe", "Notepad.exe"],
    windowTitlePatterns: ["记事本", "Notepad", "无标题"],
    knownBehaviors: ["Simple text editor with good UIA support"],
    preferredInteraction: "uia",
    complexity: "simple",
    memories: [],
  },
  {
    appName: "File Explorer",
    processNames: ["explorer.exe"],
    windowTitlePatterns: ["文件资源管理器", "File Explorer", "此电脑"],
    knownBehaviors: [
      "Good UIA support for navigation",
      "Address bar accessible for path input",
      "Right-click context menus work via UIA",
    ],
    preferredInteraction: "uia",
    complexity: "moderate",
    memories: [],
  },
  {
    appName: "Microsoft Edge",
    processNames: ["msedge.exe"],
    windowTitlePatterns: ["Microsoft Edge", "Edge"],
    knownBehaviors: [
      "Chromium-based, good UIA support",
      "Similar to Chrome interaction patterns",
    ],
    preferredInteraction: "hybrid",
    complexity: "moderate",
    memories: [],
  },
  {
    appName: "QQ",
    processNames: ["QQ.exe", "QQScLauncher.exe"],
    windowTitlePatterns: ["QQ"],
    knownBehaviors: [
      "Custom UI framework, UIA is very unreliable",
      "Prefer vision-based interaction",
    ],
    preferredInteraction: "vision",
    complexity: "complex",
    memories: [],
  },
];

/** Application-aware memory that detects and profiles foreground apps */
export class AppContextMemory {
  constructor(private readonly store: MemoryStore) {}

  /** Initialize default profiles if not already stored */
  async initDefaults(): Promise<void> {
    for (const profile of DEFAULT_PROFILES) {
      const existing = await this.store.loadAppProfile(profile.appName);
      if (!existing) {
        await this.store.saveAppProfile(profile);
      }
    }
  }

  /** Detect the current app from a list of windows */
  async detectApp(windows: WindowInfo[], foreground?: WindowInfo): Promise<AppProfile | null> {
    const target = foreground || windows.find((w) => w.isForeground);
    if (!target) return null;

    const profiles = await this.store.listAppProfiles();

    // Match by process name first
    for (const profile of profiles) {
      if (profile.processNames.some((pn) => target.processName.toLowerCase().includes(pn.toLowerCase()))) {
        return profile;
      }
    }

    // Match by window title patterns
    for (const profile of profiles) {
      if (profile.windowTitlePatterns.some((pat) => target.title.includes(pat))) {
        return profile;
      }
    }

    return null;
  }

  /** Get memory depth strategy based on app complexity */
  getMemoryDepth(profile: AppProfile): { maxEntries: number; trackConversation: boolean; trackDocumentState: boolean } {
    switch (profile.complexity) {
      case "simple":
        return { maxEntries: 5, trackConversation: false, trackDocumentState: false };
      case "moderate":
        return { maxEntries: 15, trackConversation: false, trackDocumentState: true };
      case "complex":
        return { maxEntries: 30, trackConversation: true, trackDocumentState: true };
    }
  }

  /** Build app-specific context string for prompt injection */
  buildAppContext(profile: AppProfile): string {
    const parts: string[] = [];
    parts.push(`[Active Application]: ${profile.appName}`);
    parts.push(`[Interaction Mode]: ${profile.preferredInteraction}`);

    if (profile.knownBehaviors.length > 0) {
      parts.push(`[Known Behaviors]:`);
      for (const behavior of profile.knownBehaviors) {
        parts.push(`  - ${behavior}`);
      }
    }

    if (profile.memories.length > 0) {
      parts.push(`[App-Specific Memories]:`);
      const recent = profile.memories
        .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))
        .slice(0, 5);
      for (const mem of recent) {
        parts.push(`  - ${mem.content}`);
      }
    }

    return parts.join("\n");
  }
}

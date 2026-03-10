import { promises as fs } from "node:fs";
import path from "node:path";

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  metadata?: unknown;
}

type LogSubscriber = (entry: LogEntry) => void;

const MAX_RING_SIZE = 10000;

export class LogCollector {
  private readonly ring: LogEntry[] = [];
  private readonly subscribers = new Set<LogSubscriber>();
  private readonly logsDir: string;
  private currentLogDate = "";
  private currentLogFile = "";
  private originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    info: typeof console.info;
  };

  constructor(logsDir: string) {
    this.logsDir = logsDir;
    this.originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
    };
  }

  async init(): Promise<void> {
    await fs.mkdir(this.logsDir, { recursive: true });
    this.interceptConsole();
  }

  private interceptConsole(): void {
    const self = this;

    console.log = (...args: unknown[]) => {
      self.originalConsole.log(...args);
      self.push("info", "console", formatArgs(args));
    };

    console.info = (...args: unknown[]) => {
      self.originalConsole.info(...args);
      self.push("info", "console", formatArgs(args));
    };

    console.warn = (...args: unknown[]) => {
      self.originalConsole.warn(...args);
      self.push("warn", "console", formatArgs(args));
    };

    console.error = (...args: unknown[]) => {
      self.originalConsole.error(...args);
      self.push("error", "console", formatArgs(args));
    };
  }

  push(level: LogEntry["level"], source: string, message: string, metadata?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      metadata,
    };

    this.ring.push(entry);
    if (this.ring.length > MAX_RING_SIZE) {
      this.ring.shift();
    }

    // Write to daily log file (fire-and-forget)
    void this.writeToDisk(entry);

    // Broadcast to SSE subscribers
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private async writeToDisk(entry: LogEntry): Promise<void> {
    const dateStr = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    if (dateStr !== this.currentLogDate) {
      this.currentLogDate = dateStr;
      this.currentLogFile = path.join(this.logsDir, `server-${dateStr}.jsonl`);
    }
    try {
      await fs.appendFile(this.currentLogFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // best effort
    }
  }

  getRecent(count?: number): LogEntry[] {
    const n = count ?? MAX_RING_SIZE;
    return this.ring.slice(-n);
  }

  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  async listFiles(): Promise<Array<{ name: string; size: number; modified: string }>> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.logsDir);
    } catch {
      return [];
    }

    const files: Array<{ name: string; size: number; modified: string }> = [];
    for (const name of entries.filter((n) => n.endsWith(".jsonl"))) {
      try {
        const stat = await fs.stat(path.join(this.logsDir, name));
        files.push({ name, size: stat.size, modified: stat.mtime.toISOString() });
      } catch {
        // skip
      }
    }
    return files.sort((a, b) => b.name.localeCompare(a.name));
  }

  async readFile(filename: string): Promise<string> {
    // Sanitize to prevent path traversal
    const safe = path.basename(filename);
    return fs.readFile(path.join(this.logsDir, safe), "utf8");
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

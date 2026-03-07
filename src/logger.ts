export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: string;
  details?: string;
}

type LogListener = (entry: LogEntry) => void;

class Logger {
  private logs: LogEntry[] = [];
  private listeners: Set<LogListener> = new Set();
  private maxLogs = 1000;

  info(message: string): void {
    this.addEntry("info", message);
  }

  warn(message: string): void {
    this.addEntry("warn", message);
  }

  error(message: string, error?: unknown): void {
    let details: string | undefined;
    if (error instanceof Error) {
      details = error.stack || error.message;
    } else if (error !== undefined) {
      details = String(error);
    }
    this.addEntry("error", message, details);
  }

  debug(message: string): void {
    this.addEntry("debug", message);
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getAll(): LogEntry[] {
    return [...this.logs];
  }

  getRecent(count: number): LogEntry[] {
    return this.logs.slice(-count);
  }

  clear(): void {
    this.logs = [];
  }

  private addEntry(
    level: LogEntry["level"],
    message: string,
    details?: string,
  ): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(details !== undefined && { details }),
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    for (const listener of this.listeners) {
      listener(entry);
    }

    const prefixes: Record<LogEntry["level"], string> = {
      info: "ℹ️",
      warn: "⚠️",
      error: "❌",
      debug: "🔍",
    };

    const prefix = prefixes[level];
    console.log(`${prefix} [${level.toUpperCase()}] ${message}`);
    if (details) {
      console.log(`   ${details}`);
    }
  }
}

export const logger = new Logger();

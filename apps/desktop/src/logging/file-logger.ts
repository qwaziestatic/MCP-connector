// A small log file for support. The packaged app has no visible console, so
// without it a startup failure leaves nothing to look at. Never log secrets:
// callers pass messages, not tokens or credentials.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_LOG_BYTES = 1_000_000;

export interface FileLogger {
  readonly path: string;
  readonly directory: string;
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function createFileLogger(directory: string, now: () => Date = () => new Date()): FileLogger {
  const path = join(directory, "main.log");
  try {
    mkdirSync(directory, { recursive: true });
    // Keep one older file instead of growing forever.
    if (statSync(path).size > MAX_LOG_BYTES) {
      renameSync(path, join(directory, "main.old.log"));
    }
  } catch {
    // No log yet, or the folder can't be created; logging must never stop the app.
  }
  // Synchronous, so the line is on disk even if the app exits right after.
  const write = (level: string, message: string): void => {
    try {
      appendFileSync(path, `${now().toISOString()} ${level} ${message}\n`, "utf8");
    } catch {
      // Ignore: a failing log must not cause a second failure.
    }
  };
  return {
    path,
    directory,
    info: (message) => write("INFO", message),
    error: (message, error) => write("ERROR", error === undefined ? message : `${message} ${describe(error)}`)
  };
}

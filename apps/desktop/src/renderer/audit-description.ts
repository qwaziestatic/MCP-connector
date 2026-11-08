// One short line for each audit record, saying what it was about. It is built
// from the stored preview, so it never shows a call's secrets or a file's
// contents: only the preview's summary and, for a call to another MCP server,
// the argument that names what it works on.
import type { AuditRecord } from "@mcp-connector/core";

const MAX_LENGTH = 120;
const MAX_ARGUMENT_LENGTH = 80;

/**
 * Arguments that usually name what a call works on, most telling first.
 * Compared without case, "_" or "-", so "file_path" and "filePath" both match.
 */
const TARGET_ARGUMENTS = [
  "path", "filepath", "file", "filename", "paths", "source", "destination", "target",
  "directory", "dir", "folder", "uri", "url", "repo", "repository", "name", "title", "query"
];

/** Never shown, whatever their value: they may hold a secret. */
const SECRET_ARGUMENT = /token|secret|passw|key|auth|credential|cookie|session|bearer/iu;

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** A web address without its query, fragment or user name and password, which can carry secrets. */
function withoutSecrets(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value.replace(/[?#].*$/u, "");
  }
}

/** Keeps the end of a long path, where the file's name is, rather than the start. */
function truncatePath(text: string, length: number): string {
  return text.length <= length ? text : `…${text.slice(text.length - length + 1)}`;
}

function argumentText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = oneLine(withoutSecrets(value));
    if (text.length === 0) return null;
    const isPath = /[\\/]/u.test(text) && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(text);
    return isPath ? truncatePath(text, MAX_ARGUMENT_LENGTH) : truncate(text, MAX_ARGUMENT_LENGTH);
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && value.length > 0) {
    const first = argumentText(value[0]);
    if (first === null) return null;
    return value.length === 1 ? first : `${first} (+${value.length - 1} more)`;
  }
  return null;
}

/** The argument that names what a call works on, as "key: value", or null. */
export function mainArgument(args: Json): string | null {
  const entries = Object.entries(args).filter(([key]) => !SECRET_ARGUMENT.test(key));
  for (const wanted of TARGET_ARGUMENTS) {
    const match = entries.find(([key]) => key.toLowerCase().replace(/[_-]/gu, "") === wanted);
    const text = match === undefined ? null : argumentText(match[1]);
    if (match !== undefined && text !== null) return `${match[0]}: ${text}`;
  }
  return null;
}

/** What the record was about, in one truncated line, or null if its preview can't be read. */
export function describeAuditRecord(record: Pick<AuditRecord, "previewJson">): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.previewJson);
  } catch {
    return null;
  }
  // Executed records store { preview, result }; the others store the preview.
  const preview = isObject(parsed) && isObject(parsed.preview) ? parsed.preview : parsed;
  if (!isObject(preview)) return null;

  const parts: string[] = [];
  if (typeof preview.summary === "string" && oneLine(preview.summary).length > 0) parts.push(oneLine(preview.summary));
  const payload = preview.payload;
  if (preview.action === "CALL" && isObject(payload) && isObject(payload.arguments)) {
    const argument = mainArgument(payload.arguments);
    if (argument !== null) parts.push(argument);
  }
  return parts.length === 0 ? null : truncate(parts.join(" · "), MAX_LENGTH);
}

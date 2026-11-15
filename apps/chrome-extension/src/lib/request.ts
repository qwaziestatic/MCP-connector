// The request format a web chat writes, and the checks every request passes
// before it may run: it must be one JSON object naming a tool that is ticked
// for this chat.
//
//   ```mcp-call
//   {"tool": "filesystem_inspect_workspace", "arguments": {}}
//   ```

export const CALL_LANGUAGE = "mcp-call";
export const RESULT_LANGUAGE = "mcp-result";
/** Longer requests are refused. MCP Connector itself refuses bodies over 1 MB. */
export const MAX_REQUEST_LENGTH = 100_000;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;

export interface ToolRequest {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ParsedRequest =
  | { readonly ok: true; readonly request: ToolRequest }
  | { readonly ok: false; readonly reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The inside of a fenced code block, or the text itself when it is not fenced. For requests pasted by hand. */
export function unfence(text: string): string {
  const fenced = /^\s*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n?[ \t]*\1[ \t]*\s*$/u.exec(text);
  return fenced === null ? text : fenced[2]!;
}

/**
 * Reads a request and checks it against the tools ticked for this chat. The
 * reason for a refusal is written for the user, who sees it in the panel.
 */
export function parseRequest(text: string, ticked: Iterable<string>): ParsedRequest {
  if (text.length > MAX_REQUEST_LENGTH) {
    return {
      ok: false,
      reason: `This request is too large: ${text.length.toLocaleString("en-US")} characters, and the limit is ${MAX_REQUEST_LENGTH.toLocaleString("en-US")}.`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "This request is not valid JSON." };
  }
  if (!isObject(parsed)) {
    return { ok: false, reason: 'A request must be one JSON object: {"tool": "...", "arguments": {...}}.' };
  }
  const unknown = Object.keys(parsed).find((key) => key !== "tool" && key !== "arguments");
  if (unknown !== undefined) {
    return { ok: false, reason: `A request may only have "tool" and "arguments", not "${unknown.slice(0, 40)}".` };
  }
  if (typeof parsed.tool !== "string" || !TOOL_NAME.test(parsed.tool)) {
    return { ok: false, reason: 'A request needs a "tool": the name of one tool.' };
  }
  const args = parsed.arguments ?? {};
  if (!isObject(args)) {
    return { ok: false, reason: '"arguments" must be a JSON object.' };
  }
  if (!new Set(ticked).has(parsed.tool)) {
    return { ok: false, reason: `"${parsed.tool}" is not ticked for this chat. Tick it in the list above to allow it.` };
  }
  return { ok: true, request: { tool: parsed.tool, arguments: args } };
}

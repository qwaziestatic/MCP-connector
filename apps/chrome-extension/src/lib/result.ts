// Reads what a tool call answered, and turns a result into the message that
// goes into the chat box.
import type { CallToolAnswer } from "./mcp-client.ts";
import { RESULT_LANGUAGE } from "./request.ts";

/** How much of a result goes into the chat. The rest is left out, and the message says so. */
export const RESULT_LIMIT = 20_000;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;
const PREVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ToolAnswer =
  /** Nothing ran: the request waits for the user's approval in MCP Connector. */
  | {
      readonly kind: "preview";
      readonly previewId: string;
      /** The tool MCP Connector names for running this preview once it is approved. */
      readonly executeTool: string;
      readonly summary: string;
    }
  | { readonly kind: "result"; readonly text: string; readonly isError: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(answer: CallToolAnswer): string {
  if (!Array.isArray(answer.content)) return "";
  return answer.content
    .map((item: unknown) => isObject(item) && item.type === "text" && typeof item.text === "string"
      ? item.text
      : `[${isObject(item) && typeof item.type === "string" ? item.type : "content"}]`)
    .join("\n");
}

/** Whether the answer is a preview that waits for approval, or the tool's result. */
export function readAnswer(answer: CallToolAnswer): ToolAnswer {
  const text = textOf(answer);
  const isError = answer.isError === true;
  let structured: unknown = answer.structuredContent;
  if (!isObject(structured)) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = undefined;
    }
  }
  if (!isError && isObject(structured) && structured.requiresApproval === true && isObject(structured.preview)) {
    const { id, summary } = structured.preview;
    const executeTool = structured.executeTool;
    if (typeof id !== "string" || !PREVIEW_ID.test(id) || typeof executeTool !== "string" || !TOOL_NAME.test(executeTool)) {
      return {
        kind: "result",
        isError: true,
        text: "MCP Connector asked for approval but did not say which tool runs the request afterwards. "
          + "Update MCP Connector, then try again."
      };
    }
    return { kind: "preview", previewId: id, executeTool, summary: typeof summary === "string" ? summary : "" };
  }
  return { kind: "result", text, isError };
}

export interface TrimmedResult {
  readonly text: string;
  readonly trimmed: boolean;
  readonly originalLength: number;
}

/** The start of the text, up to the limit, never ending in half a character. */
export function trimResult(text: string, limit = RESULT_LIMIT): TrimmedResult {
  if (text.length <= limit) return { text, trimmed: false, originalLength: text.length };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), trimmed: true, originalLength: text.length };
}

/**
 * The message for the chat box: the result in a fenced block labelled
 * mcp-result, with a note after it when the result was trimmed.
 */
export function formatResult(tool: string, result: string, limit = RESULT_LIMIT): string {
  const { text, trimmed, originalLength } = trimResult(result, limit);
  // A fence longer than any run of backticks in the result, so the result cannot end the block early.
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const note = trimmed
    ? `\n(The result was trimmed: this is the first ${text.length.toLocaleString("en-US")} of ${originalLength.toLocaleString("en-US")} characters.)`
    : "";
  return `Result of ${tool}:\n${fence}${RESULT_LANGUAGE}\n${text}\n${fence}${note}`;
}

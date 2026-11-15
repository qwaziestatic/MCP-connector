import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkflowPreview } from "../workflow/workflow.types.js";

export interface TextResult {
  readonly [key: string]: unknown;
  readonly content: [{ type: "text"; text: string }];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

/** An MCP tool result: the value as JSON text, and as structured content when it is an object. */
export function result(value: unknown): TextResult {
  const textResult: TextResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {
      ...textResult,
      structuredContent: value as Readonly<Record<string, unknown>>
    };
  }
  return textResult;
}

/**
 * What every tool that makes a preview answers. `executeTool` names the tool
 * that runs the preview once the user approved it, so a client can finish an
 * approved preview without knowing each tool by name.
 */
export function previewResult(
  preview: WorkflowPreview,
  executeTool: string,
  next?: string
): TextResult {
  return result({
    requiresApproval: true,
    preview,
    executeTool,
    ...(next === undefined ? {} : { next })
  });
}

/** How much of a result the audit log keeps; the caller still gets all of it. */
const AUDIT_TEXT_LIMIT = 2000;

/** A tool result's text, with anything that is not text named by its type. */
export function textOf(callResult: CallToolResult): string {
  return callResult.content
    .map((item) => item.type === "text" ? item.text : `[${item.type}]`)
    .join("\n");
}

/** The shortened copy of a result that the audit log keeps. */
export function auditCopy(callResult: CallToolResult): { readonly text: string } {
  const text = textOf(callResult);
  return { text: text.length > AUDIT_TEXT_LIMIT ? `${text.slice(0, AUDIT_TEXT_LIMIT)}…` : text };
}

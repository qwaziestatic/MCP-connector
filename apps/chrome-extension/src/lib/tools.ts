// Which tools a chat may be given, and which of them the user ticked for it.
import type { McpTool } from "./mcp-client.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a tool only follows or finishes a preview: its one input is the
 * previewId. MCP Connector's status tool and every tool that runs an approved
 * preview have this shape. The extension calls them itself, with the name MCP
 * Connector gives it, so they are never offered to a chat, and no list of
 * their names is kept here.
 */
export function isPreviewTool(tool: McpTool): boolean {
  const schema = tool.inputSchema;
  if (!isObject(schema) || !isObject(schema.properties)) return false;
  const inputs = Object.keys(schema.properties);
  return inputs.length === 1 && inputs[0] === "previewId"
    && Array.isArray(schema.required) && schema.required.includes("previewId");
}

/** The tools the user can tick for a chat. */
export function offeredTools(tools: readonly McpTool[]): McpTool[] {
  return tools.filter((tool) => !isPreviewTool(tool));
}

/** The chat a ChatGPT address belongs to, or null for a chat that has no address yet. */
export function chatIdOf(pathname: string): string | null {
  return /\/c\/([A-Za-z0-9-]{1,100})(?:\/|$)/u.exec(pathname)?.[1] ?? null;
}

/** The tools ticked in one tab, and the chat they were ticked for. */
export interface StoredTicks {
  readonly chatId: string | null;
  readonly tools: readonly string[];
}

/**
 * The ticks that apply to the chat now open in a tab. Ticks belong to one
 * chat: opening another chat in the tab starts with none ticked. A new chat
 * has no address until its first message is sent, so ticks made before that
 * stay with the chat when it gets one.
 */
export function ticksForChat(stored: StoredTicks | undefined, chatId: string | null): StoredTicks {
  if (stored === undefined) return { chatId, tools: [] };
  if (stored.chatId === chatId) return stored;
  if (stored.chatId === null) return { chatId, tools: stored.tools };
  return { chatId, tools: [] };
}

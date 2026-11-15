// The messages between the extension's parts, and the checks on who sent them.
//
// Only the extension's own pages (the side panel and the options page) may
// ask the background worker for anything. The content script runs inside the
// ChatGPT page: it may tell the panel what it sees and put text in the chat
// box, and nothing else. What it reports is read as untrusted text.
import { MAX_REQUEST_LENGTH } from "./request.ts";

/** One finished mcp-call block the content script found. */
export interface PageBlock {
  /** Stable for the same block in the same message. */
  readonly id: string;
  readonly text: string;
}

/** What the content script tells the panel about the page. */
export interface PageState {
  readonly type: "page-state";
  readonly chatId: string | null;
  /** False when the page's chat box was not found, so the selectors no longer fit. */
  readonly recognised: boolean;
  readonly blocks: readonly PageBlock[];
}

/** What the panel may ask the content script to do. */
export type PageCommand =
  | { readonly type: "get-page-state" }
  | { readonly type: "insert-text"; readonly text: string };

export const MAX_PAGE_BLOCKS = 5;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a report from the content script, and returns null for anything else. */
export function readPageState(value: unknown): PageState | null {
  if (!isObject(value) || value.type !== "page-state" || !Array.isArray(value.blocks)) return null;
  const chatId = typeof value.chatId === "string" && /^[A-Za-z0-9-]{1,100}$/u.test(value.chatId) ? value.chatId : null;
  const blocks: PageBlock[] = [];
  for (const block of value.blocks.slice(0, MAX_PAGE_BLOCKS)) {
    if (!isObject(block) || typeof block.id !== "string" || typeof block.text !== "string") continue;
    // One character over the limit is kept, so the request parser can say it is too large.
    blocks.push({ id: block.id.slice(0, 200), text: block.text.slice(0, MAX_REQUEST_LENGTH + 1) });
  }
  return { type: "page-state", chatId, recognised: value.recognised === true, blocks };
}

/** Who sent a message, as Chrome reports it. */
export interface Sender {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
}

/**
 * Whether a message came from one of this extension's own pages. A content
 * script's messages carry the address of the page it runs in, so they never
 * pass, whatever the page makes the content script do.
 */
export function isExtensionPage(sender: Sender, extensionId: string, extensionUrl: string): boolean {
  return sender.id === extensionId && typeof sender.url === "string" && sender.url.startsWith(extensionUrl);
}

/** Whether a message came from this extension's content script in the given tab. */
export function isContentScriptOf(sender: Sender, extensionId: string, tabId: number): boolean {
  return sender.id === extensionId && sender.tab?.id === tabId
    && typeof sender.url === "string" && sender.url.startsWith("https://chatgpt.com/");
}

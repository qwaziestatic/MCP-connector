// Everything this extension knows about the ChatGPT page is in this file.
// When ChatGPT changes its page, this is the only file to fix. If these stop
// matching, the panel says so and still works by hand: "Paste a request" and
// "Copy result" need nothing from the page.
import { CALL_LANGUAGE } from "./lib/request.ts";

export const SELECTORS = {
  /** One reply from the assistant. */
  assistantMessage: '[data-message-author-role="assistant"]',
  /** The attribute holding a message's id. */
  messageId: "data-message-id",
  /** A code block in a reply. */
  codeBlock: "pre",
  /** The code inside a code block, in the page's old and new code viewers. */
  code: ["code", ".cm-content"],
  /** Shown while a reply is still being written. */
  generating: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]'
  ],
  /** The chat box, most specific first. */
  composer: [
    "#prompt-textarea",
    'form [contenteditable="true"]',
    "form textarea"
  ]
} as const;

function first(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found !== null) return found;
  }
  return null;
}

/** The newest reply, or null when the chat has none. */
export function newestAssistantMessage(root: ParentNode): Element | null {
  const messages = root.querySelectorAll(SELECTORS.assistantMessage);
  return messages.length === 0 ? null : messages[messages.length - 1]!;
}

export function messageIdOf(message: Element): string | null {
  return message.getAttribute(SELECTORS.messageId);
}

/** Whether a reply is still being written. */
export function isGenerating(root: ParentNode): boolean {
  return first(root, SELECTORS.generating) !== null;
}

export function findComposer(root: ParentNode): HTMLElement | null {
  return first(root, SELECTORS.composer);
}

/**
 * Whether a code block's language tag is mcp-call. The page puts the tag in
 * the code's class ("language-mcp-call") and shows it in the block's header;
 * either is enough.
 */
function isCallBlock(block: Element, code: Element): boolean {
  if (code.classList.contains(`language-${CALL_LANGUAGE}`)) return true;
  for (const label of block.querySelectorAll("div, span")) {
    if (code.contains(label) || label.contains(code)) continue;
    if (label.childElementCount === 0 && label.textContent?.trim().toLowerCase() === CALL_LANGUAGE) return true;
  }
  return false;
}

/** The mcp-call blocks in one reply, with the element to highlight and the request's text. */
export function callBlocks(message: Element): Array<{ readonly element: HTMLElement; readonly text: string }> {
  const blocks: Array<{ element: HTMLElement; text: string }> = [];
  for (const block of message.querySelectorAll<HTMLElement>(SELECTORS.codeBlock)) {
    const code = first(block, SELECTORS.code);
    if (code !== null && isCallBlock(block, code)) {
      blocks.push({ element: block, text: code.textContent ?? "" });
    }
  }
  return blocks;
}

/**
 * Puts text at the end of the chat box, as if it were pasted, and reports
 * whether it arrived. It never sends the message: the user presses Send.
 */
export function insertIntoComposer(composer: HTMLElement, text: string): boolean {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const value = composer.value.length === 0 ? text : `${composer.value}\n\n${text}`;
    // The page's framework watches the element's own setter, so use the prototype's.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(composer, value);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return composer.value.includes(text);
  }

  const selection = window.getSelection();
  selection?.selectAllChildren(composer);
  selection?.collapseToEnd();
  const arrived = (): boolean => {
    // Compared without whitespace: the editor splits the text into paragraphs.
    const probe = text.replace(/\s+/gu, "").slice(0, 40);
    return (composer.textContent ?? "").replace(/\s+/gu, "").includes(probe);
  };
  // The editor handles a paste itself and keeps the line breaks.
  const data = new DataTransfer();
  data.setData("text/plain", text);
  composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  if (arrived()) return true;
  // Otherwise type it in, which every editable element accepts.
  document.execCommand("insertText", false, text);
  return arrived();
}

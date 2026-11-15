// Runs inside the ChatGPT page. It does three things and no more:
//   - finds finished mcp-call blocks in the newest reply and outlines them,
//   - tells the side panel what it found, and
//   - puts text in the chat box when the side panel asks.
//
// It cannot run a tool. The background worker answers only the extension's
// own pages, and this script never has the browser key. A request runs when
// the user clicks Run in the side panel, which the page cannot reach.
import { isExtensionPage, MAX_PAGE_BLOCKS, type PageCommand, type PageState } from "./lib/messages.ts";
import { MAX_REQUEST_LENGTH } from "./lib/request.ts";
import { chatIdOf } from "./lib/tools.ts";
import { callBlocks, findComposer, insertIntoComposer, isGenerating, messageIdOf, newestAssistantMessage } from "./selectors.ts";

const HIGHLIGHT_CLASS = "mcp-connector-call";
const SCAN_DELAY_MS = 400;
/** Catches what leaves no trace in the page, such as moving to another chat. */
const RESCAN_INTERVAL_MS = 1_500;

function addHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_CLASS) !== null) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_CLASS;
  style.textContent = `.${HIGHLIGHT_CLASS} { outline: 2px solid #4f9cf9; outline-offset: 3px; border-radius: 10px; }`;
  document.head.append(style);
}

/** A short fingerprint, so an edited block counts as a new one. */
function fingerprint(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

function readPage(): PageState {
  const message = newestAssistantMessage(document);
  // A block is finished once the reply is no longer being written.
  const found = message === null || isGenerating(document) ? [] : callBlocks(message).slice(0, MAX_PAGE_BLOCKS);
  for (const stale of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
    if (!found.some((block) => block.element === stale)) stale.classList.remove(HIGHLIGHT_CLASS);
  }
  const messageId = message === null ? null : messageIdOf(message);
  return {
    type: "page-state",
    chatId: chatIdOf(location.pathname),
    recognised: findComposer(document) !== null,
    blocks: found.map(({ element, text }, index) => {
      element.classList.add(HIGHLIGHT_CLASS);
      // One character over the limit, so the panel can say the request is too large.
      const request = text.trim().slice(0, MAX_REQUEST_LENGTH + 1);
      return { id: `${messageId ?? "reply"}:${index}:${fingerprint(request)}`, text: request };
    })
  };
}

let lastReport = "";
let scanTimer: number | undefined;
let stopped = false;

function report(): void {
  if (stopped) return;
  const state = readPage();
  const serialised = JSON.stringify(state);
  if (serialised === lastReport) return;
  lastReport = serialised;
  try {
    // Nobody answers this: the panel reads it if it is open.
    chrome.runtime.sendMessage(state).catch(() => undefined);
  } catch {
    // The extension was reloaded or removed; this copy of the script is orphaned.
    stop();
  }
}

function scheduleScan(): void {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(report, SCAN_DELAY_MS);
}

const observer = new MutationObserver(scheduleScan);
const interval = window.setInterval(report, RESCAN_INTERVAL_MS);

function stop(): void {
  stopped = true;
  observer.disconnect();
  window.clearInterval(interval);
  window.clearTimeout(scanTimer);
}

chrome.runtime.onMessage.addListener((message: PageCommand, sender, sendResponse) => {
  // Only the extension's own pages may ask; another tab's content script may not.
  if (!isExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return false;
  if (message?.type === "get-page-state") {
    const state = readPage();
    lastReport = JSON.stringify(state);
    sendResponse(state);
  } else if (message?.type === "insert-text" && typeof message.text === "string") {
    const composer = findComposer(document);
    sendResponse({ ok: composer !== null && insertIntoComposer(composer, message.text) });
  }
  return false;
});

addHighlightStyle();
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
scheduleScan();

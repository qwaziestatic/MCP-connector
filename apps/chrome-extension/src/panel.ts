// The side panel. Everything the user decides happens here: which tools a
// chat may use, and the Run button for each request. The ChatGPT page cannot
// reach this page, so it cannot click Run.
import { ask, button, element, messageOf } from "./ask.ts";
import { advance, describe, follow, INITIAL_STATE, isFinished, outcomeText, type RunState } from "./lib/approval.ts";
import { buildInstructions } from "./lib/instructions.ts";
import { RELEASES_URL, type McpTool } from "./lib/mcp-client.ts";
import { isContentScriptOf, readPageState, type PageCommand, type PageState } from "./lib/messages.ts";
import { parseRequest, unfence } from "./lib/request.ts";
import { formatResult, type ToolAnswer } from "./lib/result.ts";
import { describeStatus } from "./lib/status.ts";
import { chatIdOf } from "./lib/tools.ts";
import type { ConnectionStatus } from "./lib/worker.ts";

/** One request, found in the chat or pasted, and how far it got. */
interface Card {
  readonly id: string;
  readonly text: string;
  readonly origin: "chat" | "pasted";
  /** Null until the user clicks Run. */
  state: RunState | null;
  /** The tool it ran, kept for the result's heading. */
  tool: string;
}

const RESULT_PREVIEW_LENGTH = 2_000;

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusLine = byId("status");
const statusActions = byId("status-actions");
const noChat = byId("no-chat");
const toolsSection = byId("tools-section");
const toolList = byId("tools");
const insertButton = byId<HTMLButtonElement>("insert-instructions");
const notice = byId("notice");
const requestsSection = byId("requests-section");
const pageNote = byId("page-note");
const requestList = byId("requests");
const pasteText = byId<HTMLTextAreaElement>("paste-text");
const pasteDetails = byId<HTMLDetailsElement>("paste");

let status: ConnectionStatus | null = null;
/** The ChatGPT tab this panel is showing, or null when the active tab is something else. */
let tabId: number | null = null;
let chatId: string | null = null;
let ticked: string[] = [];
/** Whether the content script answered, and whether it recognised the page. */
let pageReachable = false;
let pageRecognised = false;
/** Each tab's requests, newest first. They are cleared when the tab moves to another chat. */
const cardsByTab = new Map<number, Card[]>();
/** The chat each tab last showed, so a move is noticed even if this panel was showing another tab. */
const chatByTab = new Map<number, string | null>();
let pastedCount = 0;

const tools = (): readonly McpTool[] => status?.state === "connected" ? status.tools : [];
const cards = (): Card[] => tabId === null ? [] : cardsByTab.get(tabId) ?? [];

function say(text: string | null): void {
  notice.hidden = text === null;
  notice.textContent = text ?? "";
}

// ---------------------------------------------------------------- the page

async function toPage<T>(command: PageCommand): Promise<T | null> {
  if (tabId === null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, command) as T;
  } catch {
    // No content script in the tab: it was open before the extension was installed or reloaded.
    return null;
  }
}

/** What the panel says after handing something to the chat. */
const HANDED_OVER = {
  result: {
    inChatBox: "The result is in the chat box. Read it, then press Send.",
    copied: "The result was copied. Paste it into the chat box, then press Send.",
    notCopied: "The result could not be copied. Select it here and copy it by hand."
  },
  instructions: {
    inChatBox: "The instructions are in the chat box. Read them, then press Send.",
    copied: "The chat box could not be filled, so the instructions were copied. Paste them into the chat box, then press Send.",
    notCopied: "The instructions could not be put in the chat box or copied."
  }
} as const;
type Handed = keyof typeof HANDED_OVER;

/** Puts text in the chat box, or copies it when the chat box cannot be reached. It never sends the message. */
async function giveToChat(text: string, what: Handed): Promise<void> {
  const answer = await toPage<{ ok: boolean }>({ type: "insert-text", text });
  if (answer?.ok === true) {
    say(HANDED_OVER[what].inChatBox);
    return;
  }
  await copy(text, what);
}

async function copy(text: string, what: Handed): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    say(HANDED_OVER[what].copied);
  } catch {
    say(HANDED_OVER[what].notCopied);
  }
}

async function applyPageState(state: PageState): Promise<void> {
  if (tabId === null) return;
  pageReachable = true;
  pageRecognised = state.recognised;
  await moveToChat(state.chatId);
  const list = cardsByTab.get(tabId) ?? [];
  for (const block of state.blocks) {
    if (!list.some((card) => card.id === block.id)) {
      list.unshift({ id: block.id, text: block.text, origin: "chat", state: null, tool: "" });
    }
  }
  cardsByTab.set(tabId, list);
  render();
}

/** Follows the tab to another chat. Ticks and requests belong to one chat. */
async function moveToChat(next: string | null): Promise<void> {
  if (tabId === null) return;
  const previous = chatByTab.get(tabId);
  // A new chat gets its address with its first message; it is still the same chat.
  const sameChat = previous === undefined || previous === next || previous === null;
  chatByTab.set(tabId, next);
  chatId = next;
  if (!sameChat) cardsByTab.delete(tabId);
  if (status?.state === "connected") {
    ticked = await ask<string[]>({ type: "get-ticks", tabId, chatId }).catch(() => []);
  }
}

async function bindToActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Chrome gives this extension a tab's address only for chatgpt.com.
  const isChat = tab?.id !== undefined && typeof tab.url === "string" && tab.url.startsWith("https://chatgpt.com/");
  const nextTab = isChat ? tab.id! : null;
  if (nextTab !== tabId) {
    tabId = nextTab;
    chatId = nextTab === null ? null : chatByTab.get(nextTab) ?? null;
    ticked = [];
    say(null);
  }
  pageReachable = false;
  pageRecognised = false;
  if (tabId !== null) {
    const state = readPageState(await toPage<unknown>({ type: "get-page-state" }));
    if (state !== null) {
      await applyPageState(state);
      return;
    }
    await moveToChat(chatIdOf(new URL(tab!.url!).pathname));
  }
  render();
}

// ---------------------------------------------------------------- running

async function run(card: Card): Promise<void> {
  if (tabId === null) return;
  const parsed = parseRequest(card.text, ticked);
  if (!parsed.ok) return;
  card.tool = parsed.request.tool;
  card.state = INITIAL_STATE;
  render();
  let first: RunState;
  try {
    // The worker checks the request again, against the ticks it keeps itself.
    const answer = await ask<ToolAnswer>({ type: "run", tabId, chatId, text: card.text });
    first = advance(INITIAL_STATE, { type: "answer", answer });
  } catch (error) {
    first = advance(INITIAL_STATE, { type: "error", message: messageOf(error) });
  }
  await followCard(card, first);
}

async function followCard(card: Card, state: RunState): Promise<void> {
  await follow(state, {
    status: (previewId) => ask<string>({ type: "preview-status", previewId }),
    execute: (previewId) => ask<ToolAnswer>({ type: "finish-preview", previewId }),
    wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    onState: (next) => {
      card.state = next;
      render();
    }
  });
}

function dismiss(card: Card): void {
  if (tabId === null) return;
  cardsByTab.set(tabId, cards().filter((other) => other !== card));
  render();
}

// ---------------------------------------------------------------- drawing

function renderStatus(): void {
  if (status === null) return;
  const line = describeStatus(status);
  statusLine.textContent = line.text;
  statusLine.className = line.ok ? "status ok" : "status problem";
  statusActions.replaceChildren();
  if (line.actions.includes("options")) {
    statusActions.append(button("Open options", () => void chrome.runtime.openOptionsPage(), "primary"));
  }
  if (line.actions.includes("retry")) statusActions.append(button("Check again", () => void refreshStatus()));
  if (line.actions.includes("releases")) {
    const link = element("a", { text: "Get MCP Connector" });
    link.href = RELEASES_URL;
    link.target = "_blank";
    link.rel = "noreferrer";
    statusActions.append(link);
  }
}

function renderTools(): void {
  toolList.replaceChildren(...tools().map((tool) => {
    const box = element("input");
    box.type = "checkbox";
    box.checked = ticked.includes(tool.name);
    box.addEventListener("change", () => {
      const wanted = box.checked ? [...ticked, tool.name] : ticked.filter((name) => name !== tool.name);
      if (tabId === null) return;
      void ask<string[]>({ type: "set-ticks", tabId, chatId, tools: wanted })
        .then((saved) => { ticked = saved; })
        .catch((error: unknown) => say(messageOf(error)))
        .finally(render);
    });
    const text = element("span", {}, [
      element("strong", { text: tool.name }),
      element("span", { className: "muted small", text: tool.description ?? tool.title ?? "" })
    ]);
    return element("label", { className: "tool" }, [box, text]);
  }));
  if (tools().length === 0) toolList.append(element("p", { className: "muted", text: "MCP Connector offers no tools right now." }));
  insertButton.disabled = ticked.length === 0;
}

function renderCard(card: Card): HTMLElement {
  const parsed = parseRequest(card.text, ticked);
  const title = parsed.ok ? parsed.request.tool : card.tool.length > 0 ? card.tool : "Request";
  const body = parsed.ok ? JSON.stringify(parsed.request.arguments, null, 2) : card.text.slice(0, RESULT_PREVIEW_LENGTH);
  const node = element("article", { className: "card" }, [
    element("div", { className: "card-heading" }, [
      element("strong", { text: title }),
      element("span", { className: "muted small", text: card.origin === "chat" ? "From the chat" : "Pasted" })
    ]),
    element("pre", { text: body })
  ]);
  const actions = element("div", { className: "actions" });

  if (card.state === null) {
    if (parsed.ok) {
      actions.append(button("Run", () => void run(card), "primary"));
    } else {
      node.append(element("p", { className: "status problem", text: parsed.reason }));
    }
    actions.append(button("Dismiss", () => dismiss(card), "quiet"));
  } else {
    const state = card.state;
    node.append(element("p", {
      className: state.phase === "done" && !state.isError ? "status ok"
        : state.phase === "rejected" || state.phase === "failed" || state.phase === "done" ? "status problem" : "status waiting",
      text: describe(state)
    }));
    if (state.phase === "paused") {
      actions.append(button("Keep waiting", () => void followCard(card, advance(state, { type: "keep-waiting" })), "primary"));
    }
    const outcome = outcomeText(state);
    if (outcome !== null) {
      if (state.phase === "done") {
        const shown = outcome.length > RESULT_PREVIEW_LENGTH ? `${outcome.slice(0, RESULT_PREVIEW_LENGTH)}…` : outcome;
        node.append(element("pre", { className: "result", text: shown }));
      }
      const message = formatResult(card.tool, outcome);
      actions.append(
        button("Put result in chat box", () => void giveToChat(message, "result"), "primary"),
        button("Copy result", () => void copy(message, "result"))
      );
    }
    if (isFinished(state)) actions.append(button("Dismiss", () => dismiss(card), "quiet"));
  }
  node.append(actions);
  return node;
}

function renderRequests(): void {
  requestList.replaceChildren(...cards().map(renderCard));
  if (!pageReachable) {
    pageNote.textContent = "This tab was open before the extension was ready, so requests in the chat are not picked up. "
      + "Reload the tab, or use Paste a request and Copy result.";
  } else if (!pageRecognised) {
    pageNote.textContent = "The ChatGPT page looks different from what this extension knows, so it may miss requests "
      + "and cannot fill the chat box. Use Paste a request and Copy result.";
  } else if (cards().length === 0) {
    pageNote.textContent = "When the chat writes a request, it appears here with a Run button. Nothing runs before you click it.";
  } else {
    pageNote.textContent = "Check each request before you run it. Nothing runs before you click Run.";
  }
  // Working by hand is always possible; it is opened when the page cannot be read.
  if (!pageReachable || !pageRecognised) pasteDetails.open = true;
}

function render(): void {
  renderStatus();
  const connected = status?.state === "connected";
  noChat.hidden = !connected || tabId !== null;
  toolsSection.hidden = !connected || tabId === null;
  requestsSection.hidden = !connected || tabId === null;
  if (connected && tabId !== null) {
    renderTools();
    renderRequests();
  }
}

async function refreshStatus(): Promise<void> {
  statusLine.textContent = "Checking…";
  statusLine.className = "status";
  try {
    status = await ask<ConnectionStatus>({ type: "get-status" });
  } catch (error) {
    status = { state: "error", port: 0, message: messageOf(error) };
  }
  if (status.state === "connected" && tabId !== null) {
    ticked = await ask<string[]>({ type: "get-ticks", tabId, chatId }).catch(() => []);
  }
  render();
}

// ---------------------------------------------------------------- events

insertButton.addEventListener("click", () => {
  const chosen = tools().filter((tool) => ticked.includes(tool.name));
  if (chosen.length > 0) void giveToChat(buildInstructions(chosen), "instructions");
});

byId("paste-add").addEventListener("click", () => {
  const text = unfence(pasteText.value).trim();
  if (text.length === 0 || tabId === null) return;
  pastedCount += 1;
  cardsByTab.set(tabId, [{ id: `pasted:${pastedCount}`, text, origin: "pasted", state: null, tool: "" }, ...cards()]);
  pasteText.value = "";
  render();
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  // Reports from the content script of the tab this panel shows, read as untrusted text.
  if (tabId === null || !isContentScriptOf(sender, chrome.runtime.id, tabId)) return;
  const state = readPageState(message);
  if (state !== null) void applyPageState(state);
});

chrome.tabs.onActivated.addListener(() => void bindToActiveTab());
chrome.tabs.onRemoved.addListener((closed) => {
  cardsByTab.delete(closed);
  chatByTab.delete(closed);
});
chrome.tabs.onUpdated.addListener((updated, change) => {
  if (updated === tabId || change.status === "complete") void bindToActiveTab();
});
window.addEventListener("focus", () => void refreshStatus());

void bindToActiveTab().then(refreshStatus);

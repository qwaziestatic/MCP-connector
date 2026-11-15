// What the background service worker does for the extension's own pages. It
// is the only part that holds the browser key and the only part that talks to
// MCP Connector, and it decides for itself whether a request may run: the
// tool must be ticked for the chat, and an approved preview is finished only
// with the tool MCP Connector named for it.
//
// The worker keeps nothing in memory between messages, because Chrome stops
// it when it is idle. The panel drives the waiting; each step is one message.
import {
  callTool,
  ConnectionError,
  DEFAULT_PORT,
  isValidBrowserKey,
  isValidPort,
  listTools,
  type ClientOptions,
  type ConnectionProblem,
  type McpTool,
  type Pairing
} from "./mcp-client.ts";
import { parseRequest } from "./request.ts";
import { readAnswer, type ToolAnswer } from "./result.ts";
import { isPreviewTool, offeredTools, ticksForChat, type StoredTicks } from "./tools.ts";

/** The tool that reports a preview's status. It is part of MCP Connector's approval steps. */
export const STATUS_TOOL = "workflow_preview_status";

/** A small key-value store: chrome.storage.local or chrome.storage.session. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface WorkerOptions {
  /** Kept across browser restarts: the pairing. Not readable by content scripts. */
  readonly saved: KeyValueStore;
  /** Kept in memory until the browser closes: ticks and waiting previews. */
  readonly session: KeyValueStore;
  readonly client?: ClientOptions;
}

export type ConnectionStatus =
  | { readonly state: "not-paired"; readonly port: number }
  | { readonly state: "connected"; readonly port: number; readonly tools: readonly McpTool[] }
  | { readonly state: ConnectionProblem; readonly port: number }
  | { readonly state: "error"; readonly port: number; readonly message: string };

/** What the extension's pages may ask the worker. */
export type WorkerRequest =
  | { readonly type: "get-status" }
  | { readonly type: "save-pairing"; readonly browserKey: string; readonly port: number }
  | { readonly type: "forget-pairing" }
  | { readonly type: "get-ticks"; readonly tabId: number; readonly chatId: string | null }
  | { readonly type: "set-ticks"; readonly tabId: number; readonly chatId: string | null; readonly tools: readonly string[] }
  | { readonly type: "run"; readonly tabId: number; readonly chatId: string | null; readonly text: string }
  | { readonly type: "preview-status"; readonly previewId: string }
  | { readonly type: "finish-preview"; readonly previewId: string };

export type WorkerReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const PAIRING_KEY = "pairing";
const TOOLS_KEY = "tools";
const ticksKey = (tabId: number): string => `ticks:${tabId}`;
const previewKey = (previewId: string): string => `preview:${previewId}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTabId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("This message names no tab.");
  return value;
}

function asChatId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/u.test(value) ? value : null;
}

function asPreviewId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) throw new Error("This message names no preview.");
  return value;
}

export function createWorker(options: WorkerOptions): { handle(message: unknown): Promise<unknown>; forgetTab(tabId: number): Promise<void> } {
  const { saved, session, client = {} } = options;

  const readPairing = async (): Promise<Pairing | null> => {
    const stored = await saved.get(PAIRING_KEY);
    return isObject(stored) && isValidBrowserKey(stored.browserKey) && isValidPort(stored.port)
      ? { browserKey: stored.browserKey, port: stored.port }
      : null;
  };

  const requirePairing = async (): Promise<Pairing> => {
    const pairing = await readPairing();
    if (pairing === null) throw new Error("Paste MCP Connector's browser key in this extension's options first.");
    return pairing;
  };

  /** Lists the server's tools and remembers them for this browser session. */
  const refreshTools = async (pairing: Pairing): Promise<McpTool[]> => {
    const tools = await listTools(pairing, client);
    await session.set(TOOLS_KEY, tools);
    return tools;
  };

  const knownTools = async (pairing: Pairing): Promise<readonly McpTool[]> => {
    const cached = await session.get(TOOLS_KEY);
    return Array.isArray(cached) ? cached as McpTool[] : refreshTools(pairing);
  };

  const status = async (): Promise<ConnectionStatus> => {
    const pairing = await readPairing();
    if (pairing === null) return { state: "not-paired", port: DEFAULT_PORT };
    try {
      return { state: "connected", port: pairing.port, tools: offeredTools(await refreshTools(pairing)) };
    } catch (error) {
      await session.remove(TOOLS_KEY);
      if (error instanceof ConnectionError) return { state: error.problem, port: pairing.port };
      return { state: "error", port: pairing.port, message: error instanceof Error ? error.message : String(error) };
    }
  };

  /** The ticks for the chat now open in the tab, saved so the next message agrees. */
  const currentTicks = async (tabId: number, chatId: string | null): Promise<StoredTicks> => {
    const stored = await session.get(ticksKey(tabId));
    const ticks = ticksForChat(isObject(stored) && Array.isArray(stored.tools) ? stored as unknown as StoredTicks : undefined, chatId);
    await session.set(ticksKey(tabId), ticks);
    return ticks;
  };

  const waitingPreview = async (previewId: string): Promise<{ executeTool: string }> => {
    const record = await session.get(previewKey(previewId));
    if (!isObject(record) || typeof record.executeTool !== "string") {
      throw new Error("This extension is not waiting for that request.");
    }
    return { executeTool: record.executeTool };
  };

  const handle = async (message: unknown): Promise<unknown> => {
    if (!isObject(message) || typeof message.type !== "string") throw new Error("This message could not be read.");
    switch (message.type as WorkerRequest["type"]) {
      case "get-status":
        return status();

      case "save-pairing": {
        const browserKey = typeof message.browserKey === "string" ? message.browserKey.trim() : "";
        if (!isValidBrowserKey(browserKey)) {
          throw new Error("That does not look like a browser key. Copy it from MCP Connector, under Web chats.");
        }
        if (!isValidPort(message.port)) throw new Error("The port must be a number from 1 to 65535.");
        await saved.set(PAIRING_KEY, { browserKey, port: message.port } satisfies Pairing);
        return status();
      }

      case "forget-pairing":
        await saved.remove(PAIRING_KEY);
        await session.remove(TOOLS_KEY);
        return status();

      case "get-ticks":
        return (await currentTicks(asTabId(message.tabId), asChatId(message.chatId))).tools;

      case "set-ticks": {
        const tabId = asTabId(message.tabId);
        const chatId = asChatId(message.chatId);
        const wanted = Array.isArray(message.tools) ? message.tools.filter((tool): tool is string => typeof tool === "string") : [];
        // Only tools the server offers to chats can be ticked.
        const offered = new Set(offeredTools(await knownTools(await requirePairing())).map((tool) => tool.name));
        const tools = [...new Set(wanted)].filter((tool) => offered.has(tool));
        await session.set(ticksKey(tabId), { chatId, tools } satisfies StoredTicks);
        return tools;
      }

      case "run": {
        const pairing = await requirePairing();
        const ticks = await currentTicks(asTabId(message.tabId), asChatId(message.chatId));
        const parsed = parseRequest(typeof message.text === "string" ? message.text : "", ticks.tools);
        if (!parsed.ok) throw new Error(parsed.reason);
        const answer: ToolAnswer = readAnswer(await callTool(pairing, parsed.request.tool, parsed.request.arguments, client));
        if (answer.kind === "preview") {
          // The tool MCP Connector names must be one it offers for running previews.
          const executor = (await knownTools(pairing)).find((tool) => tool.name === answer.executeTool)
            ?? (await refreshTools(pairing)).find((tool) => tool.name === answer.executeTool);
          if (executor === undefined || !isPreviewTool(executor)) {
            throw new Error("MCP Connector named a tool for running this request that it does not offer. Nothing ran.");
          }
          await session.set(previewKey(answer.previewId), { executeTool: answer.executeTool });
        }
        return answer;
      }

      case "preview-status": {
        const previewId = asPreviewId(message.previewId);
        await waitingPreview(previewId);
        const answer = await callTool(await requirePairing(), STATUS_TOOL, { previewId }, client);
        const read = readAnswer(answer);
        const structured = answer.structuredContent;
        if (answer.isError === true || !isObject(structured) || typeof structured.status !== "string") {
          throw new Error(read.kind === "result" && read.text.length > 0 ? read.text.slice(0, 300) : "MCP Connector did not report a status.");
        }
        return structured.status;
      }

      case "finish-preview": {
        const previewId = asPreviewId(message.previewId);
        const { executeTool } = await waitingPreview(previewId);
        // Used once: MCP Connector runs an approved preview only once anyway.
        await session.remove(previewKey(previewId));
        return readAnswer(await callTool(await requirePairing(), executeTool, { previewId }, client));
      }

      default:
        throw new Error("This message could not be read.");
    }
  };

  return {
    handle,
    forgetTab: (tabId) => session.remove(ticksKey(tabId))
  };
}

/** Runs a request and puts the outcome in a reply the page can read. */
export async function reply(run: () => Promise<unknown>): Promise<WorkerReply> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

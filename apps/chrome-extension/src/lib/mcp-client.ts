// Talks to MCP Connector's local MCP server. Only the background service
// worker uses this, so the browser key never reaches a page.
//
// The server answers one plain POST per request: it needs no "initialize"
// step and keeps no session. Its answer is an event stream holding one
// JSON-RPC message ("event: message" / "data: {...}"), or plain JSON; both are
// read here. client.test.ts checks this against the real server.

export const DEFAULT_PORT = 47_820;
export const RELEASES_URL = "https://github.com/qwaziestatic/MCP-connector/releases";
/** Listing tools should be quick; a tool itself may take a while. */
const LIST_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;
/** More than any tool should answer with; a larger answer is refused, not kept in memory. */
const MAX_ANSWER_LENGTH = 5_000_000;

export interface Pairing {
  readonly browserKey: string;
  readonly port: number;
}

export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** What a tool call returns, as the MCP server sends it. */
export interface CallToolAnswer {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
}

export type ConnectionProblem =
  /** Nothing answers on the port. */
  | "app-not-running"
  /** The server refused the browser key. */
  | "wrong-key"
  /** Something answers on the port, but it is not MCP Connector's server. */
  | "not-mcp-connector"
  | "timeout";

export class ConnectionError extends Error {
  public readonly problem: ConnectionProblem;

  public constructor(problem: ConnectionProblem, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.problem = problem;
  }
}

export interface ClientOptions {
  /** Replaceable in tests. */
  readonly fetch?: typeof fetch;
}

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** The key as the app shows it: URL-safe characters only, so it can never break a header. */
export function isValidBrowserKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_-]{20,200}$/u.test(key);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON-RPC message with this id, from an event stream or a JSON body. */
export function readRpcMessage(body: string, contentType: string, id: number): Record<string, unknown> | null {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/u)) {
      const data = event.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      if (data.length === 0) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // Not a JSON-RPC message; the server sends nothing else, so skip it.
      }
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(body);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return null;
    }
  }
  return candidates.find((candidate): candidate is Record<string, unknown> =>
    isObject(candidate) && candidate.id === id && ("result" in candidate || "error" in candidate)) ?? null;
}

let nextId = 1;

async function request(
  pairing: Pairing,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  options: ClientOptions
): Promise<unknown> {
  const id = nextId++;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`http://127.0.0.1:${pairing.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairing.browserKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      // Nothing of the browser's goes along, and the request never leaves this computer.
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ConnectionError("timeout", "MCP Connector did not answer in time.");
    }
    throw new ConnectionError("app-not-running", "MCP Connector is not running, or its MCP server is stopped.");
  }
  if (response.status === 401) {
    throw new ConnectionError("wrong-key", "MCP Connector refused the browser key.");
  }
  const body = await response.text();
  if (body.length > MAX_ANSWER_LENGTH) {
    throw new Error("The answer is too large to handle here.");
  }
  if (!response.ok) {
    // MCP Connector explains a request it cannot read as { "error": "..." }.
    let explained: unknown;
    try {
      explained = JSON.parse(body);
    } catch {
      explained = undefined;
    }
    if (response.status === 400 && isObject(explained) && typeof explained.error === "string") {
      throw new Error(explained.error);
    }
    throw new ConnectionError("not-mcp-connector", `Port ${pairing.port} answered, but not as MCP Connector does.`);
  }
  const message = readRpcMessage(body, response.headers.get("content-type") ?? "", id);
  if (message === null) {
    throw new ConnectionError("not-mcp-connector", `Port ${pairing.port} answered, but not as MCP Connector does.`);
  }
  if (isObject(message.error)) {
    throw new Error(typeof message.error.message === "string" ? message.error.message : "MCP Connector reported an error.");
  }
  return message.result;
}

function toTool(value: unknown): McpTool | null {
  if (!isObject(value) || typeof value.name !== "string") return null;
  return {
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(value.inputSchema === undefined ? {} : { inputSchema: value.inputSchema })
  };
}

/** Every tool the server offers to web chats. */
export async function listTools(pairing: Pairing, options: ClientOptions = {}): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  // The server sends one page today; the limit only stops a loop that never ends.
  for (let page = 0; page < 20; page += 1) {
    const result = await request(pairing, "tools/list", cursor === undefined ? {} : { cursor }, LIST_TIMEOUT_MS, options);
    if (!isObject(result) || !Array.isArray(result.tools)) {
      throw new ConnectionError("not-mcp-connector", `Port ${pairing.port} answered, but not as MCP Connector does.`);
    }
    tools.push(...result.tools.map(toTool).filter((tool): tool is McpTool => tool !== null));
    if (typeof result.nextCursor !== "string") break;
    cursor = result.nextCursor;
  }
  return tools;
}

export async function callTool(
  pairing: Pairing,
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ClientOptions = {}
): Promise<CallToolAnswer> {
  const result = await request(pairing, "tools/call", { name, arguments: args }, CALL_TIMEOUT_MS, options);
  if (!isObject(result)) throw new Error("MCP Connector sent an answer that could not be read.");
  return result;
}

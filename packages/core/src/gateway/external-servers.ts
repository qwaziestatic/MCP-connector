// Keeps a client connection to each MCP server the user added, so their tools
// can be offered to agents through MCP Connector.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { ExternalServerConfig, ExternalServerSecrets } from "./external-server-config.js";

export type ExternalServerState =
  | { readonly status: "connecting" }
  | { readonly status: "connected"; readonly tools: readonly Tool[] }
  | { readonly status: "failed"; readonly message: string };

export interface ExternalServerView {
  readonly config: ExternalServerConfig;
  readonly state: ExternalServerState;
}

/** What the MCP server needs to offer other servers' tools. */
export interface ExternalToolSource {
  connectedServers(): readonly { readonly config: ExternalServerConfig; readonly tools: readonly Tool[] }[];
  isConnected(id: string): boolean;
  callTool(id: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<CallToolResult>;
}

/** A transport plus, for programs, a way to read what they printed on stderr. */
export interface ExternalTransportHandle {
  readonly transport: Transport;
  readonly stderrTail?: () => string;
}

export type ExternalTransportFactory = (config: ExternalServerConfig, secrets: ExternalServerSecrets) => ExternalTransportHandle;

/** Long enough for a server that downloads itself on first use, as npx does. */
const CONNECT_TIMEOUT_MS = 120_000;

/**
 * Network settings a program needs to reach the internet from behind a proxy,
 * as npx does to download a server. Passed through; nothing else is.
 */
const NETWORK_VARIABLES = /^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|npm_config_(https?_proxy|proxy|noproxy|cafile|registry|userconfig))$/i;

/** The usual environment (PATH, HOME and so on) plus network settings. */
export function inheritedEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const network = Object.entries(env).filter((entry): entry is [string, string] =>
    NETWORK_VARIABLES.test(entry[0]) && typeof entry[1] === "string");
  return { ...getDefaultEnvironment(), ...Object.fromEntries(network) };
}
const STDERR_TAIL_CHARS = 2000;

/** The real transports: start a program, or reach a URL. */
export function createExternalTransport(config: ExternalServerConfig, secrets: ExternalServerSecrets): ExternalTransportHandle {
  if (config.transport.kind === "http") {
    const transport = new StreamableHTTPClientTransport(new URL(config.transport.url), {
      requestInit: { headers: { ...secrets.headers } }
    });
    // The SDK declares sessionId as optional without `| undefined`, which this
    // project's exactOptionalPropertyTypes setting rejects; the object is a Transport.
    return { transport: transport as unknown as Transport };
  }
  // Only the usual environment, network settings, and the server's own
  // variables, so other secrets in the app's environment do not leak to it.
  const transport = new StdioClientTransport({
    command: config.transport.command,
    args: [...config.transport.args],
    env: { ...inheritedEnvironment(), ...secrets.env },
    stderr: "pipe"
  });
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  return { transport, stderrTail: () => tail };
}

interface Entry {
  config: ExternalServerConfig;
  secrets: ExternalServerSecrets;
  state: ExternalServerState;
  client: Client | null;
  /** Increases with every (re)connect, so a late result from an old attempt is ignored. */
  attempt: number;
}

function describeFailure(error: unknown, stderrTail: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  const lastLine = stderrTail?.trim().split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1);
  if (/ENOENT|not recognized|not found/i.test(message)) {
    return `The command could not be started (${message}). Check that it is installed and on PATH.`;
  }
  if (/timed out/i.test(message)) {
    return "The server did not answer in time. If it downloads itself on first use, as npx does, "
      + "wait a minute and click Reconnect." + (lastLine === undefined ? "" : ` The server said: ${lastLine.slice(0, 300)}`);
  }
  return lastLine === undefined ? message : `${message} The server said: ${lastLine.slice(0, 300)}`;
}

export class ExternalServers implements ExternalToolSource {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(servers: readonly ExternalServerView[]) => void>();

  public constructor(private readonly options: {
    readonly createTransport?: ExternalTransportFactory;
    readonly clientVersion?: string;
    readonly log?: (message: string) => void;
  } = {}) {}

  list(): readonly ExternalServerView[] {
    return [...this.entries.values()].map(({ config, state }) => ({ config, state }));
  }

  connectedServers(): readonly { readonly config: ExternalServerConfig; readonly tools: readonly Tool[] }[] {
    return [...this.entries.values()].flatMap(({ config, state }) =>
      state.status === "connected" ? [{ config, tools: state.tools }] : []);
  }

  isConnected(id: string): boolean {
    return this.entries.get(id)?.state.status === "connected";
  }

  subscribe(listener: (servers: readonly ExternalServerView[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a server, or replaces one with the same id, and connects to it. */
  async set(config: ExternalServerConfig, secrets: ExternalServerSecrets): Promise<void> {
    const existing = this.entries.get(config.id);
    const entry: Entry = { config, secrets, state: { status: "connecting" }, client: null, attempt: (existing?.attempt ?? 0) + 1 };
    this.entries.set(config.id, entry);
    await existing?.client?.close().catch(() => undefined);
    await this.connect(entry);
  }

  /** Changes how the server's tools are approved, without reconnecting. */
  setApproval(id: string, approval: ExternalServerConfig["approval"]): ExternalServerConfig {
    const entry = this.require(id);
    entry.config = { ...entry.config, approval };
    this.emit();
    return entry.config;
  }

  async reconnect(id: string): Promise<void> {
    const entry = this.require(id);
    entry.attempt += 1;
    const old = entry.client;
    entry.client = null;
    entry.state = { status: "connecting" };
    this.emit();
    await old?.close().catch(() => undefined);
    await this.connect(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.entries.delete(id);
    entry.attempt += 1;
    this.emit();
    await entry.client?.close().catch(() => undefined);
  }

  async callTool(id: string, tool: string, args: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error("That MCP server was removed from MCP Connector.");
    if (entry.state.status !== "connected" || entry.client === null) {
      throw new Error(`${entry.config.name} is not connected. Reconnect it in MCP Connector, under Other MCP servers.`);
    }
    return await entry.client.callTool({ name: tool, arguments: { ...args } }) as CallToolResult;
  }

  async close(): Promise<void> {
    const clients = [...this.entries.values()].map((entry) => entry.client);
    this.entries.clear();
    await Promise.all(clients.map((client) => client?.close().catch(() => undefined)));
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error("MCP Connector has no such server.");
    return entry;
  }

  private emit(): void {
    const servers = this.list();
    for (const listener of this.listeners) listener(servers);
  }

  private async connect(entry: Entry): Promise<void> {
    const attempt = entry.attempt;
    const isCurrent = (): boolean => this.entries.get(entry.config.id) === entry && entry.attempt === attempt;
    entry.state = { status: "connecting" };
    this.emit();
    let handle: ExternalTransportHandle | undefined;
    const client = new Client({ name: "mcp-connector", version: this.options.clientVersion ?? "0.1.0" });
    try {
      handle = (this.options.createTransport ?? createExternalTransport)(entry.config, entry.secrets);
      await client.connect(handle.transport, { timeout: CONNECT_TIMEOUT_MS });
      const tools = await this.listAllTools(client);
      if (!isCurrent()) {
        await client.close().catch(() => undefined);
        return;
      }
      entry.client = client;
      entry.state = { status: "connected", tools };
      this.options.log?.(`Connected to ${entry.config.name} (${tools.length} tools).`);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (!isCurrent()) return;
        try {
          entry.state = { status: "connected", tools: await this.listAllTools(client) };
          this.emit();
        } catch (error) {
          this.options.log?.(`Could not refresh ${entry.config.name}'s tools: ${String(error)}`);
        }
      });
      client.onclose = () => {
        if (!isCurrent()) return;
        entry.client = null;
        entry.state = { status: "failed", message: "The server stopped. Click Reconnect to start it again." };
        this.emit();
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      if (!isCurrent()) return;
      entry.state = { status: "failed", message: describeFailure(error, handle?.stderrTail?.()) };
      this.options.log?.(`Could not connect to ${entry.config.name}: ${entry.state.message}`);
    }
    this.emit();
  }

  private async listAllTools(client: Client): Promise<readonly Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined && tools.length < 1000);
    return tools;
  }
}

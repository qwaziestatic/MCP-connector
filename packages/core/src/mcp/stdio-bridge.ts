// Relays MCP messages between stdio and MCP Connector's running HTTP server.
// Agents that only speak stdio launch the desktop app with --mcp-stdio, and
// this bridge forwards everything to the app that is already running, so
// approvals still go through its window and audit log.
import type { Readable, Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const MCP_CONNECTOR_NOT_RUNNING =
  "MCP Connector's MCP server is not running. Open MCP Connector, click Start MCP server, and try again.";

export interface StdioBridgeOptions {
  /** The running server's address, or null when the app says it is not running. */
  readonly url: string | null;
  readonly bearerToken: string;
  readonly input?: Readable;
  readonly output?: Writable;
  /** Diagnostics go here, never to the output stream, which carries the protocol. */
  readonly log?: (message: string) => void;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  if (/ECONNREFUSED|fetch failed|ECONNRESET|socket hang up/iu.test(message)) {
    return MCP_CONNECTOR_NOT_RUNNING;
  }
  if (/\b401\b|Unauthorized/iu.test(message)) {
    return "MCP Connector rejected the connection because its token changed. Restart your agent and try again.";
  }
  return `MCP Connector could not be reached: ${error instanceof Error ? error.message : String(error)}`;
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: string } {
  return "id" in message && "method" in message;
}

/** Runs until the input stream ends, for example when the agent exits. */
export async function runStdioBridge(options: StdioBridgeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const stdio = new StdioServerTransport(input, options.output ?? process.stdout);
  const http = options.url === null
    ? null
    : new StreamableHTTPClientTransport(new URL(options.url), {
        requestInit: { headers: { Authorization: `Bearer ${options.bearerToken}` } }
      });

  // Every request gets an answer: if the app can't be reached, the agent sees
  // why instead of waiting forever.
  const fail = async (message: JSONRPCMessage, reason: string): Promise<void> => {
    if (!isRequest(message)) return;
    await stdio.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: reason } });
  };

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      void http?.close();
      void stdio.close();
      resolve();
    };
    input.once("end", close);
    input.once("close", close);
    stdio.onclose = close;
    stdio.onerror = (error) => options.log?.(`stdio error: ${error.message}`);
    stdio.onmessage = (message) => {
      if (http === null) {
        void fail(message, MCP_CONNECTOR_NOT_RUNNING);
        return;
      }
      http.send(message).catch((error: unknown) => {
        options.log?.(`Forwarding failed: ${error instanceof Error ? error.message : String(error)}`);
        void fail(message, describeFailure(error));
      });
    };
    if (http !== null) {
      http.onmessage = (message) => void stdio.send(message);
      http.onerror = (error) => options.log?.(`HTTP error: ${error.message}`);
      void http.start();
    }
    void stdio.start();
  });
}

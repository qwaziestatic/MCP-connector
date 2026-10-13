import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer, type McpConnectorDependencies } from "./mcp-server.js";

export interface McpHttpServerOptions {
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly bearerToken?: string;
}

export interface McpHttpServerHandle {
  readonly url: string;
  readonly bearerToken: string;
  close(): Promise<void>;
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer"
  });
  response.end(JSON.stringify({ error: "Unauthorized" }));
}

class McpTransportAdapter implements Transport {
  public onclose: () => void = () => {};
  public onerror: (error: Error) => void = () => {};
  public onmessage: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo
  ) => void = () => {};

  public constructor(private readonly transport: StreamableHTTPServerTransport) {
    this.transport.onmessage = (message, extra) => this.onmessage(message, extra);
    this.transport.onerror = (error) => this.onerror(error);
    this.transport.onclose = () => this.onclose();
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(message, options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) {
      throw new Error("MCP request body exceeds the 1 MB limit.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function startMcpHttpServer(
  dependencies: McpConnectorDependencies,
  options: McpHttpServerOptions = {}
): Promise<McpHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const bearerToken = options.bearerToken ?? randomBytes(32).toString("base64url");
  const port = options.port ?? 0;
  const server: Server = createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }

    if (request.headers.authorization !== `Bearer ${bearerToken}`) {
      unauthorized(response);
      return;
    }

    try {
      const body = await readJsonBody(request);
      const transport = new StreamableHTTPServerTransport();
      const mcpServer = createMcpServer(dependencies);
      await mcpServer.connect(new McpTransportAdapter(transport));
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : "Invalid MCP request."
        }));
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("MCP HTTP server did not receive a valid address.");
  }

  return {
    url: `http://${host}:${address.port}/mcp`,
    bearerToken,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  };
}

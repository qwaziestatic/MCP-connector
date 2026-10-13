import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

const contextMessageSchema = z.object({
  type: z.literal("vscode.context"),
  workspacePath: z.string().trim().min(1).max(4096),
  filePath: z.string().trim().min(1).max(4096).optional(),
  languageId: z.string().trim().min(1).max(128).optional(),
  selectedText: z.string().max(64 * 1024).optional(),
  documentText: z.string().max(256 * 1024).optional()
}).strict();

export type VsCodeContext = z.infer<typeof contextMessageSchema>;

export interface VsCodeContextServerHandle {
  readonly url: string;
  readonly bearerToken: string;
  readonly latestContext: VsCodeContext | null;
  close(): Promise<void>;
}

function constantTimeTokenMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function startVsCodeContextServer(
  onContext: (context: VsCodeContext) => void
): Promise<VsCodeContextServerHandle> {
  const bearerToken = randomBytes(32).toString("base64url");
  const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024
  });
  let latestContext: VsCodeContext | null = null;

  httpServer.on("upgrade", (request, socket, head) => {
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== "string"
      || !constantTimeTokenMatches(authorization, `Bearer ${bearerToken}`)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket: WebSocket) => {
    websocket.on("message", (data, isBinary) => {
      if (isBinary) {
        websocket.close(1003, "Text messages are required.");
        return;
      }
      try {
        const context = contextMessageSchema.parse(JSON.parse(data.toString()));
        latestContext = context;
        onContext(context);
        websocket.send(JSON.stringify({ type: "vscode.context.accepted" }));
      } catch {
        websocket.send(JSON.stringify({
          type: "vscode.context.rejected",
          reason: "Invalid context payload."
        }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(0, "127.0.0.1");
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeServers(httpServer, websocketServer);
    throw new Error("VS Code context server did not expose a TCP address.");
  }

  return {
    get latestContext() {
      return latestContext;
    },
    url: `ws://127.0.0.1:${address.port}`,
    bearerToken,
    close: () => closeServers(httpServer, websocketServer)
  };
}

async function closeServers(httpServer: Server, websocketServer: WebSocketServer): Promise<void> {
  for (const client of websocketServer.clients) {
    client.close(1001, "Server shutting down.");
  }
  websocketServer.close();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error === undefined ? resolve() : reject(error));
  });
}

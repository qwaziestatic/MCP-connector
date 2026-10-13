import { createServer, type Server } from "node:http";

export interface OAuthCallbackResult {
  readonly code: string;
  readonly state: string;
}

export class OAuthCallbackServer {
  private server: Server | null = null;
  private callbackUrl: string | null = null;

  async start(): Promise<string> {
    if (this.server !== null && this.callbackUrl !== null) {
      return this.callbackUrl;
    }

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/oauth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>MCP Connector</title><p>Authorization received. You can close this window.</p>");
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
      server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("OAuth callback server did not receive a valid address.");
    }

    this.server = server;
    this.callbackUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
    return this.callbackUrl;
  }

  async waitForCallback(timeoutMs = 120_000): Promise<OAuthCallbackResult> {
    if (this.server === null) {
      throw new Error("OAuth callback server has not been started.");
    }

    const server = this.server;
    return new Promise<OAuthCallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("OAuth callback timed out."));
      }, timeoutMs);

      const onRequest = (request: import("node:http").IncomingMessage): void => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname !== "/oauth/callback") return;
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        const error = requestUrl.searchParams.get("error");
        cleanup();
        if (error !== null) {
          reject(new Error(`OAuth provider rejected authorization: ${error}`));
        } else if (code === null || state === null) {
          reject(new Error("OAuth callback did not include code and state."));
        } else {
          resolve({ code, state });
        }
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        server.removeListener("request", onRequest);
      };

      server.on("request", onRequest);
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.callbackUrl = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

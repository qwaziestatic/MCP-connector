import { createServer, type Server } from "node:http";

export interface OAuthCallbackResult {
  readonly code: string;
  readonly state: string;
}

type Callback = { readonly result: OAuthCallbackResult } | { readonly error: Error };

function readCallback(url: URL): Callback {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error === "access_denied") return { error: new Error("Sign-in was declined in the browser.") };
  if (error !== null) return { error: new Error(`OAuth provider rejected authorization: ${error}`) };
  if (code === null || state === null) return { error: new Error("OAuth callback did not include code and state.") };
  return { result: { code, state } };
}

/**
 * Listens on 127.0.0.1 for the browser's return from a sign-in. The first
 * return is kept until waitForCallback() asks for it, so a fast browser
 * cannot arrive before the app starts waiting.
 */
export class OAuthCallbackServer {
  private server: Server | null = null;
  private callbackUrl: string | null = null;
  private received: Callback | null = null;
  private waiter: ((callback: Callback) => void) | null = null;

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
      if (this.received !== null) return;
      const callback = readCallback(requestUrl);
      if (this.waiter !== null) this.waiter(callback);
      else this.received = callback;
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

  async waitForCallback(timeoutMs = 120_000, signal?: AbortSignal): Promise<OAuthCallbackResult> {
    if (this.server === null) {
      throw new Error("OAuth callback server has not been started.");
    }
    if (signal?.aborted === true) {
      throw new Error("Sign-in was cancelled.");
    }
    const settle = (callback: Callback): OAuthCallbackResult => {
      if ("error" in callback) throw callback.error;
      return callback.result;
    };
    if (this.received !== null) {
      const received = this.received;
      this.received = null;
      return settle(received);
    }

    return new Promise<OAuthCallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Sign-in timed out. Click Connect to try again."));
      }, timeoutMs);
      const onAbort = (): void => {
        cleanup();
        reject(new Error("Sign-in was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = null;
      };
      this.waiter = (callback) => {
        cleanup();
        try {
          resolve(settle(callback));
        } catch (error) {
          reject(error as Error);
        }
      };
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.callbackUrl = null;
    this.received = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

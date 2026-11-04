import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NotionSignInResult } from "@mcp-connector/core";
import type { OAuthCallbackResult } from "./oauth-callback-server";
import type { StoredCredential } from "./credential-vault";

/** Long enough to choose which pages MCP Connector may use. */
export const NOTION_SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface CallbackServerLike {
  start(): Promise<string>;
  waitForCallback(timeoutMs?: number, signal?: AbortSignal): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

export interface NotionSignInClientLike {
  authorizationUrl(port: number, state: string): string;
  exchangeCode(code: string): Promise<NotionSignInResult>;
}

function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Notion sign-in through the sign-in service: the browser goes to Notion, the
 * service sends it back to a listener on this computer, and the service
 * exchanges the code. One sign-in at a time; Cancel stops the wait.
 */
export class NotionSignIn {
  private controller: AbortController | null = null;

  public constructor(
    private readonly createClient: () => NotionSignInClientLike,
    /** A new listener for every sign-in, so a cancelled one cannot close the next one's. */
    private readonly createCallbackServer: () => CallbackServerLike,
    private readonly vault: { save(credential: StoredCredential): Promise<void> },
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly createState: () => string = () => randomBytes(32).toString("base64url")
  ) {}

  async connect(): Promise<void> {
    this.cancel();
    // Fails before anything opens if this copy has no sign-in service configured.
    const client = this.createClient();
    const controller = new AbortController();
    this.controller = controller;
    const callbackServer = this.createCallbackServer();
    try {
      const redirectUri = await callbackServer.start();
      const state = this.createState();
      await this.openExternal(client.authorizationUrl(Number(new URL(redirectUri).port), state));
      const callback = await callbackServer.waitForCallback(NOTION_SIGN_IN_TIMEOUT_MS, controller.signal);
      if (!sameState(callback.state, state)) {
        throw new Error("This Notion sign-in did not start in MCP Connector. Click Connect to try again.");
      }
      const { token } = await client.exchangeCode(callback.code);
      if (controller.signal.aborted) throw new Error("Sign-in was cancelled.");
      await this.vault.save({ provider: "notion", ...token });
    } finally {
      if (this.controller === controller) this.controller = null;
      await callbackServer.close();
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

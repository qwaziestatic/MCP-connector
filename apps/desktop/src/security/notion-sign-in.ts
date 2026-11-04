import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NotionSignInResult } from "@mcp-connector/core";
import type { OAuthCallbackResult } from "./oauth-callback-server";
import type { StoredCredential } from "./credential-vault";
import type { SignInFlow, SignInPrompt } from "./sign-in-flow";

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

interface PendingSignIn {
  readonly client: NotionSignInClientLike;
  readonly callbackServer: CallbackServerLike;
  readonly state: string;
  readonly controller: AbortController;
}

function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Notion sign-in through the sign-in service: start() opens the browser on
 * Notion's consent page, the service sends it back to a listener on this
 * computer, and finish() exchanges the code. One sign-in at a time; cancel()
 * stops the wait.
 */
export class NotionSignIn implements SignInFlow {
  private pending: PendingSignIn | null = null;

  public constructor(
    /** The connector the token belongs to. */
    private readonly connectorId: string,
    private readonly createClient: () => NotionSignInClientLike,
    /** A new listener for every sign-in, so a cancelled one cannot close the next one's. */
    private readonly createCallbackServer: () => CallbackServerLike,
    private readonly vault: { save(credential: StoredCredential): Promise<void> },
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly createState: () => string = () => randomBytes(32).toString("base64url")
  ) {}

  async start(): Promise<SignInPrompt> {
    this.cancel();
    // Fails before anything opens if this copy has no sign-in service configured.
    const client = this.createClient();
    const callbackServer = this.createCallbackServer();
    const pending: PendingSignIn = { client, callbackServer, state: this.createState(), controller: new AbortController() };
    try {
      const redirectUri = await callbackServer.start();
      await this.openExternal(client.authorizationUrl(Number(new URL(redirectUri).port), pending.state));
    } catch (error) {
      await callbackServer.close();
      throw error;
    }
    this.pending = pending;
    return { kind: "browser" };
  }

  async openPage(): Promise<void> {
    throw new Error("Notion signs in through the browser window that is already open.");
  }

  async finish(): Promise<void> {
    const pending = this.pending;
    if (pending === null) throw new Error("Notion sign-in has not started. Click Connect again.");
    try {
      const callback = await pending.callbackServer.waitForCallback(NOTION_SIGN_IN_TIMEOUT_MS, pending.controller.signal);
      if (!sameState(callback.state, pending.state)) {
        throw new Error("This Notion sign-in did not start in MCP Connector. Click Connect to try again.");
      }
      const { token } = await pending.client.exchangeCode(callback.code);
      if (pending.controller.signal.aborted) throw new Error("Sign-in was cancelled.");
      await this.vault.save({ provider: this.connectorId, ...token });
    } finally {
      if (this.pending === pending) this.pending = null;
      await pending.callbackServer.close();
    }
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return;
    pending.controller.abort();
    // Closing also ends a sign-in that was started but never waited for.
    void pending.callbackServer.close();
  }
}

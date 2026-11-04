import type { GitHubDeviceAuthorization, OAuthTokenSet } from "@mcp-connector/core";
import type { StoredCredential } from "./credential-vault";

/** What the window shows while the user enters the code on github.com. */
export interface GitHubSignInCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
}

export interface GitHubDeviceFlowLike {
  start(): Promise<GitHubDeviceAuthorization>;
  waitForToken(authorization: GitHubDeviceAuthorization, signal?: AbortSignal): Promise<OAuthTokenSet>;
}

interface PendingSignIn {
  readonly authorization: GitHubDeviceAuthorization;
  readonly controller: AbortController;
}

/**
 * One GitHub sign-in at a time: start() gets a code, the window shows it,
 * waitForToken() saves the token once the user approves on github.com.
 */
export class GitHubSignIn {
  private pending: PendingSignIn | null = null;

  public constructor(
    private readonly createFlow: () => GitHubDeviceFlowLike,
    private readonly vault: { save(credential: StoredCredential): Promise<void> },
    private readonly openExternal: (url: string) => Promise<void>
  ) {}

  async start(): Promise<GitHubSignInCode> {
    this.cancel();
    const flow = this.createFlow();
    const authorization = await flow.start();
    this.pending = { authorization, controller: new AbortController() };
    return {
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      expiresAt: authorization.expiresAt
    };
  }

  /** Opens GitHub's code page. Only GitHub's own address is ever opened. */
  async openVerificationPage(): Promise<void> {
    const pending = this.requirePending();
    const url = new URL(pending.authorization.verificationUri);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      throw new Error("GitHub returned an unexpected sign-in address.");
    }
    await this.openExternal(url.href);
  }

  async waitForToken(): Promise<void> {
    const pending = this.requirePending();
    try {
      const token = await this.createFlow().waitForToken(pending.authorization, pending.controller.signal);
      await this.vault.save({
        provider: "github",
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        tokenType: token.tokenType,
        scope: token.scope
      });
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  cancel(): void {
    this.pending?.controller.abort();
    this.pending = null;
  }

  private requirePending(): PendingSignIn {
    if (this.pending === null) throw new Error("GitHub sign-in has not started. Click Connect again.");
    return this.pending;
  }
}

import type { GitHubDeviceAuthorization, OAuthTokenSet } from "@mcp-connector/core";
import type { StoredCredential } from "./credential-vault";
import type { SignInFlow, SignInPrompt } from "./sign-in-flow";

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
 * finish() saves the token once the user approves on github.com.
 */
export class GitHubSignIn implements SignInFlow {
  private pending: PendingSignIn | null = null;

  public constructor(
    /** The connector the token belongs to. */
    private readonly connectorId: string,
    private readonly createFlow: () => GitHubDeviceFlowLike,
    private readonly vault: { save(credential: StoredCredential): Promise<void> },
    private readonly openExternal: (url: string) => Promise<void>
  ) {}

  async start(): Promise<SignInPrompt> {
    this.cancel();
    const flow = this.createFlow();
    const authorization = await flow.start();
    this.pending = { authorization, controller: new AbortController() };
    return {
      kind: "code",
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      expiresAt: authorization.expiresAt
    };
  }

  /** Opens GitHub's code page. Only GitHub's own address is ever opened. */
  async openPage(): Promise<void> {
    const pending = this.requirePending();
    const url = new URL(pending.authorization.verificationUri);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      throw new Error("GitHub returned an unexpected sign-in address.");
    }
    await this.openExternal(url.href);
  }

  async finish(): Promise<void> {
    const pending = this.requirePending();
    try {
      const token = await this.createFlow().waitForToken(pending.authorization, pending.controller.signal);
      await this.vault.save({
        provider: this.connectorId,
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

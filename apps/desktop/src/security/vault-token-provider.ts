import type { ConnectorTokenProvider, OAuthTokenSet } from "@mcp-connector/core";
import type { StoredCredential } from "./credential-vault";

const providerNames = { github: "GitHub", notion: "Notion" } as const;

/** Renew a little early, so a token cannot expire in the middle of a request. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;

export class VaultTokenProvider implements ConnectorTokenProvider {
  public constructor(
    private readonly vault: {
      get(provider: StoredCredential["provider"]): Promise<StoredCredential | null>;
      save(credential: StoredCredential): Promise<void>;
    },
    private readonly provider: StoredCredential["provider"],
    /** Null when this provider's tokens cannot be refreshed. */
    private readonly refresh: ((refreshToken: string) => Promise<OAuthTokenSet>) | null
  ) {}

  private refreshPromise: Promise<string> | null = null;

  async getAccessToken(): Promise<string> {
    const name = providerNames[this.provider];
    const credential = await this.vault.get(this.provider);
    if (credential === null) {
      throw new Error(`${name} is not connected. Connect it in MCP Connector first.`);
    }
    if (
      credential.expiresAt === null ||
      Date.parse(credential.expiresAt) - RENEW_BEFORE_EXPIRY_MS > Date.now()
    ) {
      return credential.accessToken;
    }

    if (credential.refreshToken === null || this.refresh === null) {
      throw new Error(`${name} sign-in has expired. Connect ${name} again in MCP Connector.`);
    }
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshCredential(this.refresh, credential.refreshToken)
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async refreshCredential(
    refresh: (refreshToken: string) => Promise<OAuthTokenSet>,
    refreshToken: string
  ): Promise<string> {
    const name = providerNames[this.provider];
    try {
      const refreshed = await refresh(refreshToken);
      const current = await this.vault.get(this.provider);
      if (current === null) {
        throw new Error(`${name} was disconnected during refresh.`);
      }
      await this.vault.save({
        ...current,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        tokenType: refreshed.tokenType,
        scope: refreshed.scope
      });
      return refreshed.accessToken;
    } catch (error) {
      throw new Error(
        `${name} sign-in could not be renewed. Connect ${name} again in MCP Connector.`,
        { cause: error }
      );
    }
  }
}

import type { ConnectorTokenProvider } from "@mcp-connector/core";
import type { OAuthProviderConfig, OAuthTokenSet } from "@mcp-connector/core";
import { CredentialVault } from "./credential-vault";

export class VaultTokenProvider implements ConnectorTokenProvider {
  public constructor(
    private readonly vault: CredentialVault,
    private readonly provider: "github" | "notion",
    private readonly getConfig: () => OAuthProviderConfig,
    private readonly refresh: (
      config: OAuthProviderConfig,
      refreshToken: string
    ) => Promise<OAuthTokenSet>
  ) {}

  private refreshPromise: Promise<string> | null = null;

  async getAccessToken(): Promise<string> {
    const credential = await this.vault.get(this.provider);
    if (credential === null) {
      throw new Error(`${this.provider} is not connected.`);
    }
    if (
      credential.expiresAt === null ||
      Date.parse(credential.expiresAt) > Date.now()
    ) {
      return credential.accessToken;
    }

    if (credential.refreshToken === null) {
      throw new Error(`${this.provider} authorization has expired and cannot be refreshed. Reconnect the integration.`);
    }
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshCredential(credential.refreshToken)
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async refreshCredential(refreshToken: string): Promise<string> {
    try {
      const refreshed = await this.refresh(this.getConfig(), refreshToken);
      const current = await this.vault.get(this.provider);
      if (current === null) {
        throw new Error(`${this.provider} credential was removed during refresh.`);
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
        `${this.provider} authorization refresh failed. Reconnect the integration.`,
        { cause: error }
      );
    }
  }
}

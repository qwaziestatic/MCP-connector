export type ConnectorId = "github" | "notion";

export interface OAuthProviderConfig {
  readonly provider: ConnectorId;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scopes: readonly string[];
}

export interface OAuthAuthorizationRequest {
  readonly provider: ConnectorId;
  readonly state: string;
  readonly codeVerifier: string;
  readonly authorizationUrl: string;
}

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly tokenType: string;
  readonly scope: string | null;
}

export interface OAuthTokenExchange {
  exchangeCode(
    config: OAuthProviderConfig,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OAuthTokenSet>;
  refreshAccessToken(
    config: OAuthProviderConfig,
    refreshToken: string
  ): Promise<OAuthTokenSet>;
}

export interface ConnectorTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface GitHubRepositorySummary {
  readonly fullName: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
}

export interface NotionPageDraft {
  readonly title: string;
  readonly markdown: string;
}

export interface GitHubConnector {
  listRepositories(): Promise<readonly GitHubRepositorySummary[]>;
}

export interface NotionConnector {
  createPage(draft: NotionPageDraft): Promise<{ readonly pageId: string; readonly url: string | null }>;
}

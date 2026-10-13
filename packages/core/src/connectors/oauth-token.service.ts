import { z } from "zod";
import type {
  OAuthProviderConfig,
  OAuthTokenExchange,
  OAuthTokenSet
} from "./connector.types.js";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().int().positive().nullable().optional(),
  token_type: z.string().default("Bearer"),
  scope: z.string().nullable().optional()
});

export class FetchOAuthTokenService implements OAuthTokenExchange {
  async exchangeCode(
    config: OAuthProviderConfig,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OAuthTokenSet> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    };
    if (config.clientSecret !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    }

    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: config.clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OAuth token exchange failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const parsed = tokenResponseSchema.parse(await response.json());
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? null,
      expiresAt: parsed.expires_in === undefined || parsed.expires_in === null
        ? null
        : new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
      tokenType: parsed.token_type,
      scope: parsed.scope ?? null
    };
  }

  async refreshAccessToken(
    config: OAuthProviderConfig,
    refreshToken: string
  ): Promise<OAuthTokenSet> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    };
    if (config.clientSecret !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    }

    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OAuth token refresh failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const parsed = tokenResponseSchema.parse(await response.json());
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? refreshToken,
      expiresAt: parsed.expires_in === undefined || parsed.expires_in === null
        ? null
        : new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
      tokenType: parsed.token_type,
      scope: parsed.scope ?? null
    };
  }
}

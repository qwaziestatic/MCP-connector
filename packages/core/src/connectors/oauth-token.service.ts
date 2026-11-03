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

// OAuth-style errors ({ error, error_description }) and Notion API-style
// errors ({ object: "error", code, message }) are both reported as errors.
const providerErrorSchema = z.union([
  z.object({
    error: z.string().min(1),
    error_description: z.string().optional()
  }),
  z.object({
    object: z.literal("error"),
    code: z.string().min(1),
    message: z.string().optional()
  }).transform((value) => ({ error: value.code, error_description: value.message }))
]);

const providerNames: Readonly<Record<OAuthProviderConfig["provider"], string>> = {
  github: "GitHub",
  notion: "Notion"
};

// Plain-language explanations for the errors users are most likely to hit.
const providerErrorHints: Readonly<Record<string, string>> = {
  bad_verification_code: "The sign-in code expired or was already used. Connect again.",
  incorrect_client_credentials: "The app's OAuth client ID or secret is wrong.",
  redirect_uri_mismatch: "The sign-in return address does not match the one registered for this app.",
  invalid_grant: "The authorization is no longer valid. Connect again.",
  invalid_client: "The app's OAuth client ID or secret is wrong.",
  access_denied: "Access was denied."
};

export class OAuthProviderError extends Error {
  public constructor(
    public readonly provider: OAuthProviderConfig["provider"],
    public readonly code: string,
    description: string | undefined
  ) {
    const hint = providerErrorHints[code];
    const detail = description === undefined || description.length === 0 ? code : `${code}: ${description}`;
    super(`${providerNames[provider]} sign-in failed: ${hint === undefined ? detail : `${hint} (${detail})`}`);
    this.name = "OAuthProviderError";
  }
}

export class FetchOAuthTokenService implements OAuthTokenExchange {
  async exchangeCode(
    config: OAuthProviderConfig,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OAuthTokenSet> {
    const parsed = await this.requestToken(config, "exchange", {
      client_id: config.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? null,
      expiresAt: this.expiresAt(parsed.expires_in),
      tokenType: parsed.token_type,
      scope: parsed.scope ?? null
    };
  }

  async refreshAccessToken(
    config: OAuthProviderConfig,
    refreshToken: string
  ): Promise<OAuthTokenSet> {
    const parsed = await this.requestToken(config, "refresh", {
      client_id: config.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? refreshToken,
      expiresAt: this.expiresAt(parsed.expires_in),
      tokenType: parsed.token_type,
      scope: parsed.scope ?? null
    };
  }

  private async requestToken(
    config: OAuthProviderConfig,
    operation: "exchange" | "refresh",
    body: Record<string, string>
  ): Promise<z.infer<typeof tokenResponseSchema>> {
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
      body: new URLSearchParams(body)
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    // GitHub reports many token errors with HTTP 200 and an "error" field, so
    // check for one before reading the response as a token.
    const providerError = providerErrorSchema.safeParse(json);
    if (providerError.success) {
      throw new OAuthProviderError(
        config.provider,
        providerError.data.error,
        providerError.data.error_description
      );
    }
    if (!response.ok) {
      const label = operation === "exchange" ? "exchange" : "refresh";
      throw new Error(`OAuth token ${label} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${providerNames[config.provider]} returned an unexpected token response.`);
    }
    return parsed.data;
  }

  private expiresAt(expiresIn: number | null | undefined): string | null {
    return expiresIn === undefined || expiresIn === null
      ? null
      : new Date(Date.now() + expiresIn * 1000).toISOString();
  }
}

// Talks to the Notion sign-in service (apps/notion-sign-in-worker), which holds
// Notion's client secret so the installer never has to.
import { z } from "zod";
import type { OAuthTokenSet } from "./connector.types.js";
import { OAuthProviderError } from "./oauth-token.service.js";

export interface NotionSignInResult {
  readonly token: OAuthTokenSet;
  readonly workspaceName: string | null;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().int().positive().nullable().optional(),
  workspace_name: z.string().nullable().optional()
});

// Notion's own errors, passed through by the service.
const notionErrorSchema = z.object({
  object: z.literal("error"),
  code: z.string().min(1),
  message: z.string().optional()
});

// The service's errors, already written for people.
const serviceErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().min(1)
});

export class NotionSignInClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Where to send the browser. Notion returns it to http://127.0.0.1:<port>/oauth/callback. */
  authorizationUrl(port: number, state: string): string {
    const url = new URL(`${this.baseUrl}/notion/start`);
    url.searchParams.set("port", String(port));
    url.searchParams.set("state", state);
    return url.href;
  }

  async exchangeCode(code: string): Promise<NotionSignInResult> {
    const parsed = await this.post("/notion/token", { code });
    return { token: this.toTokenSet(parsed, null), workspaceName: parsed.workspace_name ?? null };
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    return this.toTokenSet(await this.post("/notion/refresh", { refresh_token: refreshToken }), refreshToken);
  }

  private toTokenSet(parsed: z.infer<typeof tokenSchema>, previousRefreshToken: string | null): OAuthTokenSet {
    return {
      accessToken: parsed.access_token,
      // Notion issues a new refresh token each time; keep the old one if it does not.
      refreshToken: parsed.refresh_token ?? previousRefreshToken,
      expiresAt: parsed.expires_in === undefined || parsed.expires_in === null
        ? null
        : new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
      tokenType: parsed.token_type,
      scope: null
    };
  }

  private async post(path: string, body: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      throw new Error(
        `Could not reach the Notion sign-in service at ${this.baseUrl}. Check your internet connection and try again.`,
        { cause }
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    const notionError = notionErrorSchema.safeParse(json);
    if (notionError.success) {
      throw new OAuthProviderError("notion", notionError.data.code, notionError.data.message);
    }
    const serviceError = serviceErrorSchema.safeParse(json);
    if (serviceError.success) {
      throw new Error(`Notion sign-in failed: ${serviceError.data.error_description}`);
    }
    const parsed = tokenSchema.safeParse(json);
    if (!response.ok || !parsed.success) {
      throw new Error(`The Notion sign-in service returned an unexpected response (${response.status}).`);
    }
    return parsed.data;
  }
}

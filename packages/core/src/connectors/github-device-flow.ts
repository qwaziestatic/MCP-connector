// GitHub sign-in with the OAuth device flow. The app shows a short code, the
// user enters it on github.com, and the app polls for the token. It needs only
// the OAuth app's client ID: no client secret ships in the installer.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
import { z } from "zod";
import type { OAuthTokenSet } from "./connector.types.js";
import { OAuthProviderError } from "./oauth-token.service.js";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface GitHubDeviceAuthorization {
  readonly deviceCode: string;
  /** What the user types on GitHub, for example "WDJB-MJHT". */
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  /** Seconds to wait between token requests. */
  readonly interval: number;
}

export interface GitHubDeviceFlowOptions {
  readonly fetch?: typeof fetch;
  /** Waits between polls; replaceable so tests run instantly. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5)
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  scope: z.string().nullable().optional(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().int().positive().nullable().optional()
});

const errorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
  interval: z.number().int().positive().optional()
});

interface PostResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

const EXPIRED_MESSAGE = "The GitHub code expired before it was entered. Click Connect to get a new code.";
const CANCELLED_MESSAGE = "GitHub sign-in was cancelled.";

/** The useful part of a failed fetch, such as undici's "Connect Timeout Error (…)". */
function networkErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error(CANCELLED_MESSAGE));
    }, { once: true });
  });
}

function describeError(code: string, description: string | undefined): Error {
  switch (code) {
    case "expired_token":
    case "token_expired":
      return new Error(EXPIRED_MESSAGE);
    case "access_denied":
      return new Error("GitHub sign-in was declined on github.com.");
    case "device_flow_disabled":
      return new Error(
        "Device flow is turned off for this GitHub OAuth app. Turn on \"Enable Device Flow\" "
        + "in the app's settings on GitHub, then connect again."
      );
    default:
      return new OAuthProviderError("github", code, description);
  }
}

export class GitHubDeviceFlow {
  private readonly fetch: typeof fetch;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  public constructor(
    private readonly clientId: string,
    private readonly scopes: readonly string[],
    options: GitHubDeviceFlowOptions = {}
  ) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** Asks GitHub for a code to show the user. */
  async start(): Promise<GitHubDeviceAuthorization> {
    const json = await this.post(GITHUB_DEVICE_CODE_URL, {
      client_id: this.clientId,
      scope: this.scopes.join(" ")
    });
    const error = errorSchema.safeParse(json.body);
    if (error.success) throw describeError(error.data.error, error.data.error_description);
    const parsed = deviceCodeSchema.safeParse(json.body);
    if (!json.ok || !parsed.success) {
      throw new Error(`GitHub did not return a sign-in code (${json.status}).`);
    }
    return {
      deviceCode: parsed.data.device_code,
      userCode: parsed.data.user_code,
      verificationUri: parsed.data.verification_uri,
      expiresAt: new Date(this.now() + parsed.data.expires_in * 1000).toISOString(),
      interval: parsed.data.interval
    };
  }

  /**
   * Polls until the user approves, declines, or the code expires. A poll that
   * can't reach GitHub, or that GitHub answers with a server error, doesn't
   * end the sign-in: the code is still valid, so the next poll tries again.
   */
  async waitForToken(authorization: GitHubDeviceAuthorization, signal?: AbortSignal): Promise<OAuthTokenSet> {
    let interval = authorization.interval;
    const expiresAt = Date.parse(authorization.expiresAt);
    // A function, so each check reads the signal anew: it can abort mid-request.
    const cancelled = (): boolean => signal?.aborted === true;
    // Why the last poll failed, if it did, to explain an expiry during an outage.
    let unreachable: string | null = null;
    for (;;) {
      if (cancelled()) throw new Error(CANCELLED_MESSAGE);
      if (this.now() >= expiresAt) {
        throw new Error(unreachable === null
          ? EXPIRED_MESSAGE
          : `MCP Connector could not reach GitHub to finish signing in (${unreachable}). `
            + "Check your internet connection, then click Connect again.");
      }
      // GitHub rejects requests made sooner than the interval.
      await this.sleep(interval * 1000, signal);
      let json: PostResult;
      try {
        json = await this.post(GITHUB_ACCESS_TOKEN_URL, {
          client_id: this.clientId,
          device_code: authorization.deviceCode,
          grant_type: GITHUB_DEVICE_GRANT_TYPE
        }, signal);
      } catch (cause) {
        if (cancelled()) throw new Error(CANCELLED_MESSAGE);
        unreachable = networkErrorText(cause);
        continue;
      }
      if (json.status >= 500) {
        unreachable = `GitHub answered ${json.status}`;
        continue;
      }
      unreachable = null;
      const error = errorSchema.safeParse(json.body);
      if (error.success) {
        if (error.data.error === "authorization_pending") continue;
        if (error.data.error === "slow_down") {
          interval = error.data.interval ?? interval + 5;
          continue;
        }
        throw describeError(error.data.error, error.data.error_description);
      }
      const token = tokenSchema.safeParse(json.body);
      if (!json.ok || !token.success) {
        throw new Error(`GitHub returned an unexpected sign-in response (${json.status}).`);
      }
      return this.toTokenSet(token.data, null);
    }
  }

  /**
   * Renews a token that expires, for OAuth apps with "Expire user access
   * tokens" turned on. Tokens from the device flow renew without a client secret.
   */
  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    const json = await this.post(GITHUB_ACCESS_TOKEN_URL, {
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
    const error = errorSchema.safeParse(json.body);
    if (error.success) throw describeError(error.data.error, error.data.error_description);
    const token = tokenSchema.safeParse(json.body);
    if (!json.ok || !token.success) {
      throw new Error(`GitHub returned an unexpected response while renewing the sign-in (${json.status}).`);
    }
    return this.toTokenSet(token.data, refreshToken);
  }

  private toTokenSet(token: z.infer<typeof tokenSchema>, previousRefreshToken: string | null): OAuthTokenSet {
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? previousRefreshToken,
      expiresAt: token.expires_in === undefined || token.expires_in === null
        ? null
        : new Date(this.now() + token.expires_in * 1000).toISOString(),
      tokenType: token.token_type,
      scope: token.scope ?? null
    };
  }

  private async post(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<PostResult> {
    const response = await this.fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      ...(signal === undefined ? {} : { signal })
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return { ok: response.ok, status: response.status, body: parsed };
  }
}

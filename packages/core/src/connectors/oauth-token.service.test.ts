import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchOAuthTokenService } from "./oauth-token.service.js";

const config = {
  provider: "github" as const,
  authorizationEndpoint: "https://example.test/authorize",
  tokenEndpoint: "https://example.test/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  scopes: ["read:user"]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchOAuthTokenService", () => {
  it("refreshes a token and preserves a rotated refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:user"
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenSet = await new FetchOAuthTokenService().refreshAccessToken(config, "old-refresh");

    expect(tokenSet.accessToken).toBe("new-access");
    expect(tokenSet.refreshToken).toBe("new-refresh");
    expect(tokenSet.expiresAt).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe("POST");
    expect(String(request?.body)).toContain("grant_type=refresh_token");
    expect(String(request?.body)).toContain("refresh_token=old-refresh");
  });

  it("surfaces provider refresh failures without returning a fallback token", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response("revoked", { status: 401 })
    ));

    await expect(
      new FetchOAuthTokenService().refreshAccessToken(config, "revoked-refresh")
    ).rejects.toThrow("OAuth token refresh failed (401)");
  });
});

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

  it.each([
    ["bad_verification_code", "The code passed is incorrect or expired.", "expired or was already used"],
    ["incorrect_client_credentials", "The client_id and/or client_secret passed are incorrect.", "client ID or secret is wrong"],
    ["redirect_uri_mismatch", "The redirect_uri MUST match the registered callback URL.", "does not match"]
  ])("reports GitHub's %s error sent with HTTP 200", async (error, description, hint) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error, error_description: description }), { status: 200 })
    ));

    const exchange = new FetchOAuthTokenService().exchangeCode(config, "code", "verifier", "http://127.0.0.1/cb");

    await expect(exchange).rejects.toThrow(`GitHub sign-in failed: `);
    await expect(exchange).rejects.toThrow(hint);
    await expect(exchange).rejects.toThrow(error);
  });

  it("reports a provider error sent with an error status", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid code." }), { status: 400 })
    ));

    await expect(
      new FetchOAuthTokenService().refreshAccessToken({ ...config, provider: "notion" }, "old")
    ).rejects.toThrow("Notion sign-in failed: The authorization is no longer valid");
  });

  it("reports Notion's API-style error format", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ object: "error", status: 400, code: "invalid_grant", message: "Code expired." }), { status: 400 })
    ));

    await expect(
      new FetchOAuthTokenService().exchangeCode({ ...config, provider: "notion" }, "code", "verifier", "http://127.0.0.1/cb")
    ).rejects.toThrow("Notion sign-in failed: The authorization is no longer valid. Connect again. (invalid_grant: Code expired.)");
  });

  it("does not put tokens in errors for unexpected responses", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 })
    ));

    await expect(
      new FetchOAuthTokenService().exchangeCode(config, "secret-code", "secret-verifier", "http://127.0.0.1/cb")
    ).rejects.toThrow("GitHub returned an unexpected token response.");
  });
});

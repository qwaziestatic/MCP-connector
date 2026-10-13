import { describe, expect, it } from "vitest";
import { OAuthPkceService } from "./oauth-pkce.service.js";

const config = {
  provider: "github" as const,
  authorizationEndpoint: "https://example.test/authorize",
  tokenEndpoint: "https://example.test/token",
  clientId: "client-id",
  scopes: ["read:user"]
};

describe("OAuthPkceService", () => {
  it("creates an S256 authorization request and consumes state once", () => {
    const service = new OAuthPkceService();
    const request = service.beginAuthorization(config, "http://127.0.0.1:1234/oauth/callback");
    const authorizationUrl = new URL(request.authorizationUrl);

    expect(request.state).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("state")).toBe(request.state);
    expect(service.consumeAuthorization(request.state, "github")).toBe(request.codeVerifier);
    expect(() => service.consumeAuthorization(request.state, "github")).toThrow(
      "invalid or does not match"
    );
  });

  it("rejects a state consumed for the wrong provider", () => {
    const service = new OAuthPkceService();
    const request = service.beginAuthorization(config, "http://127.0.0.1:1234/oauth/callback");

    expect(() => service.consumeAuthorization(request.state, "notion")).toThrow(
      "invalid or does not match"
    );
  });
});

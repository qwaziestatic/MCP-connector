import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type {
  ConnectorId,
  OAuthAuthorizationRequest,
  OAuthProviderConfig
} from "./connector.types.js";

const providerSchema = z.enum(["github", "notion"]);
const base64Url = (value: Buffer): string =>
  value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");

interface PendingAuthorization {
  readonly provider: ConnectorId;
  readonly codeVerifier: string;
  readonly createdAt: number;
}

export class OAuthPkceService {
  private readonly pending = new Map<string, PendingAuthorization>();

  beginAuthorization(config: OAuthProviderConfig, redirectUri: string): OAuthAuthorizationRequest {
    const provider = providerSchema.parse(config.provider);
    const state = base64Url(randomBytes(32));
    const codeVerifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    const url = new URL(config.authorizationEndpoint);

    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", config.scopes.join(" "));

    this.pending.set(state, { provider, codeVerifier, createdAt: Date.now() });
    return { provider, state, codeVerifier, authorizationUrl: url.toString() };
  }

  consumeAuthorization(state: string, provider: ConnectorId): string {
    const pending = this.pending.get(state);
    if (pending === undefined || pending.provider !== provider) {
      throw new Error("OAuth state is invalid or does not match the provider.");
    }
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      this.pending.delete(state);
      throw new Error("OAuth authorization request expired.");
    }
    this.pending.delete(state);
    return pending.codeVerifier;
  }
}

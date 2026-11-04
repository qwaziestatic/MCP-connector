// One sign-in flow per kind of sign-in a connector can declare. A new
// connector that signs in like an existing one needs nothing here.
import {
  GitHubDeviceFlow,
  NotionSignInClient,
  type ConnectorDefinition,
  type OAuthTokenSet
} from "@mcp-connector/core";
import type { StoredCredential } from "../security/credential-vault";
import { GitHubSignIn } from "../security/github-sign-in";
import { NotionSignIn } from "../security/notion-sign-in";
import { OAuthCallbackServer } from "../security/oauth-callback-server";
import type { SignInFlow } from "../security/sign-in-flow";
import { readGitHubClientId, readNotionSignInUrl } from "../settings/sign-in-config";

export function createSignInFlow(
  definition: ConnectorDefinition,
  vault: { save(credential: StoredCredential): Promise<void> },
  openExternal: (url: string) => Promise<void>
): SignInFlow {
  const signIn = definition.signIn;
  switch (signIn.kind) {
    case "github-device-flow":
      return new GitHubSignIn(
        definition.id,
        () => new GitHubDeviceFlow(readGitHubClientId(), signIn.scopes),
        vault,
        openExternal
      );
    case "notion-sign-in-service":
      return new NotionSignIn(
        definition.id,
        // Notion's client secret lives in the sign-in service, never in the app.
        () => new NotionSignInClient(readNotionSignInUrl()),
        () => new OAuthCallbackServer(),
        vault,
        openExternal
      );
  }
}

export function createTokenRefresh(
  definition: ConnectorDefinition
): (refreshToken: string) => Promise<OAuthTokenSet> {
  const signIn = definition.signIn;
  switch (signIn.kind) {
    case "github-device-flow":
      // Tokens expire only if the OAuth app has "Expire user access tokens"
      // on; device-flow tokens then renew without a client secret.
      return (refreshToken) => new GitHubDeviceFlow(readGitHubClientId(), signIn.scopes).refresh(refreshToken);
    case "notion-sign-in-service":
      return (refreshToken) => new NotionSignInClient(readNotionSignInUrl()).refresh(refreshToken);
  }
}

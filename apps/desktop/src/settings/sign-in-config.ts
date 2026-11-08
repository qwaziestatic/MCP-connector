// Where the app signs in to GitHub and Notion. Neither value is a secret: the
// GitHub OAuth app's client ID is public, and the Notion sign-in service keeps
// Notion's client secret on the server. They are built into the installer
// (see electron.vite.config.ts), and the environment can override them.

export interface BuiltInSignInConfig {
  /** Client ID of the GitHub OAuth app, with device flow turned on. */
  readonly githubClientId?: string;
  /** Base URL of the Notion sign-in service (apps/notion-sign-in-worker). */
  readonly notionSignInUrl?: string;
}

declare const __MCP_SIGN_IN__: BuiltInSignInConfig | undefined;

const builtIn: BuiltInSignInConfig | undefined = typeof __MCP_SIGN_IN__ === "undefined" ? undefined : __MCP_SIGN_IN__;

function value(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function readGitHubClientId(
  env: NodeJS.ProcessEnv = process.env,
  defaults: BuiltInSignInConfig | undefined = builtIn
): string {
  const clientId = value(env.MCP_GITHUB_CLIENT_ID) ?? value(defaults?.githubClientId);
  if (clientId === undefined) {
    throw new Error(
      "GitHub sign-in is not set up in this copy of MCP Connector: it was built without a GitHub "
      + "OAuth app client ID. See \"Sign-in setup\" in DEPLOYMENT.md."
    );
  }
  return clientId;
}

/** Whether this copy has a Notion sign-in service address, valid or not. */
export function hasNotionSignInUrl(
  env: NodeJS.ProcessEnv = process.env,
  defaults: BuiltInSignInConfig | undefined = builtIn
): boolean {
  return (value(env.MCP_NOTION_SIGN_IN_URL) ?? value(defaults?.notionSignInUrl)) !== undefined;
}

/** Accepts https URLs, and plain http only on this computer (for `wrangler dev`). */
export function readNotionSignInUrl(
  env: NodeJS.ProcessEnv = process.env,
  defaults: BuiltInSignInConfig | undefined = builtIn
): string {
  const raw = value(env.MCP_NOTION_SIGN_IN_URL) ?? value(defaults?.notionSignInUrl);
  if (raw === undefined) {
    throw new Error(
      "Notion sign-in is not set up in this copy of MCP Connector: it was built without the address "
      + "of a Notion sign-in service. See \"Sign-in setup\" in DEPLOYMENT.md."
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`The Notion sign-in address "${raw}" is not a valid URL.`);
  }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !local) {
    throw new Error(`The Notion sign-in address must start with https:// (got "${raw}").`);
  }
  return url.href.replace(/\/+$/, "");
}

# Windows deployment

## Build an installer

From the workspace root:

```powershell
npm install
npm run package:win
```

The unsigned NSIS installer is written to
`apps/desktop/release/MCP-Connector-0.1.0-x64.exe`. The installer allows the
user to select an installation directory and creates Start Menu and Desktop
shortcuts.

The build uses Electron Builder and packages the Electron Vite output under
`apps/desktop/out`. Without signing environment variables, Electron Builder
produces an unsigned installer. For a signed release, configure the signing
credentials before running the same command:

```powershell
$env:CSC_LINK = "C:\secure\certificates\mcp-connector.p12"
$env:CSC_KEY_PASSWORD = "<certificate-password>"
npm run package:win:signed --workspace=@mcp-connector/desktop
```

Do not commit the certificate, password, or any signing-related environment
file. Use a CI secret store or a protected local environment. Electron Builder
will sign the installer and application executables when `CSC_LINK` is set.
The signed command uses
`apps/desktop/electron-builder.signed.yml`; the default command remains the
unsigned local-build path.

## Sign-in setup

### GitHub

GitHub sign-in uses GitHub's device flow: the app shows a short code, the user
enters it on github.com, and the app never needs a client secret. Only the
OAuth app's client ID is built into the installer, and a client ID is public.

1. On GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth
   App**. Use any name (for example "MCP Connector"), and the repository URL
   as both the homepage URL and the callback URL; the device flow does not use
   the callback URL, but the form requires one.
2. Register the app, then tick **Enable Device Flow** on its settings page and
   save. Without it, GitHub refuses the sign-in and the app says so.
3. Copy the **Client ID**. Do not generate a client secret: the app does not use one.
4. Set the client ID while building the installer:

   ```powershell
   $env:MCP_GITHUB_CLIENT_ID = "<client ID>"
   npm run package:win
   ```

   For the release workflow, add it as a repository variable named
   `MCP_GITHUB_CLIENT_ID` under **Settings → Secrets and variables → Actions →
   Variables**. It is not a secret, so it does not need to be stored as one.

Use an OAuth app, not a GitHub App: OAuth app tokens do not expire, so the app
has nothing to refresh. `MCP_GITHUB_CLIENT_ID` set when the app starts
overrides the built-in value, which is useful in `npm run dev`.

### Notion

Notion's token endpoint needs the integration's client secret, which cannot be
kept inside an installer. A small Cloudflare Worker,
[`apps/notion-sign-in-worker`](./apps/notion-sign-in-worker/README.md), holds
the secret and exchanges the sign-in code for the app. Its README walks through
creating the Notion integration and deploying the Worker.

Once it is deployed, build the installer with the Worker's address:

```powershell
$env:MCP_NOTION_SIGN_IN_URL = "https://mcp-connector-notion-sign-in.<your-subdomain>.workers.dev"
npm run package:win
```

For the release workflow, add a repository variable named
`MCP_NOTION_SIGN_IN_URL`, next to `MCP_GITHUB_CLIENT_ID`. The address is not a
secret. `MCP_NOTION_SIGN_IN_URL` set when the app starts overrides the built-in
value; `http://127.0.0.1:8787` works with `npm run dev` in the Worker's folder.

## Runtime configuration

Configure these environment variables before starting the application:

- `MCP_NOTION_DATABASE_ID` (the database the Notion tools add pages to)
- `MCP_HTTP_ENABLED` (set to `true` to always start the MCP server at launch;
  without it, the server starts at launch if it was running when the app last closed)
- `MCP_UPDATER_ENABLED` (set to `true` to enable update checks)
- `MCP_UPDATE_FEED_URL` (required when updater is enabled; generic provider URL)
- `MCP_UPDATE_CHANNEL` (optional release channel override)
- `MCP_UPDATE_FEED_TOKEN` (optional bearer token for authenticated feed endpoints)

OAuth access and refresh tokens are stored after authorization in the
Electron `safeStorage` vault. The installer does not contain those credentials.

For GitHub Releases, the generic feed URL should point to the release asset
directory for the selected version, for example:

```text
https://github.com/qwaziestatic/MCP-connector/releases/download/v0.1.0/
```

The feed must contain Electron Builder's generated `latest.yml` and the
matching signed installer assets. Do not enable the updater until signed
artifacts and a tested feed are available.

## Connecting AI agents

The MCP server listens on `http://127.0.0.1:47820/mcp` and requires a bearer
token. The token is generated once, stored encrypted in the credential vault,
and reused after restarts, so each agent is set up once. In the app, **Copy
setup for Claude Code** and **Copy setup for Cursor** copy a ready-to-paste
command or `mcp.json` entry. **New token** replaces the token; agents set up
with the old one must be set up again.

Non-secret settings live in `settings.json` in the app's user-data folder:

- `mcpPort` (default `47820`) and `vscodePort` (default `47821`). Use `0` to
  pick a free port on every start; the address then changes on each start.
- `mcpServerEnabled` and `vscodeListenerEnabled`, which the app updates when
  you start or stop each listener, so they restart on the next launch.

While the MCP server runs, the app writes its address (not its token) to
`mcp-endpoint.json` in the same folder.

### Stdio mode

For agents that only support stdio, the installed app can be launched as
`"MCP Connector.exe" --mcp-stdio`. It opens no window and no database: it reads
the running app's address from `mcp-endpoint.json` and its token from the
vault, then relays the agent's messages to the running app, so approvals still
happen in its window. If the app or its MCP server isn't running, every request
gets an error that says so. **Copy stdio setup for Claude Code** and **Copy stdio
JSON** in the app produce the setup; they are only offered in the installed app.

On Windows, Electron prints one blank line to stdout before the app's code runs,
so the app cannot prevent it. MCP SDK clients skip it. A client that rejects
blank lines should use the HTTP setup instead.

On Windows, the relay uses its own `stdio-relay` subfolder of the app's data
folder, with a copy of the vault's encryption key. Chromium rewrites `Local
State` when it exits, so a relay sharing the app's profile could replace the key
and lock the app out of its vault. On a new profile the key is saved about ten
seconds after the first launch; until then the relay reports that the server
isn't running.

## Logs and startup errors

The app writes a log to its logs folder (`main.log`, plus `main.old.log` once
the log passes 1 MB): startup steps, listener starts, startup problems and
uncaught exceptions. It never logs tokens or credentials. **Open logs folder**
in the app opens it. If startup fails, the app shows "MCP Connector could not
start" with advice, the error, and the log's location, instead of closing
silently.

## VS Code context listener

The desktop app can start an authenticated loopback WebSocket listener for a
VS Code extension. The renderer displays the generated endpoint and bearer
token after the listener is started.

Messages must be JSON objects with this shape:

```json
{
  "type": "vscode.context",
  "workspacePath": "C:\\workspace",
  "filePath": "C:\\workspace\\src\\index.ts",
  "languageId": "typescript",
  "selectedText": "const value = 1;"
}
```

The listener accepts only `127.0.0.1`, limits message size to 512 KiB, rejects
unknown fields and invalid values, and does not execute workflows. Context is
sanitized and retained only as the latest in-memory context.

The companion client is in
[`apps/vscode-extension`](./apps/vscode-extension). Build it with
`npm run build:vscode`, then launch it through the VS Code extension host and
run **MCP Connector: Configure Listener**.

## Release requirements

Before distributing a production release:

1. Provide a Windows Authenticode certificate through `CSC_LINK` and
   `CSC_KEY_PASSWORD`.
2. Replace the default Electron icon with a reviewed application icon.
3. Configure update hosting and the production feed URL/channel/token values.
4. Run the dependency audit and security review for the release commit.

## Current release validation

The current release artifacts have been validated locally:

- Windows x64 NSIS installer: `apps/desktop/release/MCP-Connector-0.1.0-x64.exe`
- VS Code extension: `apps/vscode-extension/mcp-connector-vscode-0.1.0.vsix`
- Workspace tests, type checks, and production builds pass.

The artifacts are not yet production releases. The Windows installer is
unsigned and uses the default Electron icon. Prisma has been migrated to v7
with `prisma.config.ts`, schema datasource URL removal, and the SQLite driver
adapter integration in the Electron main process.
`npm audit --omit=dev` is currently clean (0 runtime vulnerabilities) on this
workspace state. Electron is a devDependency whose runtime ships in the
installer, so `npm audit --audit-level=high` must also pass; the remaining
moderate advisories are in build and lint tooling only.

The SQLite driver uses `better-sqlite3` 13, which is built on N-API, so one
prebuilt binary loads in both Node.js and Electron and no native rebuild is
needed. The generated Prisma client in `node_modules/.prisma/client` is copied
into the application archive explicitly because Electron Builder does not
collect it as a dependency.

Automated CI and manual release artifact workflows are defined in
`.github/workflows/ci.yml` and `.github/workflows/release.yml`. The complete
manual verification procedure is in [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md).

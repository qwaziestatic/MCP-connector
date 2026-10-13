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

## Runtime configuration

OAuth client IDs and secrets are runtime configuration. Do not add them to the
installer, source tree, or renderer bundle. Configure these environment
variables before starting the application:

- `MCP_GITHUB_CLIENT_ID`
- `MCP_GITHUB_CLIENT_SECRET`
- `MCP_NOTION_CLIENT_ID`
- `MCP_NOTION_CLIENT_SECRET`
- `MCP_NOTION_DATABASE_ID`
- `MCP_HTTP_ENABLED` (set to `true` to enable the authenticated loopback MCP server)

OAuth access and refresh tokens are stored after authorization in the
Electron `safeStorage` vault. The installer does not contain those credentials.

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
3. Configure update hosting and an update policy.
4. Run the dependency audit and security review for the release commit.

## Current release validation

The current release artifacts have been validated locally:

- Windows x64 NSIS installer: `apps/desktop/release/MCP-Connector-0.1.0-x64.exe`
- VS Code extension: `apps/vscode-extension/mcp-connector-vscode-0.1.0.vsix`
- Workspace tests, type checks, and production builds pass.

The artifacts are not yet production releases. The Windows installer is
unsigned and uses the default Electron icon. The dependency audit still
reports three high-severity findings in the Prisma CLI development toolchain;
the available automatic fix is a breaking/downgrading Prisma change and has
not been applied. A dedicated Prisma 7 migration is required before that
finding can be remediated safely.

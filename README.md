# MCP Connector

MCP Connector is a Windows Electron desktop application for exposing
user-approved local workspace context and cloud integrations as Model Context
Protocol (MCP) tools.

## Status

The repository contains the feature-complete MVP implementation:

- Electron + React + TypeScript desktop shell
- Isolated, typed `contextBridge` IPC
- User-selected filesystem workspace inspection
- Human-in-the-loop previews for mutating actions
- Durable workflow previews and audit logging
- DPAPI-backed credential storage through Electron `safeStorage`
- GitHub sign-in with a short code (device flow) and Notion sign-in through a
  small sign-in service, so no client secret ships in the installer
- Connectors for GitHub and Notion, each described by one connector definition,
  so adding a service does not touch the rest of the app (see "Adding a
  connector" below)
- Authenticated loopback MCP HTTP and stdio transports
- Authenticated VS Code context listener and companion extension
- Windows NSIS installer and VSIX packaging

## Install

Download the installer from
[Releases](https://github.com/qwaziestatic/MCP-connector/releases) and run it
(Windows 10 or 11, 64-bit). The beta is not code-signed yet, so Windows may
say "Windows protected your PC": click **More info**, then **Run anyway**.
Each release's notes walk through setting up an agent; the same steps are in
[skills/mcp-connector/references/setup.md](./skills/mcp-connector/references/setup.md).

To build and release it yourself, see [DEPLOYMENT.md](./DEPLOYMENT.md) and
[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md).

## Requirements

- Windows for the desktop application
- Node.js 22.12 or newer
- npm 11

## Install and validate

From the repository root:

```powershell
npm install
npm run prisma:generate
npm run typecheck
npm test
npm run build
```

## Run the desktop application

```powershell
npm run dev
```

The application stores its SQLite database under the Electron user-data
directory and stores OAuth credentials in the Windows-protected
`safeStorage` vault. Do not place provider secrets in source files,
`.env` files, or the renderer bundle.

Optional provider and MCP configuration is documented in
[DEPLOYMENT.md](./DEPLOYMENT.md).

## Build distributables

Unsigned Windows installer:

```powershell
npm run package:win
```

VS Code extension:

```powershell
npm run package:vscode
```

The generated installer, VSIX, and other build artifacts are ignored by Git.
Publish them as release assets rather than committing them to the source tree.

## Other MCP servers

MCP Connector can stand in front of other MCP servers, so their tools get the
same approval screen and audit log as its own. Under **Other MCP servers** in
the app, paste the `"mcpServers"` block from a server's README, for example:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Projects"]
    }
  }
}
```

- Agents see each tool as `<server>__<tool>`, for example `files__read_file`,
  with the server's own parameters.
- Tools the server marks read-only run at once. Every other call returns a
  preview; once you approve it, the agent runs it with
  `external_run_approved_call`. Set a server to **Ask before every tool** to
  approve everything it does.
- Programs (`"command"`) and streamable HTTP servers (`"url"`) are supported;
  the older SSE transport is not.
- `"env"` values and `"headers"` are kept in the encrypted vault, not in
  `settings.json`. A program gets only the usual environment (PATH, the user
  folders, and proxy settings) plus its own variables.
- MCP Connector starts the command you paste, so add only servers you trust.
  Servers started with `npx` need Node.js installed.

## Agent skill

`skills/mcp-connector` is an agent skill in the open `SKILL.md` format. It
tells any agent that has the `mcp-connector` tools when to use them, and the
rules for changes: preview first, wait for the user's approval in the app,
and never report a change before it happened. `references/` holds the tool
list and the setup steps for each agent. A test in `packages/core` fails if
the tool list and the server's tools ever differ.

To upload it to a skill marketplace such as Agensi:

```powershell
npm run package:skill
```

This checks the frontmatter and writes `release/mcp-connector-skill.zip`.

## Adding a connector

Each service is one `ConnectorDefinition` in `packages/core/src/connectors`;
`github.definition.ts` and `notion.definition.ts` are the examples. A
definition gives:

- `id` and `name`, used by the vault, the settings, and the window;
- `signIn`, one of the sign-in kinds the app has (a device code, or the
  browser through the sign-in service); a service that signs in like an
  existing one needs no new sign-in code;
- `settings`, the values the user sets in the window, each with a `parse`
  function that explains a bad value;
- `registerTools`, the service's MCP tools; and
- `previews`, if the service's tools change anything: the preview is shown to
  the user, and `prepare` checks the sign-in and settings before an approval
  is used.

Add the definition to `createBuiltInConnectors` in `built-in.ts`. The vault,
the connections card, the settings file, and the MCP server pick it up from
there. Add its tools to `skills/mcp-connector/references/tools.md` and
`SKILL.md`; the skill test lists any that are missing. Tools read sign-in and settings when they run, so connecting a service
or changing a setting reaches a server that is already running.

## Security model

Mutating operations never execute silently. They follow this sequence:

1. Generate a structured preview.
2. Present the preview for explicit user approval.
3. Execute only the approved preview.
4. Record the result in the audit log.

Filesystem access is limited to the workspace root explicitly selected by the
user. MCP HTTP and VS Code listeners bind to loopback only and require
bearer authentication. To report a security problem, see
[SECURITY.md](./SECURITY.md).

## Privacy

MCP Connector has no telemetry, analytics, or crash reporting, and no server of
its own that sees your data. It talks only to the services you connect: GitHub,
Notion (through the sign-in service, which passes tokens through without
storing them), and the MCP servers you add. Your settings, approvals, and audit
log stay on your computer.

## License

MIT, copyright (c) 2026 Dagim Tsegaye. See [LICENSE](./LICENSE).

# MCP Connector

MCP Connector is an Electron desktop application for Windows and Linux that
exposes user-approved local workspace context and cloud integrations as Model
Context Protocol (MCP) tools.

## Status

The repository contains the feature-complete MVP implementation:

- Electron + React + TypeScript desktop shell
- Isolated, typed `contextBridge` IPC
- User-selected filesystem workspace inspection, and reading one text file
  at a time (never `.env` files, private keys or anything in `.git`)
- Human-in-the-loop previews for mutating actions
- Durable workflow previews and audit logging
- Credential storage through Electron `safeStorage`: DPAPI on Windows, GNOME
  Keyring or KWallet on Linux (without a keyring, the app stores no secrets)
- GitHub sign-in with a short code (device flow) and Notion sign-in through a
  small sign-in service, so no client secret ships in the installer
- Connectors for GitHub and Notion, each described by one connector definition,
  so adding a service does not touch the rest of the app (see "Adding a
  connector" below)
- Authenticated loopback MCP HTTP and stdio transports
- A separate key for web chats, through the browser extension, that can be
  replaced or turned off without setting up agents again
- A Chrome extension that lets a chat on chatgpt.com ask for tools: you tick
  the tools a chat may use and run each request yourself
- Authenticated VS Code context listener and companion extension
- Windows NSIS installer, Linux AppImage and .deb, VSIX and Chrome extension
  packaging

## Install

Download MCP Connector from
[Releases](https://github.com/qwaziestatic/MCP-connector/releases). Each
release's notes walk through setting up an agent; the same steps are in
[skills/mcp-connector/references/setup.md](./skills/mcp-connector/references/setup.md).

**Windows** (10 or 11, 64-bit): run the `.exe` installer. The beta is not
code-signed yet, so Windows may say "Windows protected your PC": click **More
info**, then **Run anyway**.

**Linux** (64-bit): on Ubuntu, Debian and their derivatives, install the
`.deb`:

```sh
sudo apt install ./MCP-Connector-<version>-amd64.deb
```

Elsewhere, use the AppImage. It needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04
and newer, `libfuse2` on older releases):

```sh
chmod +x MCP-Connector-<version>-x86_64.AppImage
./MCP-Connector-<version>-x86_64.AppImage
```

On Linux, MCP Connector keeps its tokens in the system keyring, so it needs
GNOME Keyring or KWallet, installed and unlocked; most desktops have one. On
Ubuntu 23.10 and newer, the AppImage also needs an AppArmor profile, which
the .deb installs for itself; the release notes have both details. Settings,
the database and logs are in `~/.config/@mcp-connector/desktop`
(`%APPDATA%\@mcp-connector\desktop` on Windows).

To build and release it yourself, see [DEPLOYMENT.md](./DEPLOYMENT.md) and
[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md).

## Requirements

- Windows or Linux (x64) for the desktop application; the Windows installer
  is built on Windows and the Linux packages on Linux
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
directory and stores OAuth credentials in the `safeStorage` vault, which the
system protects: DPAPI on Windows, the keyring on Linux. Do not place provider
secrets in source files, `.env` files, or the renderer bundle.

Optional provider and MCP configuration is documented in
[DEPLOYMENT.md](./DEPLOYMENT.md).

## Build distributables

Unsigned Windows installer, on Windows:

```powershell
npm run package:win
```

Linux AppImage and .deb, on Linux (x64):

```sh
npm run package:linux
```

VS Code extension:

```powershell
npm run package:vscode
```

Chrome extension, as `release/mcp-connector-chrome-<version>.zip`:

```powershell
npm run package:chrome
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

## Web chats

A chat on chatgpt.com can ask for the same tools through the Chrome
extension in [`apps/chrome-extension`](./apps/chrome-extension/README.md).
Its README has the install steps and says exactly what leaves your computer.

- In the app, **Create key** under **Web chats** makes the extension's own
  key. Paste it, and the port, into the extension's options.
- In the extension's side panel you tick the tools a chat may use; none are
  ticked to begin with. The chat writes a request, and it runs only when you
  click **Run** in the side panel.
- A request that needs approval waits in the app as "Web chat". With **Ask
  before web chats read anything** on, which is the default, that includes
  read-only tools.
- You put the result in the chat box and press Send yourself.

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
- `registerTools`, the service's MCP tools. A tool that makes a preview
  passes on the `source` it is given, so the preview says whether an agent or
  a web chat asked, and answers with `previewResult`, naming the tool that
  runs the preview once it is approved; and
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
user. `filesystem_read_file` reads one text file inside it, up to 1,000,000
bytes, and refuses files that usually hold secrets even there:

- `.env` and `.env.*`, except `.env.example`, `.env.sample` and
  `.env.template`;
- `.npmrc`, `.netrc` and `.pypirc`;
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `*.jks` and `*.keystore`;
- `*.tfstate`, `*.tfstate.*` and `*.tfvars`;
- SSH private keys such as `id_rsa`; and
- anything inside a `.git`, `.ssh` or `.aws` folder.

On Windows it also refuses any path with a colon after the drive letter,
which would name a hidden stream of a file. This list is a safety net for
common cases, not a complete list of secret files: a secret in a file with
another name is read like any other text. Select a workspace that holds
nothing you would not show an agent. MCP HTTP and VS Code listeners bind to loopback only and require
bearer authentication.

Web chats use the browser extension's own key, created under **Web chats** in
the app. Their requests follow the same sequence and are marked as a web
chat's in the approval queue and the audit log. With **Ask before web chats
read anything** on, which is the default, their read-only requests wait for
approval too; agents' read-only tools still run at once. See "Web chats" in
[DEPLOYMENT.md](./DEPLOYMENT.md).

To report a security problem, see [SECURITY.md](./SECURITY.md).

## Privacy

MCP Connector has no telemetry, analytics, or crash reporting, and no server of
its own that sees your data. It talks only to the services you connect: GitHub,
Notion (through the sign-in service, which passes tokens through without
storing them), and the MCP servers you add. Your settings, approvals, and audit
log stay on your computer.

The audit log keeps each request as you saw it, with its arguments, and what
came of it. For a call to another MCP server and for a web chat's read, that
is a shortened copy of the tool's result, up to 2,000 characters; the agent
or web chat that asked gets the whole result. A file read with
`filesystem_read_file` is the exception: the log records the file's path,
the lines read and the number of characters returned, and none of the text.
The log is in the app's database, on this computer only.

## License

MIT, copyright (c) 2026 Dagim Tsegaye. See [LICENSE](./LICENSE).

The MCP Connector name and cloud mascot are not covered by the MIT License;
forks should use their own icon.

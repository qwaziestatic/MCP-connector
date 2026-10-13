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
- OAuth PKCE flows with token refresh support
- GitHub and Notion connectors
- Authenticated loopback MCP HTTP and stdio transports
- Authenticated VS Code context listener and companion extension
- Windows NSIS installer and VSIX packaging

The current Windows installer is an unsigned development/review artifact.
Production distribution still requires Authenticode signing, approved
branding, clean-machine validation, and real provider OAuth testing. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for release procedures and limitations.

## Requirements

- Windows for the desktop application
- Node.js 22 or newer
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

## Security model

Mutating operations never execute silently. They follow this sequence:

1. Generate a structured preview.
2. Present the preview for explicit user approval.
3. Execute only the approved preview.
4. Record the result in the audit log.

Filesystem access is limited to the workspace root explicitly selected by the
user. MCP HTTP and VS Code listeners bind to loopback only and require
per-launch bearer authentication.

## License

This project is proprietary. See [LICENSE](./LICENSE) for redistribution and
usage terms.

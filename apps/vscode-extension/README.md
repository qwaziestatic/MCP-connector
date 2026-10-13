# MCP Connector VS Code extension

This package is proprietary software. Redistribution or modification requires
written authorization from MCP Connector.

This optional extension sends active-editor context to a running MCP
Connector desktop listener. It does not execute MCP tools or workflows.

## Local development

```powershell
npm install
npm run build:vscode
npm run package:vscode
```

Open `apps/vscode-extension` in VS Code, press `F5`, then run
**MCP Connector: Configure Listener**. Paste the `ws://127.0.0.1:<port>`
endpoint and bearer token displayed by the desktop application's VS Code
context card.

The bearer token is stored in VS Code `SecretStorage`, not in settings.
Document text transmission is disabled by default and can be enabled with
`mcpConnector.sendDocumentText`. Active selections and document text are
bounded before transmission.

The packaging command creates `mcp-connector-vscode-0.1.0.vsix` in the
workspace root of the extension. Install it locally with:

```powershell
code --install-extension mcp-connector-vscode-0.1.0.vsix
```

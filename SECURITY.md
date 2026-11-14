# Security

MCP Connector holds sign-in tokens and decides what AI agents may do on your
computer, so security problems matter more than most bugs.

## Reporting a vulnerability

Please report it privately, not in a public issue: on GitHub, open the
repository's **Security** tab and choose **Report a vulnerability**. Include
what you found, how to reproduce it, and which version you used.

You will get an answer within a week. Once a fix is released, the report is
published with credit to you, unless you prefer otherwise.

## What MCP Connector protects

- Agents reach only the folder you select, and only through MCP Connector's
  tools.
- Every tool that changes something, including tools from other MCP servers
  you add, waits for your approval in the app and runs once, exactly as
  approved. The audit log records each step.
- Sign-in tokens, the app's own tokens and the keys of other MCP servers are
  encrypted by your system: Windows' data protection (DPAPI), or GNOME Keyring
  or KWallet on Linux. They are never stored in plain files, and on Linux
  without a keyring the app stores none.
- The MCP server and the VS Code listener listen only on this computer
  (127.0.0.1) and require a bearer token.
- Web chats reach the MCP server only with the browser extension's own key,
  which you create, replace or turn off in the app without affecting agents.
  Whatever they ask for is marked as a web chat's in the approval queue and
  the audit log. While "Ask before web chats read anything" is on, which it
  is by default, their reads wait for your approval too.

Reports that break any of these are in scope.

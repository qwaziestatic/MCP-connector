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
- Sign-in tokens and the keys of other MCP servers are encrypted with Windows'
  data protection, never stored in plain files.
- The MCP server and the VS Code listener listen only on this computer
  (127.0.0.1) and require a bearer token.

Reports that break any of these are in scope.

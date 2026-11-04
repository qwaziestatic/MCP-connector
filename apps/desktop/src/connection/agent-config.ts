// Ready-to-paste setup for connecting AI agents to MCP Connector's MCP server.

export const MCP_SERVER_NAME = "mcp-connector";

export interface AgentConfigs {
  /** A `claude mcp add` command for Claude Code. */
  readonly claudeCode: string;
  /** An entry for Cursor's mcp.json. */
  readonly cursor: string;
  /** An entry for VS Code's mcp.json, used by GitHub Copilot's agent mode. */
  readonly vsCode: string;
  /** A table for Codex's config.toml. */
  readonly codex: string;
  /** A `gemini mcp add` command for Gemini CLI. */
  readonly geminiCli: string;
  /** An entry for Windsurf's mcp_config.json. */
  readonly windsurf: string;
  /** A `claude mcp add` command that runs the app in stdio mode. Packaged builds only. */
  readonly claudeCodeStdio: string | null;
  /** A stdio entry in the common mcpServers JSON format. Packaged builds only. */
  readonly stdioJson: string | null;
}

export interface AgentConfigInput {
  readonly url: string;
  readonly bearerToken: string;
  /** How to start the app in stdio mode, when it is installed. */
  readonly stdio?: { readonly command: string; readonly args: readonly string[] };
  readonly platform?: NodeJS.Platform;
}

// Windows paths cannot contain double quotes, so quoting them is enough there.
// Elsewhere, single quotes are the safe POSIX shell form.
function quoteForShell(value: string, platform: NodeJS.Platform): string {
  if (/^[\w./:=@-]+$/u.test(value)) return value;
  return platform === "win32" ? `"${value}"` : `'${value.replace(/'/gu, "'\\''")}'`;
}

export function buildAgentConfigs(input: AgentConfigInput): AgentConfigs {
  const platform = input.platform ?? process.platform;
  const authorization = `Bearer ${input.bearerToken}`;
  const stdio = input.stdio;
  return {
    claudeCode: `claude mcp add --transport http ${MCP_SERVER_NAME} ${input.url} `
      + `--header "Authorization: ${authorization}"`,
    cursor: JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { url: input.url, headers: { Authorization: authorization } }
      }
    }, null, 2),
    vsCode: JSON.stringify({
      servers: {
        [MCP_SERVER_NAME]: { type: "http", url: input.url, headers: { Authorization: authorization } }
      }
    }, null, 2),
    // JSON strings are valid TOML basic strings for these values.
    codex: [
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `url = ${JSON.stringify(input.url)}`,
      `http_headers = { "Authorization" = ${JSON.stringify(authorization)} }`
    ].join("\n"),
    geminiCli: `gemini mcp add --scope user --transport http --header "Authorization: ${authorization}" `
      + `${MCP_SERVER_NAME} ${input.url}`,
    windsurf: JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { serverUrl: input.url, headers: { Authorization: authorization } }
      }
    }, null, 2),
    claudeCodeStdio: stdio === undefined
      ? null
      : `claude mcp add --transport stdio ${MCP_SERVER_NAME} -- `
        + [stdio.command, ...stdio.args].map((part) => quoteForShell(part, platform)).join(" "),
    stdioJson: stdio === undefined
      ? null
      : JSON.stringify({
          mcpServers: { [MCP_SERVER_NAME]: { command: stdio.command, args: stdio.args } }
        }, null, 2)
  };
}

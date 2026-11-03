// Ready-to-paste setup for connecting AI agents to MCP Connector's MCP server.

export const MCP_SERVER_NAME = "mcp-connector";

export interface AgentConfigs {
  /** A `claude mcp add` command for Claude Code. */
  readonly claudeCode: string;
  /** An entry for Cursor's mcp.json. */
  readonly cursor: string;
}

export function buildAgentConfigs(endpoint: { readonly url: string; readonly bearerToken: string }): AgentConfigs {
  const authorization = `Bearer ${endpoint.bearerToken}`;
  return {
    claudeCode: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint.url} `
      + `--header "Authorization: ${authorization}"`,
    cursor: JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { url: endpoint.url, headers: { Authorization: authorization } }
      }
    }, null, 2)
  };
}

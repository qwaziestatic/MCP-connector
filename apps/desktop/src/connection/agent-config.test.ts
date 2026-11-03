import { describe, expect, it } from "vitest";
import { buildAgentConfigs } from "./agent-config";

describe("buildAgentConfigs", () => {
  const endpoint = { url: "http://127.0.0.1:47820/mcp", bearerToken: "abc_DEF-123" };

  it("builds the Claude Code command from its documented syntax", () => {
    expect(buildAgentConfigs(endpoint).claudeCode).toBe(
      'claude mcp add --transport http mcp-connector http://127.0.0.1:47820/mcp --header "Authorization: Bearer abc_DEF-123"'
    );
  });

  it("builds a valid Cursor mcp.json entry", () => {
    expect(JSON.parse(buildAgentConfigs(endpoint).cursor)).toEqual({
      mcpServers: {
        "mcp-connector": {
          url: "http://127.0.0.1:47820/mcp",
          headers: { Authorization: "Bearer abc_DEF-123" }
        }
      }
    });
  });
});

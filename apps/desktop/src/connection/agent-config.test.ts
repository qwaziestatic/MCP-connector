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

  it("leaves out stdio setup when the app is not installed", () => {
    const configs = buildAgentConfigs(endpoint);
    expect(configs.claudeCodeStdio).toBeNull();
    expect(configs.stdioJson).toBeNull();
  });

  it("quotes a Windows path with spaces for the stdio command", () => {
    const configs = buildAgentConfigs({
      ...endpoint,
      platform: "win32",
      stdio: { command: "C:\\Users\\leul\\AppData\\Local\\Programs\\MCP Connector\\MCP Connector.exe", args: ["--mcp-stdio"] }
    });

    expect(configs.claudeCodeStdio).toBe(
      'claude mcp add --transport stdio mcp-connector -- "C:\\Users\\leul\\AppData\\Local\\Programs\\MCP Connector\\MCP Connector.exe" --mcp-stdio'
    );
    expect(JSON.parse(configs.stdioJson!)).toEqual({
      mcpServers: {
        "mcp-connector": {
          command: "C:\\Users\\leul\\AppData\\Local\\Programs\\MCP Connector\\MCP Connector.exe",
          args: ["--mcp-stdio"]
        }
      }
    });
  });

  it("single-quotes a macOS path for POSIX shells", () => {
    const configs = buildAgentConfigs({
      ...endpoint,
      platform: "darwin",
      stdio: { command: "/Applications/MCP Connector.app/Contents/MacOS/MCP Connector", args: ["--mcp-stdio"] }
    });

    expect(configs.claudeCodeStdio).toBe(
      "claude mcp add --transport stdio mcp-connector -- '/Applications/MCP Connector.app/Contents/MacOS/MCP Connector' --mcp-stdio"
    );
  });
});

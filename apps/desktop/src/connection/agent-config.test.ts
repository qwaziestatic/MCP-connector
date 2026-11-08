import { describe, expect, it } from "vitest";
import { buildAgentConfigs, stdioCommand } from "./agent-config";

describe("stdioCommand", () => {
  const execPath = "/tmp/.mount_MCP-CoAbC123/mcp-connector";

  it("uses the AppImage file, which stays put, instead of its temporary mount", () => {
    expect(stdioCommand({
      execPath,
      platform: "linux",
      env: { APPIMAGE: "/home/leul/Applications/MCP-Connector-0.2.0-x86_64.AppImage" }
    })).toBe("/home/leul/Applications/MCP-Connector-0.2.0-x86_64.AppImage");
  });

  it("uses the executable itself outside an AppImage, such as the .deb's", () => {
    expect(stdioCommand({ execPath: "/opt/MCP Connector/mcp-connector", platform: "linux", env: {} }))
      .toBe("/opt/MCP Connector/mcp-connector");
    expect(stdioCommand({ execPath: "/opt/MCP Connector/mcp-connector", platform: "linux", env: { APPIMAGE: "" } }))
      .toBe("/opt/MCP Connector/mcp-connector");
  });

  it("ignores APPIMAGE on Windows", () => {
    const exe = "C:\\Users\\leul\\AppData\\Local\\Programs\\MCP Connector\\MCP Connector.exe";
    expect(stdioCommand({ execPath: exe, platform: "win32", env: { APPIMAGE: "/somewhere/else.AppImage" } })).toBe(exe);
  });

  it("quotes an AppImage path with spaces in the Claude Code command", () => {
    const command = stdioCommand({ execPath, platform: "linux", env: { APPIMAGE: "/home/leul/My Apps/MCP.AppImage" } });
    const configs = buildAgentConfigs({
      url: "http://127.0.0.1:47820/mcp",
      bearerToken: "abc",
      platform: "linux",
      stdio: { command, args: ["--mcp-stdio"] }
    });
    expect(configs.claudeCodeStdio).toBe("claude mcp add --transport stdio mcp-connector -- '/home/leul/My Apps/MCP.AppImage' --mcp-stdio");
  });
});

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

  it("builds VS Code's mcp.json entry, which uses \"servers\" and a type", () => {
    expect(JSON.parse(buildAgentConfigs(endpoint).vsCode)).toEqual({
      servers: {
        "mcp-connector": {
          type: "http",
          url: "http://127.0.0.1:47820/mcp",
          headers: { Authorization: "Bearer abc_DEF-123" }
        }
      }
    });
  });

  it("builds Codex's config.toml table", () => {
    expect(buildAgentConfigs(endpoint).codex).toBe([
      "[mcp_servers.mcp-connector]",
      'url = "http://127.0.0.1:47820/mcp"',
      'http_headers = { "Authorization" = "Bearer abc_DEF-123" }'
    ].join("\n"));
  });

  it("builds the Gemini CLI command, saved for the user rather than one project", () => {
    expect(buildAgentConfigs(endpoint).geminiCli).toBe(
      'gemini mcp add --scope user --transport http --header "Authorization: Bearer abc_DEF-123" mcp-connector http://127.0.0.1:47820/mcp'
    );
  });

  it("builds Windsurf's mcp_config.json entry, which uses serverUrl", () => {
    expect(JSON.parse(buildAgentConfigs(endpoint).windsurf)).toEqual({
      mcpServers: {
        "mcp-connector": {
          serverUrl: "http://127.0.0.1:47820/mcp",
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

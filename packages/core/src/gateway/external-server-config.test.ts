import { describe, expect, it } from "vitest";
import { parseServerSetup, toServerId } from "./external-server-config.js";

describe("parseServerSetup", () => {
  it("reads the mcpServers block a README gives, keeping env values as secrets", () => {
    const [files, github] = parseServerSetup(JSON.stringify({
      mcpServers: {
        files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Projects"] },
        "GitHub Issues": { command: "docker", args: ["run", "-i", "ghcr.io/github/github-mcp-server"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" } }
      }
    }));

    expect(files).toEqual({
      config: { id: "files", name: "files", approval: "changes", transport: { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Projects"] } },
      secrets: { env: {}, headers: {} }
    });
    expect(github?.config).toMatchObject({ id: "github-issues", name: "GitHub Issues" });
    expect(github?.secrets.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" });
    expect(JSON.stringify(github?.config)).not.toContain("ghp_secret");
  });

  it("reads HTTP servers in the formats different agents use", () => {
    const servers = parseServerSetup(JSON.stringify({
      servers: {
        a: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
        b: { serverUrl: "https://b.example.com/mcp" },
        c: { httpUrl: "http://127.0.0.1:9000/mcp" }
      }
    }));

    expect(servers.map((server) => server.config.transport)).toEqual([
      { kind: "http", url: "https://mcp.example.com/mcp" },
      { kind: "http", url: "https://b.example.com/mcp" },
      { kind: "http", url: "http://127.0.0.1:9000/mcp" }
    ]);
    expect(servers[0]?.secrets.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("accepts a bare map of servers and the chosen approval mode", () => {
    const [server] = parseServerSetup('{"memory": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]}}', { approval: "all" });
    expect(server?.config).toMatchObject({ id: "memory", approval: "all" });
  });

  it("gives each server an id no other server has", () => {
    const servers = parseServerSetup('{"mcpServers": {"files": {"command": "a"}, "Files!": {"command": "b"}}}', { takenIds: new Set(["files"]) });
    expect(servers.map((server) => server.config.id)).toEqual(["files-2", "files-3"]);
  });

  it.each([
    ["not json", "not valid JSON"],
    ["[]", "not a server setup"],
    ['{"mcpServers": {}}', "No servers were found"],
    ['{"command": "npx", "args": []}', "Give the server a name"],
    ['{"mcpServers": {"x": {"args": ["a"]}}}', 'neither a "command" nor a "url"'],
    ['{"mcpServers": {"x": {"url": "https://example.com/sse"}}}', "older SSE transport"],
    ['{"mcpServers": {"x": {"type": "sse", "url": "https://example.com/events"}}}', "older SSE transport"],
    ['{"mcpServers": {"x": {"url": "file:///etc/passwd"}}}', "must start with https://"],
    ['{"mcpServers": {"x": {"command": 42}}}', "not in the usual format"]
  ])("explains %s", (text, message) => {
    expect(() => parseServerSetup(text)).toThrow(message);
  });
});

describe("toServerId", () => {
  it.each([
    ["files", "files"],
    ["My Notes (local)", "my-notes-local"],
    ["123", "server-123"],
    ["!!!", "server"],
    ["a".repeat(50), "a".repeat(28)]
  ])("turns %s into %s", (name, id) => {
    expect(toServerId(name, new Set())).toBe(id);
  });
});

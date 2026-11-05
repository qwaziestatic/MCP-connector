// A small MCP server over stdio, for the gateway tests. It reports the one
// environment variable the test gives it, and nothing from the parent's.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "whoami",
  {
    description: "Says which token it was started with.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        token: process.env.ECHO_TOKEN ?? null,
        parentSecret: process.env.PARENT_SECRET ?? null,
        proxy: process.env.HTTPS_PROXY ?? null
      })
    }]
  })
);
server.registerTool(
  "shout",
  { description: "Repeats a word in capitals.", inputSchema: { word: z.string() } },
  async ({ word }) => ({ content: [{ type: "text", text: word.toUpperCase() }] })
);
await server.connect(new StdioServerTransport());

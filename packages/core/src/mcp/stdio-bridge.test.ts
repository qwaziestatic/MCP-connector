import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import { startMcpHttpServer, type McpHttpServerHandle } from "./http.js";
import { MCP_CONNECTOR_NOT_RUNNING, runStdioBridge } from "./stdio-bridge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(): Promise<McpHttpServerHandle> {
  const server = await startMcpHttpServer({
    filesystem: new FilesystemService(),
    workflow: new WorkflowService(new InMemoryAuditRepository())
  }, { bearerToken: "secret-token" });
  cleanups.push(() => server.close());
  return server;
}

/** Starts a bridge on in-memory streams and returns helpers to talk to it like an agent. */
function connect(url: string | null, bearerToken = "secret-token") {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Array<Record<string, unknown>> = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      received.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
    }
  });
  const done = runStdioBridge({ url, bearerToken, input, output });
  const send = (message: Record<string, unknown>) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const response = async (id: number) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = received.find((message) => message.id === id);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No response to request ${id}.`);
  };
  cleanups.push(async () => {
    input.end();
    await done;
  });
  return { send, response, input, done };
}

const initialize = {
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1.0.0" } }
};

describe("runStdioBridge", () => {
  it("relays an agent's requests to the running app and its answers back", async () => {
    const server = await startServer();
    const agent = connect(server.url);

    agent.send(initialize);
    expect(await agent.response(1)).toMatchObject({ result: { serverInfo: { name: "mcp-connector" } } });
    agent.send({ method: "notifications/initialized" });
    agent.send({ id: 2, method: "tools/list", params: {} });
    const tools = (await agent.response(2)).result as { tools: Array<{ name: string }> };
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "workspace_get_selected",
      "notion_create_project_page_preview"
    ]));
  });

  it("stops when the agent closes its input", async () => {
    const server = await startServer();
    const agent = connect(server.url);
    agent.input.end();
    await expect(agent.done).resolves.toBeUndefined();
  });

  it("tells the agent that the app is not running when it has no address", async () => {
    const agent = connect(null);
    agent.send(initialize);
    expect(await agent.response(1)).toMatchObject({ error: { message: MCP_CONNECTOR_NOT_RUNNING } });
  });

  it("tells the agent that the app is not running when nothing listens at the address", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    const agent = connect(`http://127.0.0.1:${port}/mcp`);

    agent.send(initialize);
    expect(await agent.response(1)).toMatchObject({ error: { message: MCP_CONNECTOR_NOT_RUNNING } });
  });

  it("explains a token mismatch", async () => {
    const server = await startServer();
    const agent = connect(server.url, "wrong-token");
    agent.send(initialize);
    expect(await agent.response(1)).toMatchObject({ error: { message: expect.stringContaining("token changed") } });
  });
});

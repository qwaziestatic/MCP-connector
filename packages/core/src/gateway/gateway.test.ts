import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import { createMcpServer } from "../mcp/mcp-server.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import type { ExternalServerConfig } from "./external-server-config.js";
import { createExternalTransport, ExternalServers } from "./external-servers.js";
import { externalToolName } from "./gateway-tools.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A downstream server like the ones users add: one read-only tool, one that writes. */
function downstream() {
  const writes: string[] = [];
  const server = new McpServer({ name: "notes", version: "1.0.0" });
  server.registerTool(
    "list_notes",
    { description: "List notes.", inputSchema: { tag: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ tag }) => ({ content: [{ type: "text", text: `notes tagged ${tag ?? "any"}` }] })
  );
  server.registerTool(
    "add_note",
    {
      description: "Add a note.",
      inputSchema: { title: z.string().max(50), body: z.string() },
      annotations: { readOnlyHint: false }
    },
    async ({ title, body }) => {
      if (title === "fail") return { isError: true, content: [{ type: "text", text: "disk full" }] };
      writes.push(`${title}:${body}`);
      return { content: [{ type: "text", text: `added ${title}` }] };
    }
  );
  return { server, writes };
}

const notesConfig = (approval: ExternalServerConfig["approval"] = "changes"): ExternalServerConfig => ({
  id: "notes",
  name: "Notes",
  approval,
  transport: { kind: "stdio", command: "unused", args: [] }
});

async function setUp(approval: ExternalServerConfig["approval"] = "changes") {
  const { server: notes, writes } = downstream();
  const external = new ExternalServers({
    createTransport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void notes.connect(serverSide);
      return { transport: clientSide };
    }
  });
  await external.set(notesConfig(approval), { env: {}, headers: {} });
  const workflow = new WorkflowService(new InMemoryAuditRepository());
  const gateway = createMcpServer({ filesystem: new FilesystemService(), workflow, external });
  const agent = new Client({ name: "agent", version: "1.0.0" }, { capabilities: {} });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await Promise.all([gateway.connect(gatewaySide), agent.connect(agentSide)]);
  cleanups.push(async () => {
    await agent.close();
    await gateway.close();
    await external.close();
    await notes.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    await agent.callTool({ name, arguments: args }) as CallToolResult;
  const text = (callResult: CallToolResult) => callResult.content.map((item) => item.type === "text" ? item.text : "").join("");
  return { agent, call, text, workflow, writes, external, notes };
}

describe("tools from other MCP servers", () => {
  it("offers them as <server>__<tool> with the server's own parameters", async () => {
    const { agent } = await setUp();
    const tools = (await agent.listTools()).tools;
    const addNote = tools.find((tool) => tool.name === "notes__add_note");

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["notes__list_notes", "notes__add_note", "external_run_approved_call"]));
    expect(addNote?.inputSchema).toMatchObject({
      type: "object",
      properties: { title: { type: "string", maxLength: 50 }, body: { type: "string" } },
      required: ["title", "body"]
    });
    expect(addNote?.description).toContain("[From Notes, through MCP Connector] Add a note.");
    expect(addNote?.description).toContain("needs the user's approval");
  });

  it("runs read-only tools at once", async () => {
    const { call, text, workflow } = await setUp();
    expect(text(await call("notes__list_notes", { tag: "work" }))).toBe("notes tagged work");
    expect(await workflow.listPending()).toEqual([]);
  });

  it("runs a tool that changes something only after approval, exactly as approved, once", async () => {
    const { call, text, workflow, writes } = await setUp();
    const previewed = await call("notes__add_note", { title: "Plan", body: "ship it" });
    const { preview } = JSON.parse(text(previewed)) as { preview: { id: string; target: string; payload: unknown } };

    expect(writes).toEqual([]);
    expect(preview.target).toBe("Notes: add_note");
    expect(preview.payload).toEqual({ server: "notes", serverName: "Notes", tool: "add_note", arguments: { title: "Plan", body: "ship it" } });

    const early = await call("external_run_approved_call", { previewId: preview.id });
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("Explicit approval is required");
    expect(writes).toEqual([]);

    await workflow.approve(preview.id);
    expect(text(await call("external_run_approved_call", { previewId: preview.id }))).toBe("added Plan");
    expect(writes).toEqual(["Plan:ship it"]);

    const again = await call("external_run_approved_call", { previewId: preview.id });
    expect(text(again)).toContain("already been executed");
    expect(writes).toEqual(["Plan:ship it"]);
  });

  it("never runs a rejected call", async () => {
    const { call, text, workflow, writes } = await setUp();
    const { preview } = JSON.parse(text(await call("notes__add_note", { title: "No", body: "x" }))) as { preview: { id: string } };
    await workflow.reject(preview.id);

    expect((await call("external_run_approved_call", { previewId: preview.id })).isError).toBe(true);
    expect(writes).toEqual([]);
  });

  it("asks before every tool when the server is set to that", async () => {
    const { call, text, workflow } = await setUp("all");
    const answer = JSON.parse(text(await call("notes__list_notes"))) as { requiresApproval: boolean };

    expect(answer.requiresApproval).toBe(true);
    expect(await workflow.listPending()).toHaveLength(1);
  });

  it("marks a call FAILED when the server reports an error", async () => {
    const { call, text, workflow } = await setUp();
    const { preview } = JSON.parse(text(await call("notes__add_note", { title: "fail", body: "x" }))) as { preview: { id: string } };
    await workflow.approve(preview.id);

    const failed = await call("external_run_approved_call", { previewId: preview.id });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("Notes reported an error: disk full");
    expect(await workflow.getStatus(preview.id)).toBe("FAILED");
  });

  it("keeps the approval when the server is not connected", async () => {
    const { call, text, workflow, external } = await setUp();
    const { preview } = JSON.parse(text(await call("notes__add_note", { title: "Later", body: "x" }))) as { preview: { id: string } };
    await workflow.approve(preview.id);
    await external.remove("notes");

    const blocked = await call("external_run_approved_call", { previewId: preview.id });
    expect(text(blocked)).toContain("Notes is not connected");
    expect(await workflow.getStatus(preview.id)).toBe("APPROVED");
  });

  it("picks up tools a server adds while connected", async () => {
    const { external, notes } = await setUp();
    notes.registerTool("count_notes", { description: "Count.", inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: "3" }] }));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (external.connectedServers()[0]?.tools.some((tool) => tool.name === "count_notes")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(external.connectedServers()[0]?.tools.map((tool) => tool.name)).toContain("count_notes");
  });

  it("reports a server that cannot be reached", async () => {
    const external = new ExternalServers({ createTransport: () => { throw new Error("spawn npx ENOENT"); } });
    await external.set(notesConfig(), { env: {}, headers: {} });
    expect(external.list()[0]?.state).toEqual({
      status: "failed",
      message: "The command could not be started (spawn npx ENOENT). Check that it is installed and on PATH."
    });
    expect(external.connectedServers()).toEqual([]);
  });
});

describe("externalToolName", () => {
  it("replaces characters agents reject, and refuses names that are too long", () => {
    expect(externalToolName("notes", "add note/now")).toBe("notes__add_note_now");
    expect(externalToolName("notes", "x".repeat(70))).toBeNull();
  });
});

describe("a real stdio server", () => {
  it("starts the program with its own variables and network settings, and nothing else", async () => {
    const proxy = process.env.HTTPS_PROXY;
    process.env.PARENT_SECRET = "must-not-leak";
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    const external = new ExternalServers();
    cleanups.push(async () => {
      delete process.env.PARENT_SECRET;
      if (proxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = proxy;
      await external.close();
    });
    await external.set(
      { id: "echo", name: "Echo", approval: "changes", transport: { kind: "stdio", command: process.execPath, args: [join(__dirname, "fixtures", "echo-server.mjs")] } },
      { env: { ECHO_TOKEN: "from-the-vault" }, headers: {} }
    );

    expect(external.list()[0]?.state.status).toBe("connected");
    const answer = await external.callTool("echo", "whoami", {});
    expect(JSON.parse((answer.content[0] as { text: string }).text)).toEqual({
      token: "from-the-vault",
      parentSecret: null,
      proxy: "http://proxy.example:8080"
    });
  });

  it("explains a command that does not exist", async () => {
    const external = new ExternalServers();
    cleanups.push(() => external.close());
    await external.set(
      { id: "missing", name: "Missing", approval: "changes", transport: { kind: "stdio", command: "mcp-connector-no-such-command", args: [] } },
      { env: {}, headers: {} }
    );
    const state = external.list()[0]?.state;
    expect(state?.status).toBe("failed");
    expect(state?.status === "failed" ? state.message : "").toContain("could not be started");
  });

  it("uses the HTTP transport for URLs", () => {
    const handle = createExternalTransport(
      { id: "web", name: "Web", approval: "changes", transport: { kind: "http", url: "https://example.com/mcp" } },
      { env: {}, headers: { Authorization: "Bearer t" } }
    );
    expect(handle.transport.constructor.name).toBe("StreamableHTTPClientTransport");
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createNotionDefinition } from "../connectors/notion.definition.js";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import type { ExternalServerConfig } from "../gateway/external-server-config.js";
import { ExternalServers } from "../gateway/external-servers.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import type { McpClientSource, WorkflowPreview } from "../workflow/workflow.types.js";
import { createMcpServer } from "./mcp-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Another MCP server with one read-only tool and one that writes. */
async function notesServer(approval: ExternalServerConfig["approval"] = "changes") {
  const reads: string[] = [];
  const notes = new McpServer({ name: "notes", version: "1.0.0" });
  notes.registerTool(
    "list_notes",
    { description: "List notes.", inputSchema: { tag: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ tag }) => {
      reads.push(tag ?? "any");
      return { content: [{ type: "text", text: `notes tagged ${tag ?? "any"}` }] };
    }
  );
  notes.registerTool(
    "add_note",
    { description: "Add a note.", inputSchema: { title: z.string() }, annotations: { readOnlyHint: false } },
    async ({ title }) => ({ content: [{ type: "text", text: `added ${title}` }] })
  );
  const external = new ExternalServers({
    createTransport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void notes.connect(serverSide);
      return { transport: clientSide };
    }
  });
  await external.set(
    { id: "notes", name: "Notes", approval, transport: { kind: "stdio", command: "unused", args: [] } },
    { env: {}, headers: {} }
  );
  cleanups.push(async () => {
    await external.close();
    await notes.close();
  });
  return { external, reads };
}

async function setUp(options: { askBeforeWebReads?: () => boolean; external?: ExternalServers } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-web-reads-"));
  cleanups.push(() => rm(workspace, { force: true, recursive: true }));
  await writeFile(join(workspace, "README.md"), "# Private notes");
  const filesystem = new FilesystemService();
  filesystem.setAllowedWorkspaceRoot(workspace);
  const audit = new InMemoryAuditRepository();
  const workflow = new WorkflowService(audit);
  const dependencies = {
    filesystem,
    workflow,
    connectors: [{
      definition: createNotionDefinition({ createConnector: () => ({ createPage: async () => ({ pageId: "page-1", url: null }) }) }),
      runtime: { tokens: { getAccessToken: async () => "token" }, requireSetting: () => "database-1" }
    }],
    ...(options.external === undefined ? {} : { external: options.external }),
    ...(options.askBeforeWebReads === undefined ? {} : { askBeforeWebReads: options.askBeforeWebReads })
  };

  /** A client of the given kind, the way the HTTP server makes one for each key. */
  const connect = async (source: McpClientSource) => {
    const server = createMcpServer(dependencies, source);
    const client = new Client({ name: `${source}-client`, version: "1.0.0" }, { capabilities: {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      await client.callTool({ name, arguments: args }) as CallToolResult;
    return { client, call };
  };
  return { connect, workflow, audit, workspace };
}

const text = (callResult: CallToolResult) => callResult.content.map((item) => item.type === "text" ? item.text : "").join("");
const answerOf = (callResult: CallToolResult) =>
  JSON.parse(text(callResult)) as { requiresApproval: boolean; preview: WorkflowPreview; executeTool: string };
const previewOf = (callResult: CallToolResult) => answerOf(callResult).preview;

describe("reads from web chats", () => {
  it("returns a READ preview instead of the data, and the data only after approval, once", async () => {
    const { connect, workflow, audit } = await setUp();
    const web = await connect("web");

    const asked = await web.call("filesystem_inspect_workspace");
    expect(text(asked)).not.toContain("README.md");
    expect(text(asked)).not.toContain("Private notes");
    const preview = previewOf(asked);
    expect(answerOf(asked)).toMatchObject({ requiresApproval: true, executeTool: "web_run_approved_read" });
    expect(preview).toMatchObject({
      action: "READ",
      target: "filesystem_inspect_workspace",
      summary: 'Run the read-only tool "Inspect local workspace"',
      payload: { tool: "filesystem_inspect_workspace", arguments: {} },
      requiresApproval: true,
      source: "web"
    });
    expect(text(await web.call("workflow_preview_status", { previewId: preview.id }))).toContain('"status": "PREVIEWED"');

    const early = await web.call("web_run_approved_read", { previewId: preview.id });
    expect(early.isError).toBe(true);
    expect(text(early)).toContain("Explicit approval is required");
    expect(text(early)).not.toContain("Private notes");

    await workflow.approve(preview.id);
    const read = await web.call("web_run_approved_read", { previewId: preview.id });
    expect(text(read)).toContain("Private notes");

    const again = await web.call("web_run_approved_read", { previewId: preview.id });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("already been executed");
    expect((await audit.list()).map((record) => [record.status, record.source])).toEqual([
      ["EXECUTED", "web"], ["APPROVED", "web"], ["PREVIEWED", "web"]
    ]);
  });

  it("runs exactly the arguments that were approved", async () => {
    const { connect, workflow, workspace } = await setUp();
    const web = await connect("web");
    const preview = previewOf(await web.call("filesystem_inspect_workspace", { workspacePath: "." }));
    expect(preview.payload).toEqual({ tool: "filesystem_inspect_workspace", arguments: { workspacePath: "." } });

    await workflow.approve(preview.id);
    expect(text(await web.call("web_run_approved_read", { previewId: preview.id })))
      .toContain(JSON.stringify(workspace).slice(1, -1));
  });

  it("never runs a rejected read", async () => {
    const { connect, workflow } = await setUp();
    const web = await connect("web");
    const preview = previewOf(await web.call("workspace_get_selected"));
    await workflow.reject(preview.id);

    const refused = await web.call("web_run_approved_read", { previewId: preview.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).not.toContain("workspacePath");
    expect(text(await web.call("workflow_preview_status", { previewId: preview.id }))).toContain('"status": "REJECTED"');
  });

  it("asks unless the setting is turned off, and reads the setting on every call", async () => {
    let ask = false;
    const { connect, workflow } = await setUp({ askBeforeWebReads: () => ask });
    const web = await connect("web");

    expect(text(await web.call("filesystem_inspect_workspace"))).toContain("Private notes");
    expect(await workflow.listPending()).toEqual([]);

    ask = true;
    expect(previewOf(await web.call("filesystem_inspect_workspace")).action).toBe("READ");
    expect(await workflow.listPending()).toHaveLength(1);
  });

  it("leaves agents as they were: reads run at once, with the same tools", async () => {
    const { connect, workflow } = await setUp();
    const agent = await connect("mcp");
    const web = await connect("web");

    expect(text(await agent.call("filesystem_inspect_workspace"))).toContain("Private notes");
    expect(text(await agent.call("workspace_get_selected"))).toContain("workspacePath");
    expect(await workflow.listPending()).toEqual([]);

    // One definition of every tool: a web chat sees the agents' tools unchanged, plus the one that runs its reads.
    const agentTools = (await agent.client.listTools()).tools;
    const webTools = (await web.client.listTools()).tools;
    expect(agentTools.map((tool) => tool.name)).not.toContain("web_run_approved_read");
    expect(webTools.filter((tool) => tool.name !== "web_run_approved_read")).toEqual(agentTools);
    expect(webTools.map((tool) => tool.name)).toContain("web_run_approved_read");
  });

  it("does not let an agent's key run a web chat's read, or run other previews as reads", async () => {
    const { connect, workflow } = await setUp();
    const web = await connect("web");
    const agent = await connect("mcp");
    const read = previewOf(await web.call("filesystem_inspect_workspace"));
    await workflow.approve(read.id);

    const fromAgent = await agent.call("web_run_approved_read", { previewId: read.id });
    expect(fromAgent.isError).toBe(true);
    expect(text(fromAgent)).not.toContain("Private notes");

    const page = previewOf(await web.call("notion_create_project_page_preview", { title: "Plan", markdown: "x" }));
    await workflow.approve(page.id);
    const wrongKind = await web.call("web_run_approved_read", { previewId: page.id });
    expect(wrongKind.isError).toBe(true);
    expect(text(wrongKind)).toContain("not a read from a web chat");
    expect(await workflow.getStatus(page.id)).toBe("APPROVED");
  });

  it("labels a web chat's changes as web, and an agent's as mcp", async () => {
    const { external } = await notesServer();
    const { connect } = await setUp({ external });
    const web = await connect("web");
    const agent = await connect("mcp");

    expect(previewOf(await web.call("notion_create_project_page_preview", { title: "Plan", markdown: "x" })).source).toBe("web");
    expect(previewOf(await web.call("notes__add_note", { title: "Plan" }))).toMatchObject({ action: "CALL", source: "web" });
    expect(previewOf(await agent.call("notion_create_project_page_preview", { title: "Plan", markdown: "x" })).source).toBe("mcp");
    expect(previewOf(await agent.call("notes__add_note", { title: "Plan" })).source).toBe("mcp");
  });

  it("names the tool that runs each preview, and that tool exists for the client that asked", async () => {
    const { external } = await notesServer();
    const { connect } = await setUp({ external });
    for (const source of ["web", "mcp"] as const) {
      const client = await connect(source);
      const tools = (await client.client.listTools()).tools.map((tool) => tool.name);
      const answers = [
        answerOf(await client.call("notion_create_project_page_preview", { title: "Plan", markdown: "x" })),
        answerOf(await client.call("notes__add_note", { title: "Plan" })),
        ...(source === "web" ? [answerOf(await client.call("notes__list_notes")), answerOf(await client.call("workspace_get_selected"))] : [])
      ];
      expect(answers.map((answer) => answer.executeTool)).toEqual([
        "notion_create_project_page",
        "external_run_approved_call",
        ...(source === "web" ? ["web_run_approved_read", "web_run_approved_read"] : [])
      ]);
      for (const answer of answers) {
        expect(answer.requiresApproval).toBe(true);
        expect(tools).toContain(answer.executeTool);
      }
    }
  });

  it("asks before another MCP server's read-only tools too", async () => {
    const { external, reads } = await notesServer();
    const { connect, workflow } = await setUp({ external });
    const web = await connect("web");

    const preview = previewOf(await web.call("notes__list_notes", { tag: "work" }));
    expect(preview).toMatchObject({ action: "READ", target: "notes__list_notes", payload: { arguments: { tag: "work" } } });
    expect(reads).toEqual([]);

    await workflow.approve(preview.id);
    expect(text(await web.call("web_run_approved_read", { previewId: preview.id }))).toBe("notes tagged work");
    expect(reads).toEqual(["work"]);
  });

  it("keeps the approval when the tool's server is not connected", async () => {
    const { external } = await notesServer();
    const { connect, workflow } = await setUp({ external });
    const preview = previewOf(await (await connect("web")).call("notes__list_notes"));
    await workflow.approve(preview.id);
    await external.remove("notes");

    // Each request gets a server with the tools that exist at that moment.
    const blocked = await (await connect("web")).call("web_run_approved_read", { previewId: preview.id });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("cannot be read right now");
    expect(await workflow.getStatus(preview.id)).toBe("APPROVED");
  });

  it("shows a file read by its path in the workspace and its lines, with no content before approval", async () => {
    const { connect, workflow, workspace } = await setUp();
    const web = await connect("web");

    const asked = await web.call("filesystem_read_file", { path: join(workspace, "docs", "..", "README.md"), startLine: 1, maxLines: 5 });
    expect(text(asked)).not.toContain("Private notes");
    const preview = previewOf(asked);
    expect(preview).toMatchObject({
      action: "READ",
      target: "filesystem_read_file",
      summary: "Read the file README.md, lines 1 to 5",
      requiresApproval: true,
      source: "web"
    });
    // What the user is shown, then exactly what will run.
    expect(preview.payload).toEqual({
      file: "README.md",
      lines: "1 to 5",
      tool: "filesystem_read_file",
      arguments: { path: join(workspace, "docs", "..", "README.md"), startLine: 1, maxLines: 5 }
    });
    expect(answerOf(asked).executeTool).toBe("web_run_approved_read");

    const whole = previewOf(await web.call("filesystem_read_file", { path: "README.md" }));
    expect(whole.summary).toBe("Read the file README.md");
    expect(whole.payload).toEqual({ file: "README.md", tool: "filesystem_read_file", arguments: { path: "README.md" } });

    await workflow.approve(preview.id);
    const read = JSON.parse(text(await web.call("web_run_approved_read", { previewId: preview.id }))) as Record<string, unknown>;
    expect(read).toEqual({ path: "README.md", totalLines: 1, startLine: 1, endLine: 1, hasMore: false, text: "# Private notes" });
  });

  it("records which file and lines a web chat read, and how much, but not the text", async () => {
    const { connect, workflow, audit, workspace } = await setUp();
    await writeFile(join(workspace, "notes.md"), "one\nthe launch code is 4471\nthree\n");
    const web = await connect("web");
    const preview = previewOf(await web.call("filesystem_read_file", { path: "notes.md", startLine: 2, maxLines: 1 }));
    await workflow.approve(preview.id);
    expect(text(await web.call("web_run_approved_read", { previewId: preview.id }))).toContain("launch code");

    const records = await audit.list();
    const executed = JSON.parse(records.find((record) => record.status === "EXECUTED")!.previewJson) as { result: unknown };
    expect(executed.result).toEqual({ file: "notes.md", lines: "2 to 2 of 3", characters: 23 });
    expect(JSON.stringify(records)).not.toContain("launch code");

    // Other tools' results are still kept as a shortened copy.
    const listing = previewOf(await web.call("filesystem_inspect_workspace"));
    await workflow.approve(listing.id);
    await web.call("web_run_approved_read", { previewId: listing.id });
    expect(JSON.stringify(await audit.list())).toContain("notes.md");
  });

  it("gives a web chat a long file in parts that fit a chat box, and an agent the usual 2,000 lines", async () => {
    const { connect, workflow, audit, workspace } = await setUp();
    const lines = Array.from({ length: 3_000 }, (_unused, index) => `line ${index + 1} ${"x".repeat(60)}`);
    await writeFile(join(workspace, "log.txt"), lines.join("\n"));
    const web = await connect("web");
    const agent = await connect("mcp");
    type Read = { totalLines: number; startLine: number; endLine: number; hasMore: boolean; text: string };
    const readAsWeb = async (args: Record<string, unknown>): Promise<Read> => {
      const preview = previewOf(await web.call("filesystem_read_file", { path: "log.txt", ...args }));
      await workflow.approve(preview.id);
      return JSON.parse(text(await web.call("web_run_approved_read", { previewId: preview.id }))) as Read;
    };

    // The web chat asked for the whole file. It gets what fits, ending on a whole line, and is told where it stopped.
    const first = await readAsWeb({});
    expect(first.text.length).toBeLessThanOrEqual(16_000);
    expect(first.text.length).toBeGreaterThan(15_000);
    expect(first).toMatchObject({ totalLines: 3_000, startLine: 1, hasMore: true });
    expect(first.text).toBe(lines.slice(0, first.endLine).join("\n"));
    expect(first.endLine).toBeLessThan(2_000);

    // Asking for more lines than fit changes nothing, and reading on continues without a gap.
    const second = await readAsWeb({ startLine: first.endLine + 1, maxLines: 5_000 });
    expect(second.startLine).toBe(first.endLine + 1);
    expect(second.text).toBe(lines.slice(first.endLine, second.endLine).join("\n"));
    expect(second.text.length).toBeLessThanOrEqual(16_000);

    // The audit log records the lines that were really returned.
    const executed = (await audit.list()).filter((record) => record.status === "EXECUTED")
      .map((record) => (JSON.parse(record.previewJson) as { result: { lines: string; characters: number } }).result);
    expect(executed.map((result) => result.lines).sort()).toEqual(
      [`1 to ${first.endLine} of 3000`, `${second.startLine} to ${second.endLine} of 3000`].sort()
    );

    // With the agents' token nothing changes: 2,000 lines, far more than the web budget.
    const whole = JSON.parse(text(await agent.call("filesystem_read_file", { path: "log.txt" }))) as Read;
    expect(whole).toMatchObject({ startLine: 1, endLine: 2_000, hasMore: true });
    expect(whole.text.length).toBeGreaterThan(100_000);
  });

  it("limits a web chat's file reads the same way when it is not asked to approve them", async () => {
    const { connect, workspace } = await setUp({ askBeforeWebReads: () => false });
    await writeFile(join(workspace, "log.txt"), Array.from({ length: 3_000 }, (_unused, index) => `line ${index + 1} ${"x".repeat(60)}`).join("\n"));
    const read = JSON.parse(text(await (await connect("web")).call("filesystem_read_file", { path: "log.txt" }))) as { text: string; endLine: number; hasMore: boolean };

    expect(read.text.length).toBeLessThanOrEqual(16_000);
    expect(read.hasMore).toBe(true);
    expect(read.text.endsWith(`line ${read.endLine} ${"x".repeat(60)}`)).toBe(true);
  });

  it("refuses a file outside the workspace or a secret file before asking the user", async () => {
    const { connect, workflow, workspace } = await setUp();
    await writeFile(join(workspace, ".env"), "API_KEY=secret");
    const web = await connect("web");
    const agent = await connect("mcp");

    for (const client of [web, agent]) {
      const outside = await client.call("filesystem_read_file", { path: "../other/notes.md" });
      expect(outside.isError).toBe(true);
      expect(text(outside)).toContain("outside the user-selected workspace");
      const secret = await client.call("filesystem_read_file", { path: ".env" });
      expect(secret.isError).toBe(true);
      expect(text(secret)).toContain("MCP Connector does not read .env");
      expect(text(secret)).not.toContain("API_KEY");
    }
    expect(await workflow.listPending()).toEqual([]);
    // An agent's read of an ordinary file still runs at once.
    expect(text(await agent.call("filesystem_read_file", { path: "README.md" }))).toContain("Private notes");
  });

  it("marks a read FAILED when the tool reports an error", async () => {
    const { connect, workflow } = await setUp();
    const web = await connect("web");
    const preview = previewOf(await web.call("filesystem_inspect_workspace", { workspacePath: ".." }));
    await workflow.approve(preview.id);

    const failed = await web.call("web_run_approved_read", { previewId: preview.id });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("outside the user-selected workspace");
    expect(await workflow.getStatus(preview.id)).toBe("FAILED");
  });
});

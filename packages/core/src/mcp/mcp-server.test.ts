import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import type { ConnectorRuntime } from "../connectors/connector-definition.js";
import type { NotionConnector, NotionPageDraft } from "../connectors/connector.types.js";
import { createGitHubDefinition } from "../connectors/github.definition.js";
import { createNotionDefinition } from "../connectors/notion.definition.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import { createMcpServer } from "./mcp-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe("MCP protocol integration", () => {
  it("discovers tools and preserves preview approval enforcement", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-protocol-"));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, "README.md"), "# MCP Connector");

    let createdPage: NotionPageDraft | null = null;
    const notion: NotionConnector = {
      createPage: async (draft) => {
        createdPage = draft;
        return { pageId: "page-1", url: "https://notion.local/page-1" };
      }
    };
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const filesystem = new FilesystemService();
    filesystem.setAllowedWorkspaceRoot(workspace);
    const server = createMcpServer({
      filesystem,
      workflow,
      connectors: [{
        definition: createNotionDefinition({ createConnector: () => notion }),
        runtime: { tokens: { getAccessToken: async () => "token" }, requireSetting: () => "database-1" }
      }]
    });
    const client = new Client(
      { name: "mcp-connector-test-client", version: "0.1.0" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport)
      ]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "filesystem_inspect_workspace",
        "notion_create_project_page_preview",
        "notion_create_project_page",
        "workflow_preview_status"
      ]));

      const inspection = await client.callTool({
        name: "filesystem_inspect_workspace",
        arguments: { workspacePath: workspace }
      });
      expect(JSON.stringify(inspection)).toContain("README.md");

      const previewResult = await client.callTool({
        name: "notion_create_project_page_preview",
        arguments: {
          title: "MCP Connector",
          markdown: "# MCP Connector\n\nShips previews."
        }
      });
      const content = previewResult.content;
      if (!Array.isArray(content)) {
        throw new Error("Expected preview tool content array.");
      }
      const previewText: unknown = content[0];
      if (
        typeof previewText !== "object" ||
        previewText === null ||
        !("type" in previewText) ||
        previewText.type !== "text" ||
        !("text" in previewText) ||
        typeof previewText.text !== "string"
      ) {
        throw new Error("Expected preview tool to return text content.");
      }
      const previewPayload = JSON.parse(previewText.text) as {
        readonly preview: { readonly id: string; readonly payload: { readonly notionBlocks: unknown } };
      };
      const pendingResult = await client.callTool({
        name: "workflow_preview_status",
        arguments: { previewId: previewPayload.preview.id }
      });
      expect(JSON.stringify(pendingResult)).toContain('"status":"PREVIEWED"');

      const unauthorizedExecution = await client.callTool({
        name: "notion_create_project_page",
        arguments: { previewId: previewPayload.preview.id }
      });
      expect(unauthorizedExecution.isError).toBe(true);
      expect(JSON.stringify(unauthorizedExecution)).toContain("Explicit approval is required");
      expect(createdPage).toBeNull();

      await workflow.approve(previewPayload.preview.id);
      const execution = await client.callTool({
        name: "notion_create_project_page",
        arguments: { previewId: previewPayload.preview.id }
      });
      expect(JSON.stringify(execution)).toContain("page-1");
      // Exactly the blocks stored in the approved preview, with no local path added.
      expect(createdPage).toEqual({
        title: "MCP Connector",
        blocks: previewPayload.preview.payload.notionBlocks
      });
      expect(JSON.stringify(createdPage)).not.toContain(workspace);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("tells agents which workspace is selected and inspects it without a path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-protocol-"));
    const outside = await mkdtemp(join(tmpdir(), "mcp-protocol-outside-"));
    temporaryDirectories.push(workspace, outside);
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "guide.md"), "# Guide");
    const filesystem = new FilesystemService();
    const server = createMcpServer({
      filesystem,
      workflow: new WorkflowService(new InMemoryAuditRepository())
    });
    const client = new Client({ name: "workspace-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.stringify(await client.callTool({ name, arguments: args }));

    try {
      expect(await call("workspace_get_selected")).toContain("No workspace is selected");
      expect(await call("filesystem_inspect_workspace")).toContain("Select a workspace");

      filesystem.setAllowedWorkspaceRoot(workspace);
      expect(await call("workspace_get_selected")).toContain(JSON.stringify(workspace).slice(1, -1));
      expect(await call("filesystem_inspect_workspace")).toContain("guide.md");
      expect(await call("filesystem_inspect_workspace", { workspacePath: "docs" })).toContain("guide.md");
      expect(await call("filesystem_inspect_workspace", { workspacePath: ".." }))
        .toContain("outside the user-selected workspace");
      expect(await call("filesystem_inspect_workspace", { workspacePath: outside }))
        .toContain("outside the user-selected workspace");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads Notion's sign-in and database when a tool runs, and keeps the approval when one is missing", async () => {
    const created: string[] = [];
    let databaseId: string | undefined;
    let signedIn = true;
    const runtime: ConnectorRuntime = {
      tokens: {
        getAccessToken: async () => {
          if (!signedIn) throw new Error("Notion is not connected. Connect it in MCP Connector first.");
          return "token";
        }
      },
      requireSetting: () => {
        if (databaseId === undefined) throw new Error('Notion needs "Database for new pages". Set it in MCP Connector.');
        return databaseId;
      }
    };
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const server = createMcpServer({
      filesystem: new FilesystemService(),
      workflow,
      connectors: [{
        definition: createNotionDefinition({
          createConnector: (_tokens, database) => ({
            createPage: async (draft) => {
              created.push(`${database}:${draft.title}`);
              return { pageId: "page-1", url: null };
            }
          })
        }),
        runtime
      }]
    });
    const client = new Client({ name: "settings-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const text = (value: unknown) => JSON.stringify(value);

    try {
      // No database yet: the agent hears it before anything is queued.
      const refused = await call("notion_create_project_page_preview", { title: "Plan", markdown: "x" });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("Database for new pages");
      expect(await workflow.listPending()).toEqual([]);

      // Chosen while the server runs: the next call sees it.
      databaseId = "database-1";
      const previewed = await call("notion_create_project_page_preview", { title: "Plan", markdown: "x" });
      const previewId = (JSON.parse((previewed.content as [{ text: string }])[0].text) as { preview: { id: string } }).preview.id;
      await workflow.approve(previewId);

      // Signed out after approving: the approval is not used up.
      signedIn = false;
      const blocked = await call("notion_create_project_page", { previewId });
      expect(blocked.isError).toBe(true);
      expect(text(blocked)).toContain("Notion is not connected");
      expect(await workflow.getStatus(previewId)).toBe("APPROVED");

      signedIn = true;
      expect(text(await call("notion_create_project_page", { previewId }))).toContain("page-1");
      expect(created).toEqual(["database-1:Plan"]);
      expect(await workflow.getStatus(previewId)).toBe("EXECUTED");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("adds each connector's tools, and only those", async () => {
    const tools = async (connectors: Parameters<typeof createMcpServer>[0]["connectors"]) => {
      const server = createMcpServer({ filesystem: new FilesystemService(), workflow: new WorkflowService(new InMemoryAuditRepository()), ...(connectors === undefined ? {} : { connectors }) });
      const client = new Client({ name: "tools-test", version: "0.1.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      await client.close();
      await server.close();
      return names;
    };
    const runtime: ConnectorRuntime = { tokens: { getAccessToken: async () => "token" }, requireSetting: () => "x" };

    expect(await tools(undefined)).toEqual(["filesystem_inspect_workspace", "workflow_preview_status", "workspace_get_selected"]);
    expect(await tools([{ definition: createGitHubDefinition(), runtime }])).toContain("github_list_repositories");
    expect(await tools([{ definition: createGitHubDefinition(), runtime }])).not.toContain("notion_create_project_page");
  });
});

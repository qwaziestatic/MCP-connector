import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import type { NotionConnector } from "../connectors/connector.types.js";
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

    let createdPage: { title: string; markdown: string } | null = null;
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
      notion
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
        "notion_create_project_page"
      ]));

      const inspection = await client.callTool({
        name: "filesystem_inspect_workspace",
        arguments: { workspacePath: workspace }
      });
      expect(JSON.stringify(inspection)).toContain("README.md");

      const previewResult = await client.callTool({
        name: "notion_create_project_page_preview",
        arguments: {
          workspacePath: workspace,
          title: "MCP Connector",
          markdown: "# MCP Connector"
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
        readonly preview: { readonly id: string };
      };

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
      expect(createdPage).toEqual({
        title: "MCP Connector",
        markdown: `${workspace}\n\n# MCP Connector`
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  GitHubConnector,
  NotionConnector
} from "../connectors/connector.types.js";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import { z } from "zod";

export interface McpConnectorDependencies {
  readonly filesystem: FilesystemService;
  readonly workflow: WorkflowService;
  readonly github?: GitHubConnector;
  readonly notion?: NotionConnector;
}

interface TextResult {
  readonly [key: string]: unknown;
  readonly content: [{ type: "text"; text: string }];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

function result(value: unknown): TextResult {
  const textResult: TextResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {
      ...textResult,
      structuredContent: value as Readonly<Record<string, unknown>>
    };
  }
  return textResult;
}

export function createMcpServer(dependencies: McpConnectorDependencies): McpServer {
  const server = new McpServer(
    { name: "mcp-connector", version: "0.1.0" },
    { maxToolInputElements: 100 }
  );

  server.registerTool(
    "filesystem_inspect_workspace",
    {
      title: "Inspect local workspace",
      description: "Read a selected local workspace structure and README metadata.",
      inputSchema: {
        workspacePath: z.string().min(1)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ workspacePath }) => {
      if (dependencies.filesystem.getAllowedWorkspaceRoot() === undefined) {
        throw new Error("Select a workspace in MCP Connector before inspecting files.");
      }
      return result(await dependencies.filesystem.inspectWorkspace(workspacePath));
    }
  );

  server.registerTool(
    "github_list_repositories",
    {
      title: "List GitHub repositories",
      description: "List repositories accessible to the connected GitHub account.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async () => {
      if (dependencies.github === undefined) {
        throw new Error("GitHub connector is not configured.");
      }
      return result(await dependencies.github.listRepositories());
    }
  );

  server.registerTool(
    "notion_create_project_page_preview",
    {
      title: "Preview Notion project page creation",
      description: "Create a transactional preview. This tool never writes to Notion.",
      inputSchema: {
        workspacePath: z.string().min(1),
        title: z.string().min(1).max(200),
        markdown: z.string().max(256_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async ({ workspacePath, title, markdown }) => {
      const preview = await dependencies.workflow.createPreview(
        "CREATE",
        "Notion project page",
        `Create Notion project page for ${workspacePath}`,
        { workspacePath, title, markdown }
      );
      return result({
        requiresApproval: true,
        preview
      });
    }
  );

  server.registerTool(
    "notion_create_project_page",
    {
      title: "Create approved Notion project page",
      description: "Execute an already approved Notion page preview. The preview ID must have explicit HITL approval.",
      inputSchema: {
        previewId: z.string().uuid()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async ({ previewId }) => {
      if (dependencies.notion === undefined) {
        throw new Error("Notion connector is not configured.");
      }
      const page = await dependencies.workflow.executeApproved(previewId, async (preview) => {
        if (preview.action !== "CREATE" || preview.target !== "Notion project page") {
          throw new Error("Preview is not a Notion project page creation.");
        }
        const workspacePath = typeof preview.payload.workspacePath === "string"
          ? preview.payload.workspacePath
          : "workspace";
        const title = typeof preview.payload.title === "string"
          ? preview.payload.title
          : "Project";
        const markdown = typeof preview.payload.markdown === "string"
          ? preview.payload.markdown
          : "";
        return dependencies.notion!.createPage({ title, markdown: `${workspacePath}\n\n${markdown}` });
      });
      return result(page);
    }
  );

  return server;
}

import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  GitHubConnector,
  NotionConnector
} from "../connectors/connector.types.js";
import {
  createNotionPagePreview,
  executeNotionPagePreview,
  NOTION_MAX_MARKDOWN_LENGTH,
  NOTION_MAX_TITLE_LENGTH
} from "../connectors/notion-page.js";
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
    "workspace_get_selected",
    {
      title: "Get the selected workspace",
      description: "Get the local folder the user selected in MCP Connector. "
        + "Filesystem tools only work inside this folder.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const workspacePath = dependencies.filesystem.getAllowedWorkspaceRoot() ?? null;
      return result(workspacePath === null
        ? {
            workspacePath,
            message: "No workspace is selected. Ask the user to choose one in the MCP Connector app."
          }
        : { workspacePath });
    }
  );

  server.registerTool(
    "filesystem_inspect_workspace",
    {
      title: "Inspect local workspace",
      description: "List the files in the user's selected workspace and read its README. "
        + "Omit workspacePath to inspect the whole workspace; a relative path is a subfolder of it.",
      inputSchema: {
        workspacePath: z.string().min(1).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ workspacePath }) => {
      const root = dependencies.filesystem.getAllowedWorkspaceRoot();
      if (root === undefined) {
        throw new Error("Select a workspace in MCP Connector before inspecting files.");
      }
      // Relative paths resolve inside the workspace; inspectWorkspace still
      // rejects anything outside it, including absolute paths elsewhere.
      const target = workspacePath === undefined ? root : resolve(root, workspacePath);
      return result(await dependencies.filesystem.inspectWorkspace(target));
    }
  );

  server.registerTool(
    "github_list_repositories",
    {
      title: "List GitHub repositories",
      description: "List repositories accessible to the connected GitHub account.",
      inputSchema: {
        name: z.string().trim().min(1).max(200).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async ({ name }) => {
      if (dependencies.github === undefined) {
        throw new Error("GitHub connector is not configured.");
      }
      return result(await dependencies.github.listRepositories(
        name === undefined ? {} : { name }
      ));
    }
  );

  server.registerTool(
    "notion_create_project_page_preview",
    {
      title: "Preview Notion project page creation",
      description: "Create a preview of a Notion page from a title and Markdown. This tool never writes to Notion. "
        + "Ask the user to review and approve the preview in the MCP Connector app, then call "
        + "workflow_preview_status until it is APPROVED (then call notion_create_project_page) "
        + "or REJECTED (then stop). Headings, lists, to-dos, quotes, code blocks and dividers are kept; "
        + "inline formatting such as **bold** or links appears as plain text.",
      inputSchema: {
        title: z.string().min(1).max(NOTION_MAX_TITLE_LENGTH),
        markdown: z.string().max(NOTION_MAX_MARKDOWN_LENGTH)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true
      }
    },
    async ({ title, markdown }) => {
      const preview = await createNotionPagePreview(dependencies.workflow, { title, markdown }, "mcp");
      return result({
        requiresApproval: true,
        preview
      });
    }
  );

  server.registerTool(
    "workflow_preview_status",
    {
      title: "Get workflow preview status",
      description: "Get the status of a workflow preview: PREVIEWED (waiting for the user), "
        + "APPROVED (ready to execute), REJECTED (the user declined; do not retry without asking), "
        + "EXECUTING, EXECUTED or FAILED.",
      inputSchema: { previewId: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ previewId }) => result({
      previewId,
      status: await dependencies.workflow.getStatus(previewId)
    })
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
      const notion = dependencies.notion;
      if (notion === undefined) {
        throw new Error("Notion connector is not configured.");
      }
      const page = await dependencies.workflow.executeApproved(
        previewId,
        (preview) => executeNotionPagePreview(preview, notion)
      );
      return result(page);
    }
  );

  return server;
}

import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectedConnector } from "../connectors/connector-definition.js";
import {
  DEFAULT_READ_LINES,
  FilesystemService,
  MAX_READ_FILE_BYTES,
  WEB_READ_CHARACTERS,
  type FileText
} from "../filesystem/filesystem.service.js";
import type { ExternalToolSource } from "../gateway/external-servers.js";
import { registerExternalTools } from "../gateway/gateway-tools.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import type { McpClientSource } from "../workflow/workflow.types.js";
import { result } from "./tool-result.js";
import { askBeforeWebReads } from "./web-reads.js";
import { z } from "zod";

export interface McpConnectorDependencies {
  readonly filesystem: FilesystemService;
  readonly workflow: WorkflowService;
  /** Each service's definition and how its tools reach it; each adds its own tools. */
  readonly connectors?: readonly ConnectedConnector[];
  /** Other MCP servers the user connected; their tools are offered as `<server>__<tool>`. */
  readonly external?: ExternalToolSource;
  /**
   * Whether a web chat's read-only calls wait for the user's approval, read
   * on every call. They wait when this is not given.
   */
  readonly askBeforeWebReads?: () => boolean | Promise<boolean>;
}

/**
 * `source` says who the server is for: an agent with the MCP token, or a web
 * chat with the browser key. Both get the same tools; a web chat's previews
 * are labelled "web", and its reads can wait for approval.
 */
export const READ_FILE_TOOL = "filesystem_read_file";
const MAX_READ_LINES = 5_000;

export function createMcpServer(
  dependencies: McpConnectorDependencies,
  source: McpClientSource = "mcp"
): McpServer {
  const server = new McpServer(
    { name: "mcp-connector", version: "0.1.0" },
    { maxToolInputElements: 100 }
  );
  const webReads = source === "web"
    ? askBeforeWebReads(server, {
        workflow: dependencies.workflow,
        isOn: dependencies.askBeforeWebReads ?? (() => true),
        describe: {
          // The user approves a file by its path in the workspace, not by whatever spelling was sent.
          [READ_FILE_TOOL]: (args) => {
            const { file, lines } = dependencies.filesystem.describeRead(
              String(args.path),
              { startLine: args.startLine as number | undefined, maxLines: args.maxLines as number | undefined }
            );
            return {
              summary: lines === undefined ? `Read the file ${file}` : `Read the file ${file}, lines ${lines}`,
              details: lines === undefined ? { file } : { file, lines }
            };
          }
        },
        audit: {
          // The log says which file and lines were read and how much text, and keeps none of it.
          [READ_FILE_TOOL]: (full) => {
            const read = (full.structuredContent ?? {}) as Partial<FileText>;
            return {
              file: read.path ?? null,
              lines: `${read.startLine ?? 0} to ${read.endLine ?? 0} of ${read.totalLines ?? 0}`,
              characters: read.text?.length ?? 0
            };
          }
        }
      })
    : undefined;

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
    READ_FILE_TOOL,
    {
      title: "Read a file",
      description: "Read one text file in the user's selected workspace. path is relative to the workspace. "
        + `Returns up to ${DEFAULT_READ_LINES.toLocaleString("en-US")} lines; for a longer file, pass startLine and maxLines `
        + "and read on from endLine + 1 while hasMore is true. The answer gives the file's totalLines. "
        + "A call can return fewer lines than it was asked for, so always go by endLine and hasMore. "
        + `Refuses files outside the workspace, files over ${MAX_READ_FILE_BYTES.toLocaleString("en-US")} bytes, files that are not text, `
        + "and files that usually hold secrets (.env, private keys, anything in .git).",
      inputSchema: {
        path: z.string().min(1).max(4_096),
        startLine: z.number().int().min(1).optional(),
        maxLines: z.number().int().min(1).max(MAX_READ_LINES).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ path, startLine, maxLines }) => result(await dependencies.filesystem.readTextFile(path, {
      startLine,
      maxLines,
      // A web chat gets as much as a chat box takes, ending on a whole line. An agent's read is not limited this way.
      ...(source === "web" ? { maxCharacters: WEB_READ_CHARACTERS } : {})
    }))
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

  for (const { definition, runtime } of dependencies.connectors ?? []) {
    definition.registerTools(server, { runtime, workflow: dependencies.workflow, source });
  }

  registerExternalTools(server, {
    workflow: dependencies.workflow,
    source,
    ...(dependencies.external === undefined ? {} : { external: dependencies.external })
  });
  webReads?.registerRunTool();

  return server;
}

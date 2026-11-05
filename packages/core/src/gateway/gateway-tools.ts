// Offers other MCP servers' tools to agents, under the same rule as
// MCP Connector's own: anything that may change something waits for the
// user's approval in the app, then runs once, exactly as approved.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { result } from "../mcp/tool-result.js";
import type { WorkflowService } from "../workflow/workflow.service.js";
import type { WorkflowPreview } from "../workflow/workflow.types.js";
import type { ExternalServerConfig } from "./external-server-config.js";
import type { ExternalToolSource } from "./external-servers.js";

export const RUN_APPROVED_CALL_TOOL = "external_run_approved_call";
export const EXTERNAL_TOOL_SEPARATOR = "__";
/** Many agents refuse longer tool names. */
const MAX_TOOL_NAME_LENGTH = 64;
/** How much of a result the audit log keeps; the agent still gets all of it. */
const AUDIT_TEXT_LIMIT = 2000;

/** `<server id>__<tool>`, with characters agents reject replaced; null if too long. */
export function externalToolName(serverId: string, toolName: string): string | null {
  const name = `${serverId}${EXTERNAL_TOOL_SEPARATOR}${toolName.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  return name.length <= MAX_TOOL_NAME_LENGTH ? name : null;
}

/** Whether a call waits for the user. Only tools the server marks read-only, and not destructive, skip it. */
export function needsApproval(config: ExternalServerConfig, tool: Tool): boolean {
  if (config.approval === "all") return true;
  return tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true;
}

/** The server's input schema, so agents see the same parameters; any object if it cannot be read. */
function inputSchemaOf(tool: Tool): z.ZodObject {
  try {
    const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    if (schema instanceof z.ZodObject) return schema;
  } catch {
    // Fall through: the server checks its own inputs anyway.
  }
  return z.looseObject({});
}

interface ExternalCallPayload {
  readonly server: string;
  readonly serverName: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const payloadSchema = z.object({
  server: z.string(),
  serverName: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown())
});

export function isExternalCall(preview: WorkflowPreview): boolean {
  return preview.action === "CALL" && payloadSchema.safeParse(preview.payload).success;
}

function textOf(callResult: CallToolResult): string {
  return callResult.content
    .map((item) => item.type === "text" ? item.text : `[${item.type}]`)
    .join("\n");
}

/** Registers every connected server's tools, and the tool that runs approved calls. */
export function registerExternalTools(
  server: McpServer,
  dependencies: { readonly workflow: WorkflowService; readonly external?: ExternalToolSource }
): void {
  const { workflow, external } = dependencies;

  for (const { config, tools } of external?.connectedServers() ?? []) {
    const used = new Set<string>();
    for (const tool of tools) {
      const name = externalToolName(config.id, tool.name);
      if (name === null || used.has(name)) continue;
      used.add(name);
      const approval = needsApproval(config, tool);
      server.registerTool(
        name,
        {
          title: `${config.name}: ${tool.title ?? tool.annotations?.title ?? tool.name}`,
          description: `[From ${config.name}, through MCP Connector] ${tool.description ?? ""}`.trim()
            + (approval
              ? ` This tool needs the user's approval: calling it returns a preview and changes nothing. `
                + `Ask the user to approve it in MCP Connector, check workflow_preview_status, and once it is `
                + `APPROVED call ${RUN_APPROVED_CALL_TOOL} with the previewId.`
              : ""),
          inputSchema: inputSchemaOf(tool),
          annotations: {
            // As agents see it here: a tool that waits for approval only previews.
            readOnlyHint: !approval,
            destructiveHint: approval ? (tool.annotations?.destructiveHint ?? true) : false,
            openWorldHint: tool.annotations?.openWorldHint ?? true
          }
        },
        async (args: Record<string, unknown>) => {
          if (!approval) return external!.callTool(config.id, tool.name, args);
          const payload: ExternalCallPayload = { server: config.id, serverName: config.name, tool: tool.name, arguments: args };
          const preview = await workflow.createPreview(
            "CALL",
            `${config.name}: ${tool.name}`,
            `Run "${tool.name}" on ${config.name}`,
            { ...payload },
            "mcp"
          );
          return result({
            requiresApproval: true,
            preview,
            next: `Ask the user to approve this in MCP Connector. Poll workflow_preview_status; when it is APPROVED, call ${RUN_APPROVED_CALL_TOOL} with this previewId. If it is REJECTED, stop.`
          });
        }
      );
    }
  }

  server.registerTool(
    RUN_APPROVED_CALL_TOOL,
    {
      title: "Run an approved call to another MCP server",
      description: "Run a call to another MCP server's tool after the user approved its preview in MCP Connector. "
        + "Runs exactly the arguments that were approved, once, and returns that server's result.",
      inputSchema: { previewId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async ({ previewId }) => {
      const preview = await workflow.getPreview(previewId);
      const payload = payloadSchema.safeParse(preview.payload);
      if (preview.action !== "CALL" || !payload.success) {
        throw new Error("That preview is not a call to another MCP server.");
      }
      const call = payload.data;
      // Checked before the approval is used, so a stopped server does not use it up.
      if (await workflow.getStatus(previewId) === "APPROVED" && external?.isConnected(call.server) !== true) {
        throw new Error(`${call.serverName} is not connected. Ask the user to reconnect it in MCP Connector, then call this again.`);
      }
      let full: CallToolResult | undefined;
      await workflow.executeApproved(previewId, async () => {
        full = await external!.callTool(call.server, call.tool, call.arguments);
        const text = textOf(full);
        if (full.isError === true) throw new Error(`${call.serverName} reported an error: ${text.slice(0, 500)}`);
        // The audit log keeps a shortened copy; the agent gets the whole result.
        return { text: text.length > AUDIT_TEXT_LIMIT ? `${text.slice(0, AUDIT_TEXT_LIMIT)}…` : text };
      });
      return full as CallToolResult;
    }
  );
}

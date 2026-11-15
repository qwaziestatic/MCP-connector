// Web chats reach MCP Connector through the browser extension's key. While
// "Ask before web chats read anything" is on, their read-only calls wait for
// the user too: the call returns a READ preview instead of the result, and
// web_run_approved_read runs it once, exactly as approved.
//
// Every tool is still defined once, for every client. This wraps the handlers
// of the read-only ones as they are registered, so built-in tools, connectors
// and other MCP servers' tools are all covered without knowing about it.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { WorkflowService } from "../workflow/workflow.service.js";
import { auditCopy, previewResult, textOf } from "./tool-result.js";

export const RUN_APPROVED_READ_TOOL = "web_run_approved_read";

/**
 * Read-only tools that answer at once even for web chats: without the
 * status of its own preview, a web chat could never learn it was approved.
 */
const ALWAYS_ANSWERED: ReadonlySet<string> = new Set(["workflow_preview_status"]);

interface ToolConfig {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
}

type Arguments = Readonly<Record<string, unknown>>;
type Reader = (args: Arguments, extra: unknown) => Promise<CallToolResult>;
type Register = (name: string, config: ToolConfig, handler: (...received: unknown[]) => unknown) => RegisteredTool;

const payloadSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown())
});

/**
 * Makes the read-only tools registered on `server` from now on ask first.
 * Call it before the tools are registered, and `registerRunTool` after them.
 */
export function askBeforeWebReads(
  server: McpServer,
  options: {
    readonly workflow: WorkflowService;
    /** Whether reads wait for approval right now. Read on every call, so the setting reaches a running server. */
    readonly isOn: () => boolean | Promise<boolean>;
  }
): { registerRunTool(): void } {
  const { workflow, isOn } = options;
  const register = server.registerTool.bind(server) as unknown as Register;
  const readers = new Map<string, Reader>();

  const registerAsking: Register = (name, config, handler) => {
    if (config.annotations?.readOnlyHint !== true || ALWAYS_ANSWERED.has(name)) {
      return register(name, config, handler);
    }
    // The SDK passes (args, extra) to tools that declare their input, and (extra) to the rest.
    const takesArguments = config.inputSchema !== undefined;
    const read: Reader = async (args, extra) =>
      await (takesArguments ? handler(args, extra) : handler(extra)) as CallToolResult;
    readers.set(name, read);
    // A preview is not the tool's own output, so no output schema can describe both.
    const asked = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "outputSchema")) as ToolConfig;
    return register(name, asked, async (...received) => {
      const args = (takesArguments ? received[0] : {}) as Arguments;
      const extra = takesArguments ? received[1] : received[0];
      if (!await isOn()) return read(args, extra);
      const preview = await workflow.createPreview(
        "READ",
        name,
        `Run the read-only tool "${config.title ?? name}"`,
        { tool: name, arguments: args },
        "web"
      );
      return previewResult(
        preview,
        RUN_APPROVED_READ_TOOL,
        `Nothing was read yet. Ask the user to approve this in MCP Connector. Poll workflow_preview_status; when it is APPROVED, call ${RUN_APPROVED_READ_TOOL} with this previewId. If it is REJECTED, stop.`
      );
    });
  };
  server.registerTool = registerAsking as unknown as McpServer["registerTool"];

  return {
    registerRunTool: () => {
      // Registered directly: it only ever runs a read the user already approved.
      register(
        RUN_APPROVED_READ_TOOL,
        {
          title: "Run an approved read",
          description: "Run a read-only tool call after the user approved its preview in MCP Connector. "
            + "Runs exactly the arguments that were approved, once, and returns that tool's result.",
          inputSchema: { previewId: z.string().uuid() },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
        },
        async (...received) => {
          const { previewId } = received[0] as { previewId: string };
          const preview = await workflow.getPreview(previewId);
          const payload = payloadSchema.safeParse(preview.payload);
          if (preview.action !== "READ" || preview.source !== "web" || !payload.success) {
            throw new Error("That preview is not a read from a web chat.");
          }
          const call = payload.data;
          const read = readers.get(call.tool);
          // Checked before the approval is used, so a tool that is gone does not use it up.
          if (await workflow.getStatus(previewId) === "APPROVED" && read === undefined) {
            throw new Error(`"${call.tool}" cannot be read right now. If it belongs to another MCP server, ask the user to reconnect it in MCP Connector, then call this again.`);
          }
          let full: CallToolResult | undefined;
          await workflow.executeApproved(previewId, async () => {
            full = await read!(call.arguments, received[1]);
            if (full.isError === true) throw new Error(`"${call.tool}" reported an error: ${textOf(full).slice(0, 500)}`);
            // The audit log keeps a shortened copy; the web chat gets the whole result.
            return auditCopy(full);
          });
          return full as CallToolResult;
        }
      );
    }
  };
}

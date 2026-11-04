import { z } from "zod";
import { result } from "../mcp/tool-result.js";
import type { ConnectorDefinition, ConnectorRuntime } from "./connector-definition.js";
import { executeApprovedPreview } from "./connector-definition.js";
import type { ConnectorTokenProvider, NotionConnector } from "./connector.types.js";
import { OfficialNotionConnector } from "./notion.connector.js";
import { parseNotionDatabaseId } from "./notion-database-id.js";
import {
  createNotionPagePreview,
  executeNotionPagePreview,
  NOTION_MAX_MARKDOWN_LENGTH,
  NOTION_MAX_TITLE_LENGTH,
  NOTION_PAGE_TARGET
} from "./notion-page.js";

export const NOTION_DATABASE_SETTING = "databaseId";

export function createNotionDefinition(options: {
  /** Replaceable in tests. */
  readonly createConnector?: (tokens: ConnectorTokenProvider, databaseId: string) => NotionConnector;
} = {}): ConnectorDefinition {
  const createConnector = options.createConnector
    ?? ((tokens, databaseId) => new OfficialNotionConnector(tokens, { databaseId }));

  /** Checks the setting and the sign-in before anything is queued or run. */
  const connect = async (runtime: ConnectorRuntime): Promise<NotionConnector> => {
    const databaseId = runtime.requireSetting(NOTION_DATABASE_SETTING);
    await runtime.tokens.getAccessToken();
    return createConnector(runtime.tokens, databaseId);
  };

  const definition: ConnectorDefinition = {
    id: "notion",
    name: "Notion",
    description: "Lets agents add pages to one Notion database, each only after you approve it.",
    signIn: { kind: "notion-sign-in-service" },
    settings: [{
      key: NOTION_DATABASE_SETTING,
      label: "Database for new pages",
      help: "Pages are added to this database. When you connect Notion, give MCP Connector access to it.",
      placeholder: "Paste the database's link from Notion",
      parse: parseNotionDatabaseId
    }],
    previews: {
      handles: (preview) => preview.action === "CREATE" && preview.target === NOTION_PAGE_TARGET,
      prepare: async (runtime) => {
        const notion = await connect(runtime);
        return (preview) => executeNotionPagePreview(preview, notion);
      }
    },
    registerTools(server, { runtime, workflow }) {
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
          // Report a missing sign-in or database now, not after the user approved.
          await connect(runtime);
          const preview = await createNotionPagePreview(workflow, { title, markdown }, "mcp");
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
        async ({ previewId }) => result(await executeApprovedPreview(workflow, [{ definition, runtime }], previewId))
      );
    }
  };
  return definition;
}

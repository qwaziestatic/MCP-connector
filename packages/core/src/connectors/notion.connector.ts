import { Client, APIResponseError } from "@notionhq/client";
import type {
  ConnectorTokenProvider,
  NotionConnector,
  NotionPageDraft
} from "./connector.types.js";

export interface NotionPageParent {
  readonly databaseId: string;
}

export class OfficialNotionConnector implements NotionConnector {
  public constructor(
    private readonly tokenProvider: ConnectorTokenProvider,
    private readonly parent: NotionPageParent
  ) {}

  async createPage(draft: NotionPageDraft): Promise<{ readonly pageId: string; readonly url: string | null }> {
    try {
      const notion = new Client({
        auth: await this.tokenProvider.getAccessToken()
      });
      const response = await notion.pages.create({
        parent: {
          database_id: this.parent.databaseId
        },
        properties: {
          title: {
            title: [
              {
                text: {
                  content: draft.title
                }
              }
            ]
          }
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: draft.markdown.slice(0, 2_000)
                  }
                }
              ]
            }
          }
        ]
      });

      return {
        pageId: response.id,
        url: "url" in response && typeof response.url === "string" ? response.url : null
      };
    } catch (error) {
      if (error instanceof APIResponseError && error.status === 401) {
        throw new Error("Notion authorization has expired or was revoked.");
      }
      if (error instanceof APIResponseError && error.status === 403) {
        throw new Error("Notion denied page creation. Check integration access and database permissions.");
      }
      throw new Error("Notion page creation failed.");
    }
  }
}

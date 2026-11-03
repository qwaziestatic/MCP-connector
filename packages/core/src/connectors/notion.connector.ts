import { Client, APIResponseError } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints.js";
import type {
  ConnectorTokenProvider,
  NotionBlock,
  NotionConnector,
  NotionPageDraft
} from "./connector.types.js";

export interface NotionPageParent {
  readonly databaseId: string;
}

/** The parts of the Notion client this connector uses; replaceable in tests. */
export interface NotionApi {
  readonly pages: Pick<Client["pages"], "create">;
  readonly blocks: { readonly children: Pick<Client["blocks"]["children"], "append"> };
}

// Notion accepts at most 100 children and 500 KB per request (Request limits).
const maxBlocksPerRequest = 100;
const maxBytesPerRequest = 400_000;

/** Splits blocks into request-sized batches by count and by JSON size. */
export function batchNotionBlocks(blocks: readonly NotionBlock[]): NotionBlock[][] {
  const batches: NotionBlock[][] = [];
  let current: NotionBlock[] = [];
  let currentBytes = 0;
  for (const block of blocks) {
    const bytes = Buffer.byteLength(JSON.stringify(block), "utf8");
    if (current.length > 0 && (current.length >= maxBlocksPerRequest || currentBytes + bytes > maxBytesPerRequest)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(block);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class OfficialNotionConnector implements NotionConnector {
  public constructor(
    private readonly tokenProvider: ConnectorTokenProvider,
    private readonly parent: NotionPageParent,
    private readonly createClient: (auth: string) => NotionApi = (auth) => new Client({ auth })
  ) {}

  async createPage(draft: NotionPageDraft): Promise<{ readonly pageId: string; readonly url: string | null }> {
    const notion = this.createClient(await this.tokenProvider.getAccessToken());
    const [first = [], ...rest] = batchNotionBlocks(draft.blocks);

    let page: { readonly pageId: string; readonly url: string | null };
    try {
      const response = await notion.pages.create({
        parent: { database_id: this.parent.databaseId },
        properties: {
          title: { title: [{ text: { content: draft.title } }] }
        },
        children: first as unknown as BlockObjectRequest[]
      });
      page = {
        pageId: response.id,
        url: "url" in response && typeof response.url === "string" ? response.url : null
      };
    } catch (error) {
      throw this.describeError(error);
    }

    // Content beyond the first request is appended in order. If that fails,
    // the page exists but is incomplete, so say where it is.
    for (const batch of rest) {
      try {
        await notion.blocks.children.append({
          block_id: page.pageId,
          children: batch as unknown as BlockObjectRequest[]
        });
      } catch (error) {
        throw new Error(
          `Notion created the page but could not add all of its content${page.url === null ? "" : ` (${page.url})`}. `
          + `${this.describeError(error).message}`,
          { cause: error }
        );
      }
    }
    return page;
  }

  private describeError(error: unknown): Error {
    if (error instanceof APIResponseError && error.status === 401) {
      return new Error("Notion authorization has expired or was revoked.");
    }
    if (error instanceof APIResponseError && error.status === 403) {
      return new Error("Notion denied page creation. Check integration access and database permissions.");
    }
    if (error instanceof APIResponseError && error.status === 404 && error.code === "object_not_found") {
      return new Error("Share the target database with the MCP Connector integration in Notion.");
    }
    if (error instanceof APIResponseError && error.status === 400 && error.code === "validation_error") {
      return new Error(`Notion rejected the page request: ${error.message}`);
    }
    if (error instanceof TypeError || (error instanceof Error && /fetch|network|socket|connect/i.test(error.message))) {
      return new Error("Notion could not be reached. Check your internet connection and try again.");
    }
    return new Error("Notion page creation failed.");
  }
}

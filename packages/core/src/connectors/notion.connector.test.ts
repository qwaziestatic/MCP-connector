import { describe, expect, it, vi } from "vitest";
import type { NotionBlock } from "./connector.types.js";
import { markdownToNotionBlocks } from "./notion-page.js";
import { batchNotionBlocks, OfficialNotionConnector, type NotionApi } from "./notion.connector.js";

function fakeNotion(options: { failAppendAt?: number } = {}) {
  const calls: Array<{ readonly kind: "create" | "append"; readonly count: number }> = [];
  let appends = 0;
  const api: NotionApi = {
    pages: {
      create: vi.fn(async (request: { children?: unknown[] }) => {
        calls.push({ kind: "create", count: request.children?.length ?? 0 });
        return { id: "page-1", url: "https://notion.local/page-1" } as never;
      }) as never
    },
    blocks: {
      children: {
        append: vi.fn(async (request: { children: unknown[] }) => {
          appends += 1;
          if (appends === options.failAppendAt) throw new Error("socket hang up");
          calls.push({ kind: "append", count: request.children.length });
          return {} as never;
        }) as never
      }
    }
  };
  return { api, calls };
}

const tokenProvider = { getAccessToken: async () => "token" };

describe("OfficialNotionConnector", () => {
  it("creates the page with the first 100 blocks and appends the rest in order", async () => {
    const blocks = markdownToNotionBlocks(Array.from({ length: 250 }, (_, index) => `- ${index}`).join("\n"));
    const { api, calls } = fakeNotion();
    const connector = new OfficialNotionConnector(tokenProvider, { databaseId: "db" }, () => api);

    await expect(connector.createPage({ title: "Plan", blocks })).resolves.toEqual({
      pageId: "page-1",
      url: "https://notion.local/page-1"
    });
    expect(calls).toEqual([
      { kind: "create", count: 100 },
      { kind: "append", count: 100 },
      { kind: "append", count: 50 }
    ]);
  });

  it("says where the incomplete page is if appending fails", async () => {
    const blocks = markdownToNotionBlocks(Array.from({ length: 150 }, (_, index) => `- ${index}`).join("\n"));
    const { api } = fakeNotion({ failAppendAt: 1 });
    const connector = new OfficialNotionConnector(tokenProvider, { databaseId: "db" }, () => api);

    await expect(connector.createPage({ title: "Plan", blocks }))
      .rejects.toThrow("created the page but could not add all of its content (https://notion.local/page-1)");
  });

  it("keeps each request under the size limit as well as the count limit", () => {
    const large = markdownToNotionBlocks("x".repeat(150_000))[0] as NotionBlock;
    const batches = batchNotionBlocks([large, large, large, large]);

    expect(batches.map((batch) => batch.length)).toEqual([2, 2]);
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThan(500_000);
    }
  });
});

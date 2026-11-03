import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import type { NotionBlock, NotionConnector, NotionPageDraft } from "./connector.types.js";
import {
  createNotionPagePreview,
  executeNotionPagePreview,
  markdownToNotionBlocks,
  notionBlocksToText,
  NOTION_MAX_PAGE_BLOCKS,
  NOTION_PAGE_TARGET
} from "./notion-page.js";

function textOf(block: NotionBlock): string {
  const value = block[block.type] as { rich_text: Array<{ text: { content: string } }> };
  return value.rich_text.map((piece) => piece.text.content).join("");
}

describe("markdownToNotionBlocks", () => {
  it("maps Markdown structure to Notion block types", () => {
    const blocks = markdownToNotionBlocks([
      "# Title",
      "## Section",
      "#### Deep heading",
      "First line",
      "second line",
      "",
      "- bullet",
      "* star bullet",
      "1. one",
      "2) two",
      "- [ ] open task",
      "- [x] done task",
      "> quoted",
      "> more",
      "---",
      "```ts",
      "const x = 1;",
      "",
      "```",
      "```weird-lang",
      "?",
      "```"
    ].join("\n"));

    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1", "heading_2", "heading_3", "paragraph",
      "bulleted_list_item", "bulleted_list_item", "numbered_list_item", "numbered_list_item",
      "to_do", "to_do", "quote", "divider", "code", "code"
    ]);
    expect(textOf(blocks[3]!)).toBe("First line\nsecond line");
    expect(blocks[9]!.to_do).toMatchObject({ checked: true });
    expect(textOf(blocks[10]!)).toBe("quoted\nmore");
    expect(blocks[12]!.code).toMatchObject({ language: "typescript" });
    expect(textOf(blocks[12]!)).toBe("const x = 1;\n");
    expect(blocks[13]!.code).toMatchObject({ language: "plain text" });
  });

  it("splits long text into 2,000-character pieces without losing any of it", () => {
    const text = "a".repeat(4_500);
    const [block] = markdownToNotionBlocks(text);
    const pieces = (block!.paragraph as { rich_text: Array<{ text: { content: string } }> }).rich_text;

    expect(pieces.map((piece) => piece.text.content.length)).toEqual([2_000, 2_000, 500]);
    expect(textOf(block!)).toBe(text);
  });

  it("splits text needing more than 100 pieces across blocks of the same type", () => {
    const text = "b".repeat(2_000 * 150);
    const blocks = markdownToNotionBlocks(text);

    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.map(textOf).join("")).toBe(text);
  });

  it("renders the blocks as readable text for the approval preview", () => {
    const blocks = markdownToNotionBlocks("# Plan\n1. ship\n2. test\n- [x] review\n```py\nprint(1)\n```");
    expect(notionBlocksToText(blocks)).toBe("# Plan\n1. ship\n2. test\n☑ review\n```python\nprint(1)\n```");
  });
});

describe("Notion page previews", () => {
  const capture = () => {
    const created: NotionPageDraft[] = [];
    const connector: NotionConnector = {
      createPage: vi.fn(async (draft: NotionPageDraft) => {
        created.push(draft);
        return { pageId: "page-1", url: "https://notion.local/page-1" };
      })
    };
    return { created, connector };
  };

  it("sends exactly the title and blocks stored in the approved preview", async () => {
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const preview = await createNotionPagePreview(workflow, { title: "Plan", markdown: "# Goals\n- ship" }, "ui");
    await workflow.approve(preview.id);
    const { created, connector } = capture();

    await workflow.executeApproved(preview.id, (approved) => executeNotionPagePreview(approved, connector));

    expect(preview.target).toBe(NOTION_PAGE_TARGET);
    expect(preview.payload).toMatchObject({ title: "Plan", content: "# Goals\n• ship", blockCount: 2 });
    expect(created).toEqual([{ title: "Plan", blocks: preview.payload.notionBlocks }]);
  });

  it("refuses pages over the block limit at preview time", async () => {
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const markdown = Array.from({ length: NOTION_MAX_PAGE_BLOCKS + 1 }, (_, index) => `- item ${index}`).join("\n");

    await expect(createNotionPagePreview(workflow, { title: "Big", markdown }, "mcp"))
      .rejects.toThrow("the limit is 1000");
  });

  it("refuses previews from other targets or older payload formats without calling Notion", async () => {
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const { created, connector } = capture();
    const other = await workflow.createPreview("CREATE", "GitHub issue", "s", { title: "x" });
    const legacy = await workflow.createPreview("CREATE", NOTION_PAGE_TARGET, "s", {
      workspacePath: "C:\\Users\\leul\\project",
      title: "x",
      markdown: "# x"
    });

    await expect(executeNotionPagePreview(other, connector)).rejects.toThrow("not a Notion page");
    await expect(executeNotionPagePreview(legacy, connector)).rejects.toThrow("older version");
    expect(created).toEqual([]);
  });
});

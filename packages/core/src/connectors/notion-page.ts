// Turns Markdown into the exact Notion blocks that a page preview stores, and
// executes approved previews by sending those stored blocks unchanged. The
// desktop UI and the MCP tools both use this module, so what the user approves
// is exactly what Notion receives.
import { z } from "zod";
import type { WorkflowPreview, WorkflowSource } from "../workflow/workflow.types.js";
import type { WorkflowService } from "../workflow/workflow.service.js";
import type { NotionBlock, NotionConnector, NotionRichText } from "./connector.types.js";

export const NOTION_PAGE_TARGET = "Notion project page";

/** Notion rejects a text object longer than this (Request limits). */
export const NOTION_MAX_TEXT_LENGTH = 2_000;
/** Notion rejects arrays (rich text, children) with more elements than this. */
export const NOTION_MAX_ARRAY_LENGTH = 100;
/** Pages larger than this are refused at preview time instead of being cut. */
export const NOTION_MAX_PAGE_BLOCKS = 1_000;
export const NOTION_MAX_TITLE_LENGTH = 200;
export const NOTION_MAX_MARKDOWN_LENGTH = 256_000;

const codeLanguages = new Set([
  "bash", "c", "c#", "c++", "css", "dart", "diff", "docker", "go", "graphql", "html", "java",
  "javascript", "json", "kotlin", "lua", "makefile", "markdown", "mermaid", "php", "plain text",
  "powershell", "python", "r", "ruby", "rust", "scala", "scss", "shell", "sql", "swift", "toml",
  "typescript", "xml", "yaml"
]);
const codeLanguageAliases: Readonly<Record<string, string>> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", sh: "shell", zsh: "shell",
  console: "shell", yml: "yaml", md: "markdown", cpp: "c++", cs: "c#", csharp: "c#",
  golang: "go", rs: "rust", rb: "ruby", ps1: "powershell", pwsh: "powershell",
  dockerfile: "docker", text: "plain text", txt: "plain text", plaintext: "plain text"
};

type TextBlockType = "paragraph" | "heading_1" | "heading_2" | "heading_3"
  | "bulleted_list_item" | "numbered_list_item" | "quote" | "to_do" | "code";

function richText(text: string): NotionRichText[] {
  const pieces: NotionRichText[] = [];
  for (let start = 0; start < text.length; start += NOTION_MAX_TEXT_LENGTH) {
    pieces.push({ type: "text", text: { content: text.slice(start, start + NOTION_MAX_TEXT_LENGTH) } });
  }
  return pieces;
}

// A block may hold at most 100 rich text pieces, so very long text becomes
// several consecutive blocks of the same type.
function textBlocks(type: TextBlockType, text: string, extra: Record<string, unknown> = {}): NotionBlock[] {
  const pieces = richText(text);
  if (pieces.length === 0) {
    return [{ object: "block", type, [type]: { rich_text: [], ...extra } } as NotionBlock];
  }
  const blocks: NotionBlock[] = [];
  for (let start = 0; start < pieces.length; start += NOTION_MAX_ARRAY_LENGTH) {
    blocks.push({
      object: "block",
      type,
      [type]: { rich_text: pieces.slice(start, start + NOTION_MAX_ARRAY_LENGTH), ...extra }
    } as NotionBlock);
  }
  return blocks;
}

function codeLanguage(info: string): string {
  const name = info.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const language = codeLanguageAliases[name] ?? name;
  return codeLanguages.has(language) ? language : "plain text";
}

/**
 * Converts Markdown to Notion blocks: headings, bulleted, numbered and to-do
 * list items, quotes, fenced code, dividers and paragraphs. Inline formatting
 * such as **bold** or links is kept as literal text, and nested lists are
 * flattened. The preview shows the result, so nothing is hidden from the user.
 */
export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: NotionBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) blocks.push(...textBlocks("paragraph", paragraph.join("\n")));
    if (quote.length > 0) blocks.push(...textBlocks("quote", quote.join("\n")));
    paragraph = [];
    quote = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();

    const fence = /^(```|~~~)(.*)$/u.exec(trimmed);
    if (fence !== null) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      blocks.push(...textBlocks("code", code.join("\n"), { language: codeLanguage(fence[2] ?? "") }));
      continue;
    }
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    const quoteLine = /^>\s?(.*)$/u.exec(trimmed);
    if (quoteLine !== null) {
      if (paragraph.length > 0) flush();
      quote.push(quoteLine[1]!);
      continue;
    }
    if (quote.length > 0) flush();

    const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed);
    const todo = /^[-*+]\s+\[([ xX])\]\s+(.*)$/u.exec(trimmed);
    const bullet = /^[-*+]\s+(.*)$/u.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/u.exec(trimmed);
    if (/^([-*_])(\s*\1){2,}$/u.test(trimmed)) {
      flush();
      blocks.push({ object: "block", type: "divider", divider: {} } as NotionBlock);
    } else if (heading !== null) {
      flush();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push(...textBlocks(`heading_${level}`, heading[2]!.replace(/\s+#+\s*$/u, "")));
    } else if (todo !== null) {
      flush();
      blocks.push(...textBlocks("to_do", todo[2]!, { checked: todo[1]!.toLowerCase() === "x" }));
    } else if (bullet !== null) {
      flush();
      blocks.push(...textBlocks("bulleted_list_item", bullet[1]!));
    } else if (numbered !== null) {
      flush();
      blocks.push(...textBlocks("numbered_list_item", numbered[1]!));
    } else {
      paragraph.push(trimmed);
    }
  }
  flush();
  return blocks;
}

function plainText(block: NotionBlock): string {
  const value = block[block.type] as { rich_text?: readonly NotionRichText[] } | undefined;
  return (value?.rich_text ?? []).map((piece) => piece.text.content).join("");
}

/** A readable rendering of the blocks, shown to the user in the approval preview. */
export function notionBlocksToText(blocks: readonly NotionBlock[]): string {
  const lines: string[] = [];
  let number = 0;
  for (const block of blocks) {
    number = block.type === "numbered_list_item" ? number + 1 : 0;
    const text = plainText(block);
    switch (block.type) {
      case "heading_1": lines.push(`# ${text}`); break;
      case "heading_2": lines.push(`## ${text}`); break;
      case "heading_3": lines.push(`### ${text}`); break;
      case "bulleted_list_item": lines.push(`• ${text}`); break;
      case "numbered_list_item": lines.push(`${number}. ${text}`); break;
      case "to_do": {
        const checked = (block.to_do as { checked?: boolean } | undefined)?.checked === true;
        lines.push(`${checked ? "☑" : "☐"} ${text}`);
        break;
      }
      case "quote": lines.push(text.split("\n").map((line) => `> ${line}`).join("\n")); break;
      case "code": {
        const language = (block.code as { language?: string } | undefined)?.language ?? "plain text";
        lines.push(`\`\`\`${language}\n${text}\n\`\`\``);
        break;
      }
      case "divider": lines.push("———"); break;
      default: lines.push(text);
    }
  }
  return lines.join("\n");
}

const richTextSchema = z.object({
  type: z.literal("text"),
  text: z.object({ content: z.string().max(NOTION_MAX_TEXT_LENGTH) })
});
const blockSchema = z.object({
  object: z.literal("block"),
  type: z.enum([
    "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item",
    "numbered_list_item", "quote", "to_do", "code", "divider"
  ])
}).passthrough().superRefine((block, context) => {
  const value = (block as Record<string, unknown>)[block.type];
  if (typeof value !== "object" || value === null) {
    context.addIssue({ code: "custom", message: `Block is missing its ${block.type} content.` });
    return;
  }
  if (block.type !== "divider") {
    const parsed = z.array(richTextSchema).max(NOTION_MAX_ARRAY_LENGTH)
      .safeParse((value as { rich_text?: unknown }).rich_text);
    if (!parsed.success) context.addIssue({ code: "custom", message: "Block has invalid rich text." });
  }
});
const notionPagePayloadSchema = z.object({
  title: z.string().trim().min(1).max(NOTION_MAX_TITLE_LENGTH),
  notionBlocks: z.array(blockSchema).max(NOTION_MAX_PAGE_BLOCKS)
});

export interface NotionPageInput {
  readonly title: string;
  readonly markdown: string;
}

/** Creates a preview whose payload holds the exact blocks that will be sent. */
export async function createNotionPagePreview(
  workflow: WorkflowService,
  input: NotionPageInput,
  source: WorkflowSource
): Promise<WorkflowPreview> {
  const title = z.string().trim().min(1).max(NOTION_MAX_TITLE_LENGTH).parse(input.title);
  const markdown = z.string().max(NOTION_MAX_MARKDOWN_LENGTH).parse(input.markdown);
  const blocks = markdownToNotionBlocks(markdown);
  if (blocks.length > NOTION_MAX_PAGE_BLOCKS) {
    throw new Error(
      `This page would have ${blocks.length} Notion blocks; the limit is ${NOTION_MAX_PAGE_BLOCKS}. Shorten the content.`
    );
  }
  return workflow.createPreview(
    "CREATE",
    NOTION_PAGE_TARGET,
    `Create Notion page "${title}" (${blocks.length} ${blocks.length === 1 ? "block" : "blocks"})`,
    { title, content: notionBlocksToText(blocks), blockCount: blocks.length, notionBlocks: blocks },
    source
  );
}

/** Sends an approved page preview's stored title and blocks, unchanged. */
export async function executeNotionPagePreview(
  preview: WorkflowPreview,
  connector: NotionConnector
): Promise<{ readonly pageId: string; readonly url: string | null }> {
  if (preview.action !== "CREATE" || preview.target !== NOTION_PAGE_TARGET) {
    throw new Error("Preview is not a Notion page creation.");
  }
  const payload = notionPagePayloadSchema.safeParse(preview.payload);
  if (!payload.success) {
    throw new Error("This Notion page preview was created by an older version. Create a new preview.");
  }
  return connector.createPage({
    title: payload.data.title,
    blocks: payload.data.notionBlocks as unknown as readonly NotionBlock[]
  });
}

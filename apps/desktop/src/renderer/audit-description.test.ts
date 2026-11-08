import { describe, expect, it } from "vitest";
import { describeAuditRecord, mainArgument } from "./audit-description";

function record(value: unknown): { previewJson: string } {
  return { previewJson: JSON.stringify(value) };
}

function externalCall(args: Record<string, unknown>) {
  return {
    action: "CALL",
    target: "files: write_file",
    summary: 'Run "write_file" on files',
    payload: { server: "files", serverName: "files", tool: "write_file", arguments: args }
  };
}

describe("describeAuditRecord", () => {
  it("gives a Notion page's summary, not its blocks", () => {
    const preview = {
      action: "CREATE",
      summary: 'Create Notion page "Weekly plan" (2 blocks)',
      payload: { title: "Weekly plan", content: "Secret plans\nMore", notionBlocks: [{ type: "paragraph" }] }
    };
    expect(describeAuditRecord(record(preview))).toBe('Create Notion page "Weekly plan" (2 blocks)');
  });

  it("adds the path an external call works on, and leaves out the file's contents", () => {
    const text = describeAuditRecord(record(externalCall({ path: "/home/leul/notes.md", content: "my private notes" })));
    expect(text).toBe('Run "write_file" on files · path: /home/leul/notes.md');
    expect(text).not.toContain("private");
  });

  it("reads executed records, which wrap the preview with its result", () => {
    const executed = { preview: externalCall({ file_path: "C:\\Projects\\a.txt" }), result: { text: "done: secret output" } };
    expect(describeAuditRecord(record(executed))).toBe('Run "write_file" on files · file_path: C:\\Projects\\a.txt');
  });

  it("never shows arguments that may hold secrets", () => {
    const text = describeAuditRecord(record(externalCall({ token: "ghp_abc", apiKey: "sk-123", password: "hunter2" })));
    expect(text).toBe('Run "write_file" on files');
  });

  it("drops the query, fragment and credentials from a web address", () => {
    expect(mainArgument({ url: "https://user:pass@example.com/docs/page?access_token=abc#top" }))
      .toBe("url: https://example.com/docs/page");
  });

  it("keeps the end of a long path, where the file's name is", () => {
    const longPath = `C:\\Users\\leul\\${"very-long-folder-name\\".repeat(10)}plan.md`;
    const argument = mainArgument({ path: longPath })!;
    expect(argument.length).toBeLessThanOrEqual("path: ".length + 80);
    expect(argument.startsWith("path: …")).toBe(true);
    expect(argument.endsWith("\\plan.md")).toBe(true);
  });

  it("truncates other long values, and long lines, at the end", () => {
    const argument = mainArgument({ query: "word ".repeat(40) })!;
    expect(argument.length).toBeLessThanOrEqual("query: ".length + 80);
    expect(argument.endsWith("…")).toBe(true);

    const text = describeAuditRecord(record({ ...externalCall({ path: "/a.txt" }), summary: "x".repeat(200) }))!;
    expect(text.length).toBeLessThanOrEqual(120);
  });

  it("shows the first of several paths", () => {
    expect(mainArgument({ paths: ["/a.txt", "/b.txt", "/c.txt"] })).toBe("paths: /a.txt (+2 more)");
  });

  it("returns null when the stored preview can't be read", () => {
    expect(describeAuditRecord({ previewJson: "{ broken" })).toBeNull();
    expect(describeAuditRecord(record({ action: "CALL" }))).toBeNull();
  });
});

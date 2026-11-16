import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatResult, readAnswer, RESULT_LIMIT, trimResult } from "./result.ts";

const previewId = "6b2c8f2e-1f1e-4c47-9b1a-6f1d2f3e4a5b";

describe("trimResult", () => {
  it("leaves a result within the limit alone", () => {
    assert.deepEqual(trimResult("short"), { text: "short", trimmed: false, originalLength: 5 });
    const exact = "x".repeat(RESULT_LIMIT);
    assert.equal(trimResult(exact).trimmed, false);
  });

  it("keeps the start of a longer result and says how long it was", () => {
    const trimmed = trimResult(`${"a".repeat(RESULT_LIMIT)}tail`);
    assert.equal(trimmed.trimmed, true);
    assert.equal(trimmed.text.length, RESULT_LIMIT);
    assert.equal(trimmed.originalLength, RESULT_LIMIT + 4);
    assert.equal(trimmed.text.includes("tail"), false);
  });

  it("never cuts a character in half", () => {
    // The emoji is two code units; a limit in the middle of it drops it whole.
    const trimmed = trimResult("ab😀cd", 3);
    assert.deepEqual(trimmed, { text: "ab", trimmed: true, originalLength: 6 });
    assert.equal(trimResult("ab😀cd", 4).text, "ab😀");
  });
});

describe("formatResult", () => {
  it("puts the result in a block labelled mcp-result", () => {
    assert.equal(
      formatResult("filesystem_inspect_workspace", '{"entries": 3}'),
      'Result of filesystem_inspect_workspace:\n```mcp-result\n{"entries": 3}\n```'
    );
  });

  it("says a trimmed result is incomplete and how to ask for a part that fits", () => {
    const message = formatResult("filesystem_read_file", "x".repeat(25_000));
    const note = message.slice(message.lastIndexOf("\n```\n") + 5);
    assert.equal(
      note,
      "(This result is incomplete. It was cut off after the first 20,000 of 25,000 characters, "
        + "so the text above stops early, whatever line numbers or counts it gives. Do not guess the missing part. "
        + "Ask again for less: for a file, fewer lines with startLine and maxLines.)"
    );
    assert.equal(message.length < 20_500, true);
    assert.equal(formatResult("filesystem_read_file", "x".repeat(20_000)).includes("incomplete"), false);
  });

  it("keeps what a file read says about itself ahead of the cut, and corrects it in the note", () => {
    // What filesystem_read_file answers for 2,000 long lines: the counts come first, then the text.
    const lines = Array.from({ length: 2_000 }, (_unused, index) => `line ${index + 1} ${"x".repeat(60)}`);
    const answer = JSON.stringify({ path: "log.txt", totalLines: 9_000, startLine: 1, endLine: 2_000, hasMore: true, text: lines.join("\n") }, null, 2);
    const message = formatResult("filesystem_read_file", answer);

    assert.match(message, /"endLine": 2000/u);
    assert.equal(message.includes("line 2000 "), false);
    assert.match(message, /This result is incomplete\..*whatever line numbers or counts it gives.*startLine and maxLines/u);
  });

  it("uses a longer fence when the result has code blocks of its own", () => {
    const message = formatResult("files__read_file", "# Readme\n```sh\nnpm test\n```\n");
    assert.equal(message, "Result of files__read_file:\n````mcp-result\n# Readme\n```sh\nnpm test\n```\n\n````");
    assert.equal(formatResult("t", "a ````` b").startsWith("Result of t:\n``````mcp-result\n"), true);
  });
});

describe("readAnswer", () => {
  const previewAnswer = (extra: Record<string, unknown>) => {
    const value = { requiresApproval: true, preview: { id: previewId, summary: "Run the read-only tool" }, ...extra };
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  };

  it("reads a tool's result", () => {
    assert.deepEqual(
      readAnswer({ content: [{ type: "text", text: "one" }, { type: "image", data: "…" }, { type: "text", text: "two" }] }),
      { kind: "result", text: "one\n[image]\ntwo", isError: false }
    );
    assert.deepEqual(readAnswer({ content: [{ type: "text", text: "disk full" }], isError: true }),
      { kind: "result", text: "disk full", isError: true });
    assert.deepEqual(readAnswer({}), { kind: "result", text: "", isError: false });
  });

  it("reads a preview and the tool MCP Connector names for running it", () => {
    assert.deepEqual(readAnswer(previewAnswer({ executeTool: "web_run_approved_read" })), {
      kind: "preview",
      previewId,
      executeTool: "web_run_approved_read",
      summary: "Run the read-only tool"
    });
  });

  it("reads a preview from the text when there is no structured content", () => {
    const { content } = previewAnswer({ executeTool: "external_run_approved_call" });
    assert.equal(readAnswer({ content }).kind, "preview");
  });

  it("does not guess the tool when MCP Connector names none", () => {
    for (const answer of [previewAnswer({}), previewAnswer({ executeTool: 7 }), previewAnswer({ executeTool: "two words" })]) {
      const read = readAnswer(answer);
      assert.equal(read.kind, "result");
      assert.equal(read.kind === "result" && read.isError, true);
      assert.match(read.kind === "result" ? read.text : "", /did not say which tool runs the request/u);
    }
  });

  it("treats an error as a result, even if it looks like a preview", () => {
    assert.equal(readAnswer({ ...previewAnswer({ executeTool: "web_run_approved_read" }), isError: true }).kind, "result");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_REQUEST_LENGTH, parseRequest, unfence } from "./request.ts";

const ticked = ["filesystem_inspect_workspace", "notes__add_note"];

function reason(text: string, tools: readonly string[] = ticked): string {
  const parsed = parseRequest(text, tools);
  assert.equal(parsed.ok, false);
  return parsed.ok ? "" : parsed.reason;
}

describe("parseRequest", () => {
  it("reads a request for a ticked tool", () => {
    assert.deepEqual(
      parseRequest('{"tool": "notes__add_note", "arguments": {"title": "Plan", "tags": ["a", "b"]}}', ticked),
      { ok: true, request: { tool: "notes__add_note", arguments: { title: "Plan", tags: ["a", "b"] } } }
    );
  });

  it("treats missing arguments as none", () => {
    assert.deepEqual(
      parseRequest('{"tool": "filesystem_inspect_workspace"}', ticked),
      { ok: true, request: { tool: "filesystem_inspect_workspace", arguments: {} } }
    );
  });

  it("refuses text that is not JSON", () => {
    assert.match(reason('{"tool": "notes__add_note", "arguments": {'), /not valid JSON/u);
    assert.match(reason("run notes__add_note please"), /not valid JSON/u);
    assert.match(reason(""), /not valid JSON/u);
  });

  it("refuses JSON that is not one request object", () => {
    assert.match(reason('[{"tool": "notes__add_note"}]'), /one JSON object/u);
    assert.match(reason('"notes__add_note"'), /one JSON object/u);
    assert.match(reason("null"), /one JSON object/u);
    assert.match(reason('{"arguments": {}}'), /needs a "tool"/u);
    assert.match(reason('{"tool": 7}'), /needs a "tool"/u);
    assert.match(reason('{"tool": "two words"}'), /needs a "tool"/u);
    assert.match(reason('{"tool": "notes__add_note", "arguments": ["Plan"]}'), /"arguments" must be a JSON object/u);
    assert.match(reason('{"tool": "notes__add_note", "arguments": {}, "previewId": "x"}'), /may only have "tool" and "arguments", not "previewId"/u);
  });

  it("refuses a tool that is not ticked for this chat", () => {
    assert.match(reason('{"tool": "github_list_repositories", "arguments": {}}'), /"github_list_repositories" is not ticked for this chat/u);
    // None ticked, which is how every chat starts.
    assert.match(reason('{"tool": "notes__add_note", "arguments": {}}', []), /is not ticked/u);
    // A name is matched exactly.
    assert.match(reason('{"tool": "notes__add_note ", "arguments": {}}'), /needs a "tool"/u);
    assert.match(reason('{"tool": "NOTES__ADD_NOTE", "arguments": {}}'), /is not ticked/u);
  });

  it("refuses oversized arguments before reading them", () => {
    const large = JSON.stringify({ tool: "notes__add_note", arguments: { body: "x".repeat(MAX_REQUEST_LENGTH) } });
    assert.match(reason(large), /too large: 100,0\d\d characters, and the limit is 100,000/u);
    const allowed = JSON.stringify({ tool: "notes__add_note", arguments: { body: "x".repeat(MAX_REQUEST_LENGTH - 100) } });
    assert.equal(parseRequest(allowed, ticked).ok, true);
  });
});

describe("unfence", () => {
  it("takes a pasted request out of its code block", () => {
    const request = '{"tool": "notes__add_note", "arguments": {}}';
    assert.equal(unfence(`\`\`\`mcp-call\n${request}\n\`\`\``), request);
    assert.equal(unfence(`\n\`\`\`\`mcp-call\r\n${request}\r\n\`\`\`\`\n`), request);
    assert.equal(unfence(`~~~\n${request}\n~~~`), request);
  });

  it("leaves text that is not one code block as it is", () => {
    assert.equal(unfence('{"tool": "x"}'), '{"tool": "x"}');
    assert.equal(unfence("```mcp-call\n{}"), "```mcp-call\n{}");
  });
});

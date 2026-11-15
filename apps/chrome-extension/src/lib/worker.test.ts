// The background worker's logic, run against MCP Connector's real server.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { advance, follow, INITIAL_STATE, type RunState } from "./approval.ts";
import type { McpTool } from "./mcp-client.ts";
import type { ToolAnswer } from "./result.ts";
import { BROWSER_KEY, memoryStore, startApp } from "./testing.ts";
import { createWorker, reply, type ConnectionStatus } from "./worker.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp(options: { askBeforeWebReads?: () => boolean; pair?: boolean } = {}) {
  const app = await startApp(options);
  cleanups.push(() => app.close());
  const saved = memoryStore();
  const session = memoryStore();
  const worker = createWorker({ saved, session });
  if (options.pair !== false) {
    await worker.handle({ type: "save-pairing", browserKey: BROWSER_KEY, port: app.port });
  }
  const inspect = '{"tool": "filesystem_inspect_workspace", "arguments": {}}';
  const run = (text: string, tabId = 1, chatId: string | null = "chat-a") =>
    worker.handle({ type: "run", tabId, chatId, text }) as Promise<ToolAnswer>;
  const tick = (tools: string[], tabId = 1, chatId: string | null = "chat-a") =>
    worker.handle({ type: "set-ticks", tabId, chatId, tools }) as Promise<string[]>;
  return { app, worker, saved, session, inspect, run, tick };
}

describe("pairing", () => {
  it("starts unpaired, and says what is wrong with a pairing", async () => {
    const { app, worker, saved } = await setUp({ pair: false });
    assert.deepEqual(await worker.handle({ type: "get-status" }), { state: "not-paired", port: 47_820 });

    await assert.rejects(worker.handle({ type: "save-pairing", browserKey: "short", port: app.port }), /does not look like a browser key/u);
    await assert.rejects(worker.handle({ type: "save-pairing", browserKey: BROWSER_KEY, port: 0 }), /port must be a number/u);
    await assert.rejects(worker.handle({ type: "save-pairing", browserKey: `${BROWSER_KEY}\r\nx: y`, port: app.port }), /does not look like a browser key/u);
    assert.equal(saved.values.size, 0);

    const wrong = await worker.handle({ type: "save-pairing", browserKey: "wrong-key-0123456789-abcdefghij", port: app.port });
    assert.deepEqual(wrong, { state: "wrong-key", port: app.port });

    const connected = await worker.handle({ type: "save-pairing", browserKey: ` ${BROWSER_KEY}\n`, port: app.port }) as ConnectionStatus;
    assert.equal(connected.state, "connected");

    await app.close();
    assert.deepEqual(await worker.handle({ type: "get-status" }), { state: "app-not-running", port: app.port });
  });

  it("offers the tools a chat can be given, and never shows the key", async () => {
    const { worker } = await setUp();
    const status = await worker.handle({ type: "get-status" }) as { state: string; tools: McpTool[] };
    const names = status.tools.map((tool) => tool.name);

    assert.equal(names.includes("filesystem_inspect_workspace"), true);
    assert.equal(names.includes("workspace_get_selected"), true);
    // The tools that follow or finish a preview are the extension's own business.
    assert.equal(names.includes("workflow_preview_status"), false);
    assert.equal(names.includes("web_run_approved_read"), false);
    assert.equal(JSON.stringify(status).includes(BROWSER_KEY), false);
  });

  it("forgets the pairing", async () => {
    const { worker, saved } = await setUp();
    assert.deepEqual(await worker.handle({ type: "forget-pairing" }), { state: "not-paired", port: 47_820 });
    assert.equal(saved.values.size, 0);
    await assert.rejects(worker.handle({ type: "run", tabId: 1, chatId: "chat-a", text: "{}" }), /browser key in this extension's options/u);
  });
});

describe("what a chat may run", () => {
  it("refuses a tool that is not ticked, before anything reaches MCP Connector", async () => {
    const { app, run, tick, inspect } = await setUp();
    await assert.rejects(run(inspect), /"filesystem_inspect_workspace" is not ticked for this chat/u);

    await tick(["workspace_get_selected"]);
    await assert.rejects(run(inspect), /is not ticked for this chat/u);
    await assert.rejects(run("{ not json"), /not valid JSON/u);
    assert.deepEqual(await app.workflow.listPending(), []);
  });

  it("lets only tools the server offers to chats be ticked", async () => {
    const { tick, run } = await setUp();
    assert.deepEqual(
      await tick(["filesystem_inspect_workspace", "web_run_approved_read", "workflow_preview_status", "no_such_tool", "filesystem_inspect_workspace"]),
      ["filesystem_inspect_workspace"]
    );
    // So a chat cannot ask for the tool that runs approved previews.
    await assert.rejects(
      run('{"tool": "web_run_approved_read", "arguments": {"previewId": "6b2c8f2e-1f1e-4c47-9b1a-6f1d2f3e4a5b"}}'),
      /is not ticked for this chat/u
    );
  });

  it("keeps ticks with their chat and their tab", async () => {
    const { worker, tick, run, inspect } = await setUp();
    await tick(["filesystem_inspect_workspace"], 1, "chat-a");

    assert.deepEqual(await worker.handle({ type: "get-ticks", tabId: 1, chatId: "chat-a" }), ["filesystem_inspect_workspace"]);
    assert.deepEqual(await worker.handle({ type: "get-ticks", tabId: 2, chatId: "chat-a" }), []);
    await assert.rejects(run(inspect, 2, "chat-a"), /is not ticked/u);
    // Another chat in the same tab starts with none ticked, and going back does not restore them.
    await assert.rejects(run(inspect, 1, "chat-b"), /is not ticked/u);
    assert.deepEqual(await worker.handle({ type: "get-ticks", tabId: 1, chatId: "chat-a" }), []);

    // A new chat keeps its ticks when its first message gives it an address.
    await tick(["filesystem_inspect_workspace"], 3, null);
    assert.equal((await run(inspect, 3, "chat-new")).kind, "preview");

    await worker.forgetTab(3);
    assert.deepEqual(await worker.handle({ type: "get-ticks", tabId: 3, chatId: "chat-new" }), []);
  });
});

describe("a request that waits for approval", () => {
  it("returns no data until the user approves in the app, then runs once with the tool the app named", async () => {
    const { app, worker, run, tick, inspect } = await setUp();
    await tick(["filesystem_inspect_workspace"]);

    const answer = await run(inspect);
    assert.equal(answer.kind, "preview");
    assert.equal(JSON.stringify(answer).includes("Private notes"), false);
    const previewId = answer.kind === "preview" ? answer.previewId : "";
    assert.deepEqual((await app.workflow.listPending()).map((item) => [item.preview.id, item.preview.source, item.status]),
      [[previewId, "web", "PREVIEWED"]]);

    assert.equal(await worker.handle({ type: "preview-status", previewId }), "PREVIEWED");
    await app.workflow.approve(previewId);
    assert.equal(await worker.handle({ type: "preview-status", previewId }), "APPROVED");

    const finished = await worker.handle({ type: "finish-preview", previewId }) as ToolAnswer;
    assert.equal(finished.kind, "result");
    assert.match(finished.kind === "result" ? finished.text : "", /Private notes/u);
    assert.equal(await app.workflow.getStatus(previewId), "EXECUTED");

    await assert.rejects(worker.handle({ type: "finish-preview", previewId }), /not waiting for that request/u);
  });

  it("does not run a preview before it is approved", async () => {
    const { app, worker, run, tick, inspect } = await setUp();
    await tick(["filesystem_inspect_workspace"]);
    const answer = await run(inspect);
    const previewId = answer.kind === "preview" ? answer.previewId : "";

    const early = await worker.handle({ type: "finish-preview", previewId }) as ToolAnswer;
    assert.deepEqual([early.kind, early.kind === "result" && early.isError], ["result", true]);
    assert.match(early.kind === "result" ? early.text : "", /Explicit approval is required/u);
    assert.equal(await app.workflow.getStatus(previewId), "PREVIEWED");
  });

  it("only follows and finishes previews that came from its own requests", async () => {
    const { app, worker } = await setUp();
    // A preview this extension never asked for, even an approved one.
    const other = await app.workflow.createPreview("READ", "filesystem_inspect_workspace", "Read", { tool: "filesystem_inspect_workspace", arguments: {} }, "web");
    await app.workflow.approve(other.id);

    await assert.rejects(worker.handle({ type: "preview-status", previewId: other.id }), /not waiting for that request/u);
    await assert.rejects(worker.handle({ type: "finish-preview", previewId: other.id }), /not waiting for that request/u);
    await assert.rejects(worker.handle({ type: "finish-preview", previewId: "not-an-id" }), /names no preview/u);
    assert.equal(await app.workflow.getStatus(other.id), "APPROVED");
  });

  it("goes from Run to the result through the state machine, with the user approving meanwhile", async () => {
    const { app, worker, run, tick, inspect } = await setUp();
    await tick(["filesystem_inspect_workspace"]);
    const phases: string[] = [];
    let polls = 0;

    const first = advance(INITIAL_STATE, { type: "answer", answer: await run(inspect) });
    const final = await follow(first, {
      status: (previewId) => worker.handle({ type: "preview-status", previewId }) as Promise<string>,
      execute: (previewId) => worker.handle({ type: "finish-preview", previewId }) as Promise<ToolAnswer>,
      wait: async () => {
        polls += 1;
        // The user approves in the app while the panel waits.
        if (polls === 3) await app.workflow.approve((await app.workflow.listPending())[0]!.preview.id);
      },
      onState: (state: RunState) => { phases.push(state.phase); }
    });

    assert.equal(final.phase, "done");
    assert.match(final.phase === "done" ? final.text : "", /Private notes/u);
    // Waiting when the preview arrives and after two checks; the third check finds it approved.
    assert.deepEqual(phases, ["waiting", "waiting", "waiting", "executing", "done"]);
  });

  it("says rejected when the user rejects, and nothing runs", async () => {
    const { app, worker, run, tick, inspect } = await setUp();
    await tick(["filesystem_inspect_workspace"]);
    const first = advance(INITIAL_STATE, { type: "answer", answer: await run(inspect) });
    const executed: string[] = [];

    const final = await follow(first, {
      status: (previewId) => worker.handle({ type: "preview-status", previewId }) as Promise<string>,
      execute: async (previewId) => {
        executed.push(previewId);
        return worker.handle({ type: "finish-preview", previewId }) as Promise<ToolAnswer>;
      },
      wait: async () => { await app.workflow.reject((await app.workflow.listPending())[0]!.preview.id); },
      onState: () => undefined
    });

    assert.deepEqual(final, { phase: "rejected" });
    assert.deepEqual(executed, []);
  });

  it("gets the result at once when the user turned off asking before reads", async () => {
    const { run, tick, inspect } = await setUp({ askBeforeWebReads: () => false });
    await tick(["filesystem_inspect_workspace"]);
    const answer = await run(inspect);
    assert.equal(answer.kind, "result");
    assert.match(answer.kind === "result" ? answer.text : "", /Private notes/u);
  });
});

describe("reply", () => {
  it("turns an outcome into something a page can read", async () => {
    assert.deepEqual(await reply(async () => 3), { ok: true, value: 3 });
    assert.deepEqual(await reply(async () => { throw new Error("no"); }), { ok: false, error: "no" });
  });

  it("refuses messages it does not know", async () => {
    const { worker } = await setUp();
    for (const message of [null, "run", { type: "call-tool", name: "x" }, { tabId: 1 }]) {
      assert.deepEqual(await reply(() => worker.handle(message)), { ok: false, error: "This message could not be read." });
    }
    await assert.rejects(worker.handle({ type: "run", chatId: "chat-a", text: "{}" }), /names no tab/u);
  });
});

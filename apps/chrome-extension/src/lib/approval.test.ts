import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  actionFor,
  advance,
  describe as describeState,
  follow,
  INITIAL_STATE,
  isFinished,
  MAX_POLL_FAILURES,
  MAX_POLLS,
  outcomeText,
  POLL_INTERVAL_MS,
  type RunEvent,
  type RunState
} from "./approval.ts";
import type { ToolAnswer } from "./result.ts";

const previewId = "6b2c8f2e-1f1e-4c47-9b1a-6f1d2f3e4a5b";
const preview: ToolAnswer = { kind: "preview", previewId, executeTool: "web_run_approved_read", summary: "Read the workspace" };
const result = (text: string, isError = false): ToolAnswer => ({ kind: "result", text, isError });
const waiting: RunState = { phase: "waiting", previewId, summary: "Read the workspace", polls: 0, failures: 0 };

function run(state: RunState, ...events: RunEvent[]): RunState {
  return events.reduce(advance, state);
}

describe("the approval state machine", () => {
  it("finishes at once when the tool answers with a result", () => {
    const state = advance(INITIAL_STATE, { type: "answer", answer: result("3 files") });
    assert.deepEqual(state, { phase: "done", text: "3 files", isError: false });
    assert.equal(actionFor(state), null);
    assert.equal(isFinished(state), true);
  });

  it("waits and polls when the answer is a preview", () => {
    const state = advance(INITIAL_STATE, { type: "answer", answer: preview });
    assert.deepEqual(state, waiting);
    assert.deepEqual(actionFor(state), { kind: "poll", previewId, afterMs: POLL_INTERVAL_MS });
    assert.equal(describeState(state), "Waiting for your approval in MCP Connector");
    assert.equal(isFinished(state), false);
  });

  it("keeps polling while the preview waits, then runs it once it is approved", () => {
    const stillWaiting = run(waiting, { type: "status", status: "PREVIEWED" }, { type: "status", status: "PREVIEWED" });
    assert.deepEqual(stillWaiting, { ...waiting, polls: 2 });

    const approved = advance(stillWaiting, { type: "status", status: "APPROVED" });
    assert.deepEqual(approved, { phase: "executing", previewId, summary: "Read the workspace" });
    assert.deepEqual(actionFor(approved), { kind: "execute", previewId });

    assert.deepEqual(advance(approved, { type: "answer", answer: result("# Notes") }), { phase: "done", text: "# Notes", isError: false });
  });

  it("says so when the user rejects, and never runs anything", () => {
    const rejected = advance(waiting, { type: "status", status: "REJECTED" });
    assert.deepEqual(rejected, { phase: "rejected" });
    assert.equal(actionFor(rejected), null);
    assert.match(describeState(rejected), /rejected this request in MCP Connector/u);
    // Final: a late approval changes nothing.
    assert.deepEqual(advance(rejected, { type: "status", status: "APPROVED" }), rejected);
  });

  it("says so when the request failed or was run somewhere else", () => {
    assert.deepEqual(advance(waiting, { type: "status", status: "FAILED" }),
      { phase: "failed", message: "MCP Connector marked this request as failed." });
    for (const status of ["EXECUTING", "EXECUTED"]) {
      const state = advance(waiting, { type: "status", status });
      assert.equal(state.phase, "failed");
      assert.equal(actionFor(state), null);
    }
    assert.equal(advance(waiting, { type: "status", status: "SOMETHING_NEW" }).phase, "failed");
  });

  it("reports a tool's error after approval as the outcome", () => {
    const executing: RunState = { phase: "executing", previewId, summary: "" };
    assert.deepEqual(advance(executing, { type: "answer", answer: result("disk full", true) }),
      { phase: "done", text: "disk full", isError: true });
    assert.deepEqual(advance(executing, { type: "error", message: "MCP Connector is not running." }),
      { phase: "failed", message: "MCP Connector is not running." });
    // An approved preview must run, not ask again.
    assert.equal(advance(executing, { type: "answer", answer: preview }).phase, "failed");
  });

  it("fails when the first call fails", () => {
    assert.deepEqual(advance(INITIAL_STATE, { type: "error", message: '"x" is not ticked for this chat.' }),
      { phase: "failed", message: '"x" is not ticked for this chat.' });
  });

  it("survives a few failed status checks, but not many in a row", () => {
    const error: RunEvent = { type: "error", message: "MCP Connector is not running." };
    const shaken = run(waiting, error, error);
    assert.equal(shaken.phase, "waiting");
    // One good answer forgives the earlier failures.
    const recovered = run(shaken, { type: "status", status: "PREVIEWED" }, error, error);
    assert.equal(recovered.phase, "waiting");

    const failed = run(waiting, ...Array.from({ length: MAX_POLL_FAILURES }, () => error));
    assert.deepEqual(failed, { phase: "failed", message: "MCP Connector stopped answering: MCP Connector is not running." });
  });

  it("stops polling after ten minutes and waits for the user to say keep waiting", () => {
    const paused = run(waiting, ...Array.from({ length: MAX_POLLS }, (): RunEvent => ({ type: "status", status: "PREVIEWED" })));
    assert.deepEqual(paused, { phase: "paused", previewId, summary: "Read the workspace" });
    assert.equal(actionFor(paused), null);
    assert.equal(isFinished(paused), false);
    // Nothing but the user's choice moves it on.
    assert.deepEqual(advance(paused, { type: "status", status: "APPROVED" }), paused);
    assert.deepEqual(advance(paused, { type: "keep-waiting" }), waiting);
  });
});

describe("outcomeText", () => {
  it("gives the chat the result, an error, a rejection or a failure, and nothing while waiting", () => {
    assert.equal(outcomeText({ phase: "done", text: "3 files", isError: false }), "3 files");
    assert.equal(outcomeText({ phase: "done", text: "disk full", isError: true }), "The tool reported an error:\ndisk full");
    assert.match(outcomeText({ phase: "rejected" })!, /rejected this request in MCP Connector\. Nothing ran/u);
    assert.match(outcomeText({ phase: "failed", message: "MCP Connector is not running." })!, /did not run to the end: MCP Connector is not running\./u);
    assert.equal(outcomeText(waiting), null);
    assert.equal(outcomeText(INITIAL_STATE), null);
  });
});

describe("follow", () => {
  function steps(statuses: Array<string | Error>, executed: ToolAnswer | Error = result("# Notes")) {
    const seen: string[] = [];
    const waits: number[] = [];
    const calls: string[] = [];
    return {
      seen,
      waits,
      calls,
      steps: {
        wait: async (ms: number) => { waits.push(ms); },
        status: async (id: string) => {
          calls.push(`status ${id}`);
          const next = statuses.shift();
          if (next === undefined) throw new Error("No more statuses.");
          if (next instanceof Error) throw next;
          return next;
        },
        execute: async (id: string) => {
          calls.push(`execute ${id}`);
          if (executed instanceof Error) throw executed;
          return executed;
        },
        onState: (state: RunState) => { seen.push(state.phase); }
      }
    };
  }

  it("polls until approved, then runs the preview exactly once", async () => {
    const { steps: s, seen, waits, calls } = steps(["PREVIEWED", "PREVIEWED", "APPROVED"]);
    const final = await follow(waiting, s);

    assert.deepEqual(final, { phase: "done", text: "# Notes", isError: false });
    assert.deepEqual(seen, ["waiting", "waiting", "waiting", "executing", "done"]);
    assert.deepEqual(calls, [`status ${previewId}`, `status ${previewId}`, `status ${previewId}`, `execute ${previewId}`]);
    // It waits before every status check, and not before running.
    assert.deepEqual(waits, [POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it("stops without running anything when the user rejects", async () => {
    const { steps: s, calls } = steps(["PREVIEWED", "REJECTED"]);
    assert.deepEqual(await follow(waiting, s), { phase: "rejected" });
    assert.equal(calls.some((call) => call.startsWith("execute")), false);
  });

  it("carries on over a failed status check", async () => {
    const { steps: s } = steps([new Error("fetch failed"), "APPROVED"]);
    assert.equal((await follow(waiting, s)).phase, "done");
  });

  it("does nothing for a request that already has its result", async () => {
    const { steps: s, calls, seen } = steps([]);
    const done: RunState = { phase: "done", text: "3 files", isError: false };
    assert.deepEqual(await follow(done, s), done);
    assert.deepEqual(calls, []);
    assert.deepEqual(seen, ["done"]);
  });
});

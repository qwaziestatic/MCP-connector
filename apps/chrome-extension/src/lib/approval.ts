// What happens to one request after the user clicks Run, as a state machine.
// If MCP Connector answers with a preview, the request waits for the user's
// approval in the app: the status is polled, and once it is APPROVED the tool
// MCP Connector named is run. The chat's AI never does these steps.
import type { ToolAnswer } from "./result.ts";

export const POLL_INTERVAL_MS = 2_000;
/** Ten minutes of polling; then the panel asks whether to keep waiting. */
export const MAX_POLLS = 300;
/** Status checks that may fail in a row, for example while the app restarts. */
export const MAX_POLL_FAILURES = 3;

interface Waiting {
  readonly previewId: string;
  readonly summary: string;
}

export type RunState =
  | { readonly phase: "calling" }
  | (Waiting & { readonly phase: "waiting"; readonly polls: number; readonly failures: number })
  /** Polling stopped after MAX_POLLS; the request still waits in the app. */
  | (Waiting & { readonly phase: "paused" })
  | (Waiting & { readonly phase: "executing" })
  | { readonly phase: "done"; readonly text: string; readonly isError: boolean }
  | { readonly phase: "rejected" }
  | { readonly phase: "failed"; readonly message: string };

export type RunEvent =
  /** What the tool call, or the run of an approved preview, answered. */
  | { readonly type: "answer"; readonly answer: ToolAnswer }
  /** What workflow_preview_status said. */
  | { readonly type: "status"; readonly status: string }
  /** A call that failed, with its message. */
  | { readonly type: "error"; readonly message: string }
  /** The user chose to keep waiting after polling stopped. */
  | { readonly type: "keep-waiting" };

export type RunAction =
  | { readonly kind: "poll"; readonly previewId: string; readonly afterMs: number }
  | { readonly kind: "execute"; readonly previewId: string };

export const INITIAL_STATE: RunState = { phase: "calling" };

export function isFinished(state: RunState): boolean {
  return state.phase === "done" || state.phase === "rejected" || state.phase === "failed";
}

export function advance(state: RunState, event: RunEvent): RunState {
  switch (state.phase) {
    case "calling":
      if (event.type === "error") return { phase: "failed", message: event.message };
      if (event.type !== "answer") return state;
      return event.answer.kind === "preview"
        ? { phase: "waiting", previewId: event.answer.previewId, summary: event.answer.summary, polls: 0, failures: 0 }
        : { phase: "done", text: event.answer.text, isError: event.answer.isError };

    case "waiting": {
      const waiting = { previewId: state.previewId, summary: state.summary };
      if (event.type === "error") {
        const failures = state.failures + 1;
        return failures >= MAX_POLL_FAILURES
          ? { phase: "failed", message: `MCP Connector stopped answering: ${event.message}` }
          : { ...state, failures };
      }
      if (event.type !== "status") return state;
      switch (event.status) {
        case "PREVIEWED": {
          const polls = state.polls + 1;
          return polls >= MAX_POLLS ? { phase: "paused", ...waiting } : { ...state, polls, failures: 0 };
        }
        case "APPROVED":
          return { phase: "executing", ...waiting };
        case "REJECTED":
          return { phase: "rejected" };
        case "FAILED":
          return { phase: "failed", message: "MCP Connector marked this request as failed." };
        case "EXECUTING":
        case "EXECUTED":
          return { phase: "failed", message: "This request was already run somewhere else, so its result is not available here." };
        default:
          return { phase: "failed", message: `MCP Connector reported a status this extension does not know: ${event.status.slice(0, 40)}.` };
      }
    }

    case "paused":
      return event.type === "keep-waiting"
        ? { phase: "waiting", previewId: state.previewId, summary: state.summary, polls: 0, failures: 0 }
        : state;

    case "executing":
      if (event.type === "error") return { phase: "failed", message: event.message };
      if (event.type !== "answer") return state;
      return event.answer.kind === "result"
        ? { phase: "done", text: event.answer.text, isError: event.answer.isError }
        : { phase: "failed", message: "MCP Connector asked for approval again instead of running the approved request." };

    default:
      // Done, rejected and failed are final.
      return state;
  }
}

/** What to do next in this state, or null when there is nothing to do. */
export function actionFor(state: RunState): RunAction | null {
  if (state.phase === "waiting") return { kind: "poll", previewId: state.previewId, afterMs: POLL_INTERVAL_MS };
  if (state.phase === "executing") return { kind: "execute", previewId: state.previewId };
  return null;
}

/** One line for the panel. */
export function describe(state: RunState): string {
  switch (state.phase) {
    case "calling": return "Asking MCP Connector…";
    case "waiting": return "Waiting for your approval in MCP Connector";
    case "paused": return "Still waiting for your approval in MCP Connector. Checking has stopped.";
    case "executing": return "Approved. Running it now…";
    case "done": return state.isError ? "The tool reported an error." : "Done.";
    case "rejected": return "You rejected this request in MCP Connector. Nothing ran.";
    case "failed": return `Failed: ${state.message}`;
  }
}

/**
 * What to tell the chat about a finished request, or null while it is not
 * finished. A rejection is told too, so the chat's AI does not ask again.
 */
export function outcomeText(state: RunState): string | null {
  switch (state.phase) {
    case "done": return state.isError ? `The tool reported an error:\n${state.text}` : state.text;
    case "rejected": return "The user rejected this request in MCP Connector. Nothing ran. Do not ask for it again unless the user says so.";
    case "failed": return `The request did not run to the end: ${state.message}`;
    default: return null;
  }
}

export interface RunSteps {
  /** Checks the status of a preview with workflow_preview_status. */
  readonly status: (previewId: string) => Promise<string>;
  /** Runs an approved preview with the tool MCP Connector named for it. */
  readonly execute: (previewId: string) => Promise<ToolAnswer>;
  readonly wait: (ms: number) => Promise<void>;
  readonly onState: (state: RunState) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Follows a request from `state` until it is finished or paused, reporting
 * every state on the way. Start it with the state after the first answer, and
 * again after "keep-waiting".
 */
export async function follow(state: RunState, steps: RunSteps): Promise<RunState> {
  let current = state;
  steps.onState(current);
  for (let action = actionFor(current); action !== null; action = actionFor(current)) {
    let event: RunEvent;
    try {
      if (action.kind === "poll") {
        await steps.wait(action.afterMs);
        event = { type: "status", status: await steps.status(action.previewId) };
      } else {
        event = { type: "answer", answer: await steps.execute(action.previewId) };
      }
    } catch (error) {
      event = { type: "error", message: messageOf(error) };
    }
    current = advance(current, event);
    steps.onState(current);
  }
  return current;
}

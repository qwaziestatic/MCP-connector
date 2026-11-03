// Decides when to tell the user that an AI agent is waiting for approval.
// Agent requests otherwise sit in the queue unnoticed while the window is in
// the background, and the agent waits.
import type { WorkflowPreview, WorkflowPreviewState } from "@mcp-connector/core";

/**
 * Returns a listener for WorkflowService.subscribe() that calls `notify` once
 * for each new agent request. Requests already pending at startup are not
 * announced again.
 */
export function createApprovalNotifier(
  initial: readonly WorkflowPreviewState[],
  notify: (preview: WorkflowPreview) => void
): (states: readonly WorkflowPreviewState[]) => void {
  let seen = new Set(initial.map((state) => state.preview.id));
  return (states) => {
    for (const state of states) {
      if (seen.has(state.preview.id)) continue;
      if (state.preview.source === "mcp" && state.status === "PREVIEWED") {
        notify(state.preview);
      }
    }
    // Previews that left the queue never come back, so only the current ones matter.
    seen = new Set(states.map((state) => state.preview.id));
  };
}

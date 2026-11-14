// Decides when to tell the user that an AI agent or a web chat is waiting for
// approval. Their requests otherwise sit in the queue unnoticed while the
// window is in the background, and they wait.
import type { WorkflowPreview, WorkflowPreviewState } from "@mcp-connector/core";

/**
 * Returns a listener for WorkflowService.subscribe() that calls `notify` once
 * for each new request from an agent or a web chat. Requests the user made in
 * the app, and requests already pending at startup, are not announced.
 */
export function createApprovalNotifier(
  initial: readonly WorkflowPreviewState[],
  notify: (preview: WorkflowPreview) => void
): (states: readonly WorkflowPreviewState[]) => void {
  let seen = new Set(initial.map((state) => state.preview.id));
  return (states) => {
    for (const state of states) {
      if (seen.has(state.preview.id)) continue;
      if (state.preview.source !== "ui" && state.status === "PREVIEWED") {
        notify(state.preview);
      }
    }
    // Previews that left the queue never come back, so only the current ones matter.
    seen = new Set(states.map((state) => state.preview.id));
  };
}

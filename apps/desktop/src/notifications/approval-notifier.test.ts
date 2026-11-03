import type { WorkflowPreview, WorkflowPreviewState } from "@mcp-connector/core";
import { describe, expect, it } from "vitest";
import { createApprovalNotifier } from "./approval-notifier";

function state(id: string, source: "ui" | "mcp", status: WorkflowPreviewState["status"] = "PREVIEWED"): WorkflowPreviewState {
  return {
    status,
    preview: {
      id,
      action: "CREATE",
      target: "Notion project page",
      summary: `Create page ${id}`,
      payload: {},
      requiresApproval: true,
      source,
      createdAt: "2026-11-03T12:00:00.000Z"
    }
  };
}

describe("createApprovalNotifier", () => {
  it("announces each new agent request once", () => {
    const announced: WorkflowPreview[] = [];
    const listener = createApprovalNotifier([], (preview) => announced.push(preview));

    listener([state("a", "mcp")]);
    listener([state("a", "mcp"), state("b", "mcp")]);
    listener([state("a", "mcp", "APPROVED"), state("b", "mcp")]);

    expect(announced.map((preview) => preview.id)).toEqual(["a", "b"]);
  });

  it("ignores requests the user made in the app", () => {
    const announced: WorkflowPreview[] = [];
    createApprovalNotifier([], (preview) => announced.push(preview))([state("ui-1", "ui")]);
    expect(announced).toEqual([]);
  });

  it("does not announce requests that were already waiting at startup", () => {
    const announced: WorkflowPreview[] = [];
    const listener = createApprovalNotifier([state("old", "mcp")], (preview) => announced.push(preview));

    listener([state("old", "mcp"), state("new", "mcp")]);

    expect(announced.map((preview) => preview.id)).toEqual(["new"]);
  });
});

import { describe, expect, it } from "vitest";
import { startMcpHttpServer } from "./http.js";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";

describe("MCP HTTP transport", () => {
  it("requires the bearer token and closes its loopback listener", async () => {
    const handle = await startMcpHttpServer(
      {
        filesystem: new FilesystemService(),
        workflow: new WorkflowService(new InMemoryAuditRepository())
      },
      { bearerToken: "test-token" }
    );

    try {
      const unauthorized = await fetch(handle.url, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" }
      });
      expect(unauthorized.status).toBe(401);

      const notFound = await fetch(handle.url.replace("/mcp", "/other"), {
        method: "POST",
        headers: { authorization: "Bearer test-token" }
      });
      expect(notFound.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it("accepts the browser key next to the agents' token, and labels what it asks for as web", async () => {
    let browserKey: string | null = null;
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const handle = await startMcpHttpServer(
      { filesystem: new FilesystemService(), workflow },
      { bearerToken: "agent-token", browserKey: () => browserKey }
    );
    const call = async (key: string, name: string) => {
      const response = await fetch(handle.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } })
      });
      return { status: response.status, body: await response.text() };
    };

    try {
      // Turned off: no browser key is accepted, not even an empty one.
      expect((await call("browser-key-1", "workspace_get_selected")).status).toBe(401);
      expect((await call("", "workspace_get_selected")).status).toBe(401);
      browserKey = "";
      expect((await call("", "workspace_get_selected")).status).toBe(401);

      // Turned on: the web chat's read waits for approval; the agent's runs at once.
      browserKey = "browser-key-1";
      const asked = await call("browser-key-1", "workspace_get_selected");
      expect(asked.status).toBe(200);
      expect(asked.body).toContain("requiresApproval");
      expect(asked.body).not.toContain("No workspace is selected");
      expect((await workflow.listPending()).map((item) => item.preview.source)).toEqual(["web"]);
      expect((await call("agent-token", "workspace_get_selected")).body).toContain("No workspace is selected");

      // Replaced: the old browser key stops working, and the agents' token is untouched.
      browserKey = "browser-key-2";
      expect((await call("browser-key-1", "workspace_get_selected")).status).toBe(401);
      expect((await call("browser-key-2", "workspace_get_selected")).status).toBe(200);
      expect((await call("agent-token", "workspace_get_selected")).status).toBe(200);

      // Turned off again while the server runs.
      browserKey = null;
      expect((await call("browser-key-2", "workspace_get_selected")).status).toBe(401);
      expect((await call("agent-token", "workspace_get_selected")).status).toBe(200);
      expect(await workflow.listPending()).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });
});

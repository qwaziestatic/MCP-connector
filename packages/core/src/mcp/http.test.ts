import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("reading a file over HTTP", () => {
  it("gives the browser key a preview and no file content until the user approves", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-http-read-"));
    await writeFile(join(workspace, "notes.md"), "line one\nthe launch code is 4471\nline three\n");
    const filesystem = new FilesystemService();
    filesystem.setAllowedWorkspaceRoot(workspace);
    const workflow = new WorkflowService(new InMemoryAuditRepository());
    const handle = await startMcpHttpServer({ filesystem, workflow }, { bearerToken: "agent-token", browserKey: () => "browser-key" });
    const call = async (key: string, name: string, args: Record<string, unknown>) => {
      const response = await fetch(handle.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      });
      return response.text();
    };

    try {
      const asked = await call("browser-key", "filesystem_read_file", { path: "notes.md", startLine: 2, maxLines: 1 });
      expect(asked).toContain("requiresApproval");
      expect(asked).not.toContain("launch code");
      expect(asked).not.toContain("line one");
      const [pending] = await workflow.listPending();
      expect(pending?.preview).toMatchObject({
        action: "READ",
        source: "web",
        summary: "Read the file notes.md, lines 2 to 2",
        payload: { file: "notes.md", lines: "2 to 2" }
      });

      // Still nothing before approval, and only the approved lines after it.
      expect(await call("browser-key", "web_run_approved_read", { previewId: pending!.preview.id })).not.toContain("launch code");
      await workflow.approve(pending!.preview.id);
      const read = await call("browser-key", "web_run_approved_read", { previewId: pending!.preview.id });
      expect(read).toContain("the launch code is 4471");
      expect(read).not.toContain("line one");
      expect(read).toContain('\\"totalLines\\": 3');
      expect(read).toContain('\\"hasMore\\": true');

      // The agents' token reads at once, as before.
      expect(await call("agent-token", "filesystem_read_file", { path: "notes.md" })).toContain("launch code");
    } finally {
      await handle.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

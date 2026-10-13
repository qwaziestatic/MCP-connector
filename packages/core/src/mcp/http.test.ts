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
});

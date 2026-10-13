import { FilesystemService } from "../filesystem/filesystem.service.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import { startMcpHttpServer } from "./http.js";

async function main(): Promise<void> {
  const handle = await startMcpHttpServer({
    filesystem: new FilesystemService(),
    workflow: new WorkflowService(new InMemoryAuditRepository())
  });
  process.stdout.write(`${JSON.stringify({ url: handle.url, bearerToken: handle.bearerToken })}\n`);
}

void main().catch((error: unknown) => {
  console.error("MCP HTTP server failed to start.", error);
  process.exitCode = 1;
});

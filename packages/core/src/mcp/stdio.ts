import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";

async function main(): Promise<void> {
  const workflow = new WorkflowService(new InMemoryAuditRepository());
  const server = createMcpServer({
    filesystem: new FilesystemService(),
    workflow
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error("MCP stdio server failed to start.", error);
  process.exitCode = 1;
});

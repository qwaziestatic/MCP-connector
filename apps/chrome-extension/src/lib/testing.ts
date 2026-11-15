// For the tests only: MCP Connector's real HTTP server, as the desktop app
// runs it, and in-memory stores in place of chrome.storage.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilesystemService,
  InMemoryAuditRepository,
  startMcpHttpServer,
  WorkflowService
} from "@mcp-connector/core";
import type { KeyValueStore } from "./worker.ts";

export const BROWSER_KEY = "browser-key-0123456789-abcdefghij";
export const AGENT_TOKEN = "agent-token-0123456789-abcdefghij";

export async function startApp(options: { askBeforeWebReads?: () => boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-chrome-"));
  await writeFile(join(workspace, "README.md"), "# Private notes");
  const filesystem = new FilesystemService();
  filesystem.setAllowedWorkspaceRoot(workspace);
  const workflow = new WorkflowService(new InMemoryAuditRepository());
  let browserKey: string | null = BROWSER_KEY;
  const server = await startMcpHttpServer(
    {
      filesystem,
      workflow,
      ...(options.askBeforeWebReads === undefined ? {} : { askBeforeWebReads: options.askBeforeWebReads })
    },
    { bearerToken: AGENT_TOKEN, browserKey: () => browserKey }
  );
  let closed = false;
  return {
    port: Number(new URL(server.url).port),
    workflow,
    setBrowserKey: (key: string | null) => { browserKey = key; },
    /** Safe to call twice: a test may stop the app itself. */
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      await rm(workspace, { recursive: true, force: true });
    }
  };
}

export function memoryStore(): KeyValueStore & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    remove: async (key) => { values.delete(key); }
  };
}

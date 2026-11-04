import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemService, InMemoryAuditRepository, WorkflowService } from "@mcp-connector/core";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSecretName, LocalSecretStore } from "../security/credential-vault";
import { AppSettingsStore } from "../settings/app-settings";
import { AgentConnectionManager } from "./connection-manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class MemorySecrets implements LocalSecretStore {
  readonly values = new Map<LocalSecretName, string>();
  async getSecret(name: LocalSecretName) { return this.values.get(name) ?? null; }
  async saveSecret(name: LocalSecretName, value: string) { this.values.set(name, value); }
}

async function setup(options: { secrets?: MemorySecrets; directory?: string; mcpPort?: number } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "mcp-connection-"));
  if (options.directory === undefined) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const settings = new AppSettingsStore(join(directory, "settings.json"));
  // Port 0 picks a free port, so tests never collide with a running app.
  if (options.directory === undefined) await settings.update({ mcpPort: options.mcpPort ?? 0, vscodePort: 0 });
  const secrets = options.secrets ?? new MemorySecrets();
  const endpointFilePath = join(directory, "mcp-endpoint.json");
  const manager = new AgentConnectionManager({
    settings,
    secrets,
    endpointFilePath,
    getMcpDependencies: () => ({
      filesystem: new FilesystemService(),
      workflow: new WorkflowService(new InMemoryAuditRepository())
    })
  });
  cleanups.push(() => manager.closeAll());
  return { directory, settings, secrets, manager, endpointFilePath };
}

async function post(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    })
  });
  await response.body?.cancel();
  return response.status;
}

describe("AgentConnectionManager", () => {
  it("keeps the same token across restarts of the app", async () => {
    const first = await setup();
    const started = await first.manager.startMcp();
    await first.manager.closeAll();

    const second = await setup({ directory: first.directory, secrets: first.secrets });
    const restarted = await second.manager.startMcp();

    expect(restarted.bearerToken).toBe(started.bearerToken);
    expect(restarted.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await post(restarted.url!, restarted.bearerToken)).toBe(200);
  });

  it("shows the default address before the server starts", async () => {
    const { manager, settings } = await setup();
    await settings.update({ mcpPort: undefined });

    expect((await manager.getMcpStatus()).url).toBe("http://127.0.0.1:47820/mcp");
  });

  it("restarts the server on launch only if it was running when the app closed", async () => {
    const first = await setup();
    expect(await first.manager.restoreOnLaunch()).toEqual([]);
    expect((await first.manager.getMcpStatus()).enabled).toBe(false);

    await first.manager.startMcp();
    await first.manager.closeAll();
    const second = await setup({ directory: first.directory, secrets: first.secrets });
    expect(await second.manager.restoreOnLaunch()).toEqual([]);
    expect((await second.manager.getMcpStatus()).enabled).toBe(true);

    await second.manager.stopMcp();
    const third = await setup({ directory: first.directory, secrets: first.secrets });
    await third.manager.restoreOnLaunch();
    expect((await third.manager.getMcpStatus()).enabled).toBe(false);
  });

  it("writes the address for --mcp-stdio while running, without the token", async () => {
    const { manager, endpointFilePath } = await setup();
    const status = await manager.startMcp();
    const file = await readFile(endpointFilePath, "utf8");

    expect(JSON.parse(file)).toEqual({ url: status.url });
    expect(file).not.toContain(status.bearerToken);
    await manager.stopMcp();
    await expect(readFile(endpointFilePath, "utf8")).rejects.toThrow();
  });

  it("leaves another copy's address in place when it closes", async () => {
    const { manager, endpointFilePath, directory, secrets } = await setup();
    const other = await setup({ directory, secrets });
    const running = await manager.startMcp();

    // A second copy that never started its own server quits.
    await other.manager.closeAll();
    expect(JSON.parse(await readFile(endpointFilePath, "utf8"))).toEqual({ url: running.url });

    // A second copy that started a server on another port and quit after the
    // first copy rewrote the file must not remove the first copy's address.
    const second = await other.manager.startMcp();
    await manager.stopMcp();
    await manager.startMcp();
    const current = await manager.getMcpStatus();
    await other.manager.closeAll();
    expect(second.url).not.toBe(current.url);
    expect(JSON.parse(await readFile(endpointFilePath, "utf8"))).toEqual({ url: current.url });
  });

  it("rejects the old token after a new one is generated", async () => {
    const { manager } = await setup();
    const before = await manager.startMcp();
    const after = await manager.regenerateMcpToken();

    expect(after.bearerToken).not.toBe(before.bearerToken);
    expect(after.enabled).toBe(true);
    expect(await post(after.url!, before.bearerToken)).toBe(401);
    expect(await post(after.url!, after.bearerToken)).toBe(200);
  });

  it("explains a busy port instead of failing with EADDRINUSE", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const port = (blocker.address() as { port: number }).port;
    const { manager } = await setup({ mcpPort: port });

    await expect(manager.startMcp()).rejects.toThrow(`port ${port} is already in use`);
    expect(await manager.restoreOnLaunch({ mcp: true }))
      .toEqual([expect.stringContaining(`"mcpPort" to a free port`)]);
  });

  it("keeps the VS Code listener token across restarts", async () => {
    const first = await setup();
    const started = await first.manager.startVsCode();
    await first.manager.closeAll();
    const second = await setup({ directory: first.directory, secrets: first.secrets });
    await second.manager.restoreOnLaunch();
    const restored = await second.manager.getVsCodeStatus();

    expect(restored.enabled).toBe(true);
    expect(restored.bearerToken).toBe(started.bearerToken);
  });
});

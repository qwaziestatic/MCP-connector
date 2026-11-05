import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalServers, type ExternalServerSecrets } from "@mcp-connector/core";
import type { LocalSecretName } from "../security/credential-vault";
import { AppSettingsStore } from "../settings/app-settings";
import { ExternalServerStore } from "./external-server-store";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const setup = JSON.stringify({
  mcpServers: {
    "My Notes": { command: "npx", args: ["-y", "notes-server", "C:\\My Notes"], env: { NOTES_TOKEN: "secret-value" } },
    web: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer web-token" } }
  }
});

async function setUp(directory?: string) {
  const folder = directory ?? await mkdtemp(join(tmpdir(), "mcp-external-"));
  if (directory === undefined) cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const secrets = new Map<string, string>();
  const vault = {
    getSecret: async (name: LocalSecretName) => secrets.get(name) ?? null,
    saveSecret: async (name: LocalSecretName, value: string) => { secrets.set(name, value); },
    removeSecret: async (name: LocalSecretName) => { secrets.delete(name); }
  };
  const started: { id: string; secrets: ExternalServerSecrets }[] = [];
  const servers = new ExternalServers({
    createTransport: (config, serverSecrets) => {
      started.push({ id: config.id, secrets: serverSecrets });
      const downstream = new McpServer({ name: config.id, version: "1" });
      downstream.registerTool("read", { description: "Read.", annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
      downstream.registerTool("write", { description: "Write." }, async () => ({ content: [] }));
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void downstream.connect(serverSide);
      return { transport: clientSide };
    }
  });
  cleanups.push(() => servers.close());
  const settingsPath = join(folder, "settings.json");
  const store = new ExternalServerStore({ settings: new AppSettingsStore(settingsPath), vault, servers });
  return { store, secrets, started, settingsPath, folder, vault };
}

async function connected(store: ExternalServerStore) {
  for (let attempt = 0; attempt < 100 && store.list().some((item) => item.status === "connecting"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.list();
}

describe("ExternalServerStore", () => {
  it("adds pasted servers, keeping their secrets out of settings.json", async () => {
    const { store, secrets, settingsPath } = await setUp();
    await store.add(setup, "changes");
    const items = await connected(store);

    expect(items.map((item) => [item.id, item.address, item.status, item.secretNames])).toEqual([
      ["my-notes", 'npx -y notes-server "C:\\My Notes"', "connected", ["NOTES_TOKEN"]],
      ["web", "https://mcp.example.com/mcp", "connected", ["Authorization"]]
    ]);
    expect(items[0]?.tools).toEqual([{ name: "read", asksForApproval: false }, { name: "write", asksForApproval: true }]);
    const file = await readFile(settingsPath, "utf8");
    expect(file).not.toContain("secret-value");
    expect(file).not.toContain("web-token");
    expect(JSON.parse(secrets.get("external-server:my-notes") ?? "{}")).toEqual({ env: { NOTES_TOKEN: "secret-value" }, headers: {} });
  });

  it("connects saved servers again after a restart, with their secrets", async () => {
    const first = await setUp();
    await first.store.add(setup, "all");
    await connected(first.store);

    const second = await setUp(first.folder);
    for (const [name, value] of first.secrets) await second.vault.saveSecret(name as LocalSecretName, value);
    await second.store.start();

    expect((await connected(second.store)).map((item) => [item.id, item.status, item.approval])).toEqual([
      ["my-notes", "connected", "all"],
      ["web", "connected", "all"]
    ]);
    expect(second.started.find((start) => start.id === "web")?.secrets.headers).toEqual({ Authorization: "Bearer web-token" });
  });

  it("changes when to ask, and saves it", async () => {
    const { store, settingsPath } = await setUp();
    await store.add(setup, "changes");
    await connected(store);
    const items = await store.setApproval("web", "all");

    expect(items.find((item) => item.id === "web")?.tools.every((tool) => tool.asksForApproval)).toBe(true);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).externalServers[1].approval).toBe("all");
  });

  it("removes a server with its secrets", async () => {
    const { store, secrets, settingsPath } = await setUp();
    await store.add(setup, "changes");
    await connected(store);
    const items = await store.remove("my-notes");

    expect(items.map((item) => item.id)).toEqual(["web"]);
    expect(secrets.has("external-server:my-notes")).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).externalServers).toHaveLength(1);
  });

  it("names a second server with the same name differently", async () => {
    const { store } = await setUp();
    await store.add('{"mcpServers": {"web": {"url": "https://a.example.com/mcp"}}}', "changes");
    await store.add('{"mcpServers": {"web": {"url": "https://b.example.com/mcp"}}}', "changes");
    expect(store.list().map((item) => item.id)).toEqual(["web", "web-2"]);
  });

  it("refuses bad requests from the window", async () => {
    const { store } = await setUp();
    await expect(store.add(42, "changes")).rejects.toThrow("Paste the server's setup");
    await expect(store.add(setup, "never")).rejects.toThrow("Choose when");
    await expect(store.remove("nope")).rejects.toThrow("no such server");
    expect(() => store.reconnect(null)).toThrow("no such server");
  });
});

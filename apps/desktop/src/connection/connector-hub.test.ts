import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltInConnectors, type ConnectorDefinition } from "@mcp-connector/core";
import type { StoredCredential } from "../security/credential-vault";
import type { SignInFlow } from "../security/sign-in-flow";
import { AppSettingsStore } from "../settings/app-settings";
import { ConnectorHub } from "./connector-hub";
import { ConnectorSettings } from "./connector-settings";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const databaseId = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";

async function setUp(env: NodeJS.ProcessEnv = {}, isSignInAvailable?: (definition: ConnectorDefinition) => boolean) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-connectors-"));
  directories.push(directory);
  const settingsPath = join(directory, "settings.json");
  const stored = new Map<string, StoredCredential>();
  const vault = {
    get: async (provider: string) => stored.get(provider) ?? null,
    save: async (credential: StoredCredential) => { stored.set(credential.provider, credential); },
    has: async (provider: string) => stored.has(provider),
    remove: async (provider: string) => { stored.delete(provider); }
  };
  const started: string[] = [];
  const createSignIn = (definition: ConnectorDefinition): SignInFlow => ({
    start: async () => {
      started.push(definition.id);
      return { kind: "browser" };
    },
    openPage: async () => undefined,
    finish: async () => vault.save({
      provider: definition.id, accessToken: `${definition.id}-token`, refreshToken: null, expiresAt: null, tokenType: "bearer", scope: null
    }),
    cancel: () => undefined
  });
  const hub = new ConnectorHub({
    definitions: createBuiltInConnectors(),
    vault,
    settings: await ConnectorSettings.load(new AppSettingsStore(settingsPath), env),
    createSignIn,
    createRefresh: () => null,
    ...(isSignInAvailable === undefined ? {} : { isSignInAvailable })
  });
  return { hub, settingsPath, started };
}

describe("ConnectorHub", () => {
  it("lists every built-in connector with its sign-in and settings", async () => {
    const { hub } = await setUp();
    const list = await hub.list();

    expect(list.map((connector) => [connector.id, connector.signIn, connector.connected])).toEqual([
      ["github", "github-device-flow", false],
      ["notion", "notion-sign-in-service", false]
    ]);
    expect(list[1]?.settings).toEqual([expect.objectContaining({ key: "databaseId", label: "Database for new pages", value: null, source: null })]);
  });

  it("says which connectors this copy can sign in to", async () => {
    expect((await (await setUp()).hub.list()).map((connector) => connector.signInAvailable)).toEqual([true, true]);

    const { hub } = await setUp({}, (definition) => definition.id !== "notion");
    expect((await hub.list()).map((connector) => [connector.id, connector.signInAvailable])).toEqual([
      ["github", true],
      ["notion", false]
    ]);
  });

  it("signs in and out through the connector's own flow", async () => {
    const { hub, started } = await setUp();
    await hub.startSignIn("notion");
    await hub.finishSignIn("notion");

    expect(started).toEqual(["notion"]);
    expect((await hub.list()).find((connector) => connector.id === "notion")?.connected).toBe(true);
    const notion = hub.connectors.find((connector) => connector.definition.id === "notion");
    await expect(notion?.runtime.tokens.getAccessToken()).resolves.toBe("notion-token");

    await hub.disconnect("notion");
    await expect(notion?.runtime.tokens.getAccessToken()).rejects.toThrow("Notion is not connected");
  });

  it("saves a setting from a pasted link, and tools read it at once", async () => {
    const { hub, settingsPath } = await setUp();
    const notion = hub.connectors.find((connector) => connector.definition.id === "notion");
    expect(() => notion?.runtime.requireSetting("databaseId")).toThrow('Notion needs "Database for new pages". Set it in MCP Connector, under Notion.');

    const view = await hub.setSetting("notion", "databaseId", `https://www.notion.so/team/Plans-${databaseId}?v=abc`);

    expect(view.settings[0]).toMatchObject({ value: databaseId, source: "app" });
    expect(notion?.runtime.requireSetting("databaseId")).toBe(databaseId);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({ connectorSettings: { notion: { databaseId } } });

    await hub.setSetting("notion", "databaseId", "");
    expect(() => notion?.runtime.requireSetting("databaseId")).toThrow("Database for new pages");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).connectorSettings).toEqual({});
  });

  it("keeps a bad setting out and says why", async () => {
    const { hub } = await setUp();
    await expect(hub.setSetting("notion", "databaseId", "my database")).rejects.toThrow("not a Notion database link or ID");
    await expect(hub.setSetting("notion", "colour", "blue")).rejects.toThrow('has no setting called "colour"');
  });

  it("still reads MCP_NOTION_DATABASE_ID, and a value saved in the app wins", async () => {
    const { hub } = await setUp({ MCP_NOTION_DATABASE_ID: databaseId.toUpperCase() });
    expect((await hub.list())[1]?.settings[0]).toMatchObject({ value: databaseId, source: "environment" });

    const other = "ffffffffffffffffffffffffffffffff";
    await hub.setSetting("notion", "databaseId", other);
    expect((await hub.list())[1]?.settings[0]).toMatchObject({ value: other, source: "app" });
  });

  it("refuses connectors it does not have", async () => {
    const { hub } = await setUp();
    for (const id of ["slack", "GITHUB", "../github", 42, null]) {
      await expect(hub.startSignIn(id)).rejects.toThrow("no such connector");
      await expect(hub.disconnect(id)).rejects.toThrow("no such connector");
    }
  });
});

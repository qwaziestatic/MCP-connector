import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettingsStore } from "./app-settings";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-settings-"));
  directories.push(directory);
  const filePath = join(directory, "settings.json");
  return { directory, filePath, store: new AppSettingsStore(filePath) };
}

describe("AppSettingsStore", () => {
  it("returns defaults when no settings file exists", async () => {
    const { store } = await createStore();
    expect(await store.read()).toEqual({});
    expect(await store.readExistingWorkspace()).toBeUndefined();
  });

  it("remembers the selected workspace across instances", async () => {
    const { directory, filePath, store } = await createStore();
    const workspace = join(directory, "project");
    await mkdir(workspace);
    await store.update({ workspacePath: workspace });

    expect(await new AppSettingsStore(filePath).readExistingWorkspace()).toBe(workspace);
  });

  it("forgets a saved workspace that no longer exists", async () => {
    const { directory, store } = await createStore();
    await store.update({ workspacePath: join(directory, "deleted") });

    expect(await store.readExistingWorkspace()).toBeUndefined();
  });

  it("ignores a corrupt or invalid settings file", async () => {
    const { filePath, store } = await createStore();
    await writeFile(filePath, "{ not json");
    expect(await store.read()).toEqual({});
    await writeFile(filePath, JSON.stringify({ workspacePath: 42 }));
    expect(await store.read()).toEqual({});
  });

  it("drops only the invalid setting and keeps the rest", async () => {
    const { filePath, store } = await createStore();
    await writeFile(filePath, JSON.stringify({ workspacePath: "C:\\work", mcpPort: 99_999, mcpServerEnabled: true }));

    expect(await store.read()).toEqual({ workspacePath: "C:\\work", mcpServerEnabled: true });
  });

  it("does not throw when the settings file cannot be read", async () => {
    const { filePath } = await createStore();
    await mkdir(filePath);

    await expect(new AppSettingsStore(filePath).readExistingWorkspace()).resolves.toBeUndefined();
  });

  it("keeps every change when updates overlap", async () => {
    const { directory, store } = await createStore();
    const paths = ["a", "b", "c"].map((name) => join(directory, name));
    await Promise.all(paths.map((workspacePath) => store.update({ workspacePath })));
    expect((await store.read()).workspacePath).toBe(paths[2]);
  });
});

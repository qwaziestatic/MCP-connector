import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyVaultKey } from "./stdio-mode";

vi.mock("electron", () => ({ app: {}, safeStorage: {} }));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ from: string; to: string }> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-connector-relay-"));
  directories.push(directory);
  return { from: join(directory, "app-state"), to: join(directory, "relay-state") };
}

describe("copyVaultKey", () => {
  it("copies only the encryption key", async () => {
    const { from, to } = await workspace();
    await writeFile(from, JSON.stringify({ os_crypt: { encrypted_key: "key" }, other: "private" }));

    expect(copyVaultKey(from, to)).toBe(true);
    expect(JSON.parse(await readFile(to, "utf8"))).toEqual({ os_crypt: { encrypted_key: "key" } });
  });

  it("reports a missing key, and clears a key copied earlier", async () => {
    const { from, to } = await workspace();
    await writeFile(to, JSON.stringify({ os_crypt: { encrypted_key: "old" } }));

    expect(copyVaultKey(from, to)).toBe(false);
    expect(JSON.parse(await readFile(to, "utf8"))).toEqual({});
  });

  it("treats a damaged Local State file as having no key", async () => {
    const { from, to } = await workspace();
    await writeFile(from, "{ not json");

    expect(copyVaultKey(from, to)).toBe(false);
  });
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Electron's safeStorage: "encrypts" by prefixing, and reports
// that a value should be re-encrypted when it was stored under the old key.
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`new:${value}`),
    decryptStringAsync: async (data: Buffer) => {
      const text = data.toString();
      return { result: text.replace(/^(new|old):/u, ""), shouldReEncrypt: text.startsWith("old:") };
    }
  }
}));

const { CredentialVault } = await import("./credential-vault");

let directory: string;
let filePath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-vault-"));
  filePath = join(directory, "credentials.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function storeUnderOldKey(token: string): Promise<void> {
  await writeFile(filePath, JSON.stringify({ "secret:mcp-http-token": Buffer.from(`old:${token}`).toString("base64") }));
}

describe("CredentialVault", () => {
  it("re-encrypts a secret stored under a rotated key", async () => {
    await storeUnderOldKey("abc");
    expect(await new CredentialVault(filePath).getSecret("mcp-http-token")).toBe("abc");

    const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
    expect(Buffer.from(stored["secret:mcp-http-token"]!, "base64").toString()).toBe("new:abc");
  });

  it("reads a secret in read-only mode without rewriting the file", async () => {
    await storeUnderOldKey("abc");
    const before = await stat(filePath);
    const vault = new CredentialVault(filePath, { readOnly: true });

    expect(await vault.getSecret("mcp-http-token")).toBe("abc");
    expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(filePath, "utf8")).toContain(Buffer.from("old:abc").toString("base64"));
  });

  it("refuses every write in read-only mode", async () => {
    const vault = new CredentialVault(filePath, { readOnly: true });

    await expect(vault.saveSecret("mcp-http-token", "x")).rejects.toThrow("read-only");
    await expect(vault.remove("github")).rejects.toThrow("read-only");
    await expect(vault.save({
      provider: "github", accessToken: "t", refreshToken: null, expiresAt: null, tokenType: "bearer", scope: null
    })).rejects.toThrow("read-only");
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });
});

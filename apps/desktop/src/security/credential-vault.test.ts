import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the stand-in reports; each test starts from a working keyring.
const storage = vi.hoisted(() => ({ available: true, backend: "gnome_libsecret" }));

// A stand-in for Electron's safeStorage: "encrypts" by prefixing, and reports
// that a value should be re-encrypted when it was stored under the old key.
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => storage.available,
    getSelectedStorageBackend: () => storage.backend,
    encryptStringAsync: async (value: string) => Buffer.from(`new:${value}`),
    decryptStringAsync: async (data: Buffer) => {
      const text = data.toString();
      return { result: text.replace(/^(new|old):/u, ""), shouldReEncrypt: text.startsWith("old:") };
    }
  }
}));

const { CredentialVault, NO_LINUX_KEYRING_MESSAGE, unprotectedStorageReason } = await import("./credential-vault");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function runAs(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
}

let directory: string;
let filePath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-vault-"));
  filePath = join(directory, "credentials.json");
  storage.available = true;
  storage.backend = "gnome_libsecret";
});
afterEach(async () => {
  Object.defineProperty(process, "platform", realPlatform);
  await rm(directory, { recursive: true, force: true });
});

describe("unprotectedStorageReason", () => {
  it("accepts a Linux keyring", () => {
    for (const linuxBackend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      expect(unprotectedStorageReason({ platform: "linux", encryptionAvailable: true, linuxBackend })).toBeNull();
    }
  });

  it("refuses Linux's basic_text fallback even when encryption reports available", () => {
    expect(unprotectedStorageReason({ platform: "linux", encryptionAvailable: true, linuxBackend: "basic_text" }))
      .toBe(NO_LINUX_KEYRING_MESSAGE);
  });

  it("refuses when encryption is unavailable, and says what to do on Linux", () => {
    expect(unprotectedStorageReason({ platform: "linux", encryptionAvailable: false, linuxBackend: "gnome_libsecret" }))
      .toBe(NO_LINUX_KEYRING_MESSAGE);
    expect(NO_LINUX_KEYRING_MESSAGE).toContain("Install or unlock GNOME Keyring or KWallet, then restart MCP Connector.");
    expect(unprotectedStorageReason({ platform: "win32", encryptionAvailable: false })).toContain("Windows");
  });

  it("accepts Windows whenever encryption is available", () => {
    expect(unprotectedStorageReason({ platform: "win32", encryptionAvailable: true })).toBeNull();
  });
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

  it("on Linux without a keyring, stores and reads nothing", async () => {
    runAs("linux");
    storage.backend = "basic_text";
    const vault = new CredentialVault(filePath);

    await expect(vault.saveSecret("mcp-http-token", "x")).rejects.toThrow(NO_LINUX_KEYRING_MESSAGE);
    await expect(vault.save({
      provider: "github", accessToken: "t", refreshToken: null, expiresAt: null, tokenType: "bearer", scope: null
    })).rejects.toThrow(NO_LINUX_KEYRING_MESSAGE);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();

    await storeUnderOldKey("abc");
    await expect(vault.getSecret("mcp-http-token")).rejects.toThrow(NO_LINUX_KEYRING_MESSAGE);
    await expect(vault.get("github")).rejects.toThrow(NO_LINUX_KEYRING_MESSAGE);
  });

  it("on Linux with a keyring, works as on Windows", async () => {
    runAs("linux");
    const vault = new CredentialVault(filePath);

    await vault.saveSecret("mcp-http-token", "x");
    expect(await vault.getSecret("mcp-http-token")).toBe("x");
  });
});

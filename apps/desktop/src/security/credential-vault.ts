import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isConnectorId } from "@mcp-connector/core";

export interface StoredCredential {
  /** The connector's id, for example "github". */
  readonly provider: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly tokenType: string;
  readonly scope: string | null;
}

type CredentialFile = Record<string, string>;

/** Local secrets the app generates for itself, such as listener tokens. */
export type LocalSecretName =
  | "mcp-http-token"
  | "vscode-listener-token"
  /** An external MCP server's environment variables and headers, as JSON. */
  | `external-server:${string}`;

/** The part of the vault that stores the app's own secrets. */
export interface LocalSecretStore {
  getSecret(name: LocalSecretName): Promise<string | null>;
  saveSecret(name: LocalSecretName, value: string): Promise<void>;
}

export const NO_LINUX_KEYRING_MESSAGE = "MCP Connector needs your system's keyring to keep tokens safe, and none is "
  + "available. Install or unlock GNOME Keyring or KWallet, then restart MCP Connector.";

/**
 * Why secrets cannot be kept safely right now, written for the user, or null
 * when they can. On Linux, safeStorage relies on a keyring (GNOME Keyring
 * through libsecret, or KWallet). Without one it falls back to "basic_text",
 * which encrypts with a key that is the same on every computer, so the vault
 * refuses that rather than pretend the secrets are protected.
 */
export function unprotectedStorageReason(input: {
  readonly platform: NodeJS.Platform;
  readonly encryptionAvailable: boolean;
  /** safeStorage.getSelectedStorageBackend(), which exists only on Linux. */
  readonly linuxBackend?: string;
}): string | null {
  if (input.platform === "linux") {
    return !input.encryptionAvailable || input.linuxBackend === "basic_text" ? NO_LINUX_KEYRING_MESSAGE : null;
  }
  if (input.encryptionAvailable) return null;
  return input.platform === "win32"
    ? "Windows credential encryption is unavailable."
    : "Your system's credential encryption is unavailable.";
}

export class CredentialVault implements LocalSecretStore {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath = join(app.getPath("userData"), "credentials.json"),
    /**
     * A read-only vault never writes the file, not even to re-encrypt under a
     * rotated key. The stdio relay uses one, so it cannot race the app's own
     * writes and lose a credential the app is saving at the same moment.
     */
    private readonly options: { readonly readOnly?: boolean } = {}
  ) {}

  private assertWritable(): void {
    if (this.options.readOnly === true) {
      throw new Error("This credential vault is read-only.");
    }
  }

  private assertConnectorId(provider: string): void {
    if (!isConnectorId(provider)) throw new Error(`"${provider}" is not a connector id.`);
  }

  /** Every encryption and decryption goes through here first; there is no weaker fallback. */
  private async assertProtectedStorage(): Promise<void> {
    const encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
    const reason = unprotectedStorageReason({
      platform: process.platform,
      encryptionAvailable,
      ...(process.platform === "linux" ? { linuxBackend: safeStorage.getSelectedStorageBackend() } : {})
    });
    if (reason !== null) throw new Error(reason);
  }

  async save(credential: StoredCredential): Promise<void> {
    this.assertWritable();
    this.assertConnectorId(credential.provider);
    await this.assertProtectedStorage();

    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credential));
    await this.enqueueWrite(async () => {
      const contents: CredentialFile = await this.readFile();
      contents[credential.provider] = encrypted.toString("base64");
      await this.writeFile(contents);
    });
  }

  async get(provider: StoredCredential["provider"]): Promise<StoredCredential | null> {
    this.assertConnectorId(provider);
    await this.assertProtectedStorage();

    const contents = await this.readFile();
    const encrypted = contents[provider];
    if (encrypted === undefined) return null;

    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
    const parsed: unknown = JSON.parse(decrypted.result);
    if (!this.isCredential(parsed, provider)) {
      throw new Error(`Stored ${provider} credential has an invalid shape.`);
    }
    if (decrypted.shouldReEncrypt && this.options.readOnly !== true) {
      // The OS key was rotated; store the credential under the current key.
      await this.save(parsed);
    }
    return parsed;
  }

  async remove(provider: StoredCredential["provider"]): Promise<void> {
    this.assertWritable();
    this.assertConnectorId(provider);
    await this.enqueueWrite(async () => {
      const contents = await this.readFile();
      delete contents[provider];
      await this.writeFile(contents);
    });
  }

  async has(provider: StoredCredential["provider"]): Promise<boolean> {
    this.assertConnectorId(provider);
    const contents = await this.readFile();
    return contents[provider] !== undefined;
  }

  async getSecret(name: LocalSecretName): Promise<string | null> {
    await this.assertProtectedStorage();
    const encrypted = (await this.readFile())[`secret:${name}`];
    if (encrypted === undefined) return null;
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
    if (decrypted.shouldReEncrypt && this.options.readOnly !== true) {
      await this.saveSecret(name, decrypted.result);
    }
    return decrypted.result;
  }

  async removeSecret(name: LocalSecretName): Promise<void> {
    this.assertWritable();
    await this.enqueueWrite(async () => {
      const contents = await this.readFile();
      delete contents[`secret:${name}`];
      await this.writeFile(contents);
    });
  }

  async saveSecret(name: LocalSecretName, value: string): Promise<void> {
    this.assertWritable();
    await this.assertProtectedStorage();
    const encrypted = await safeStorage.encryptStringAsync(value);
    await this.enqueueWrite(async () => {
      const contents = await this.readFile();
      contents[`secret:${name}`] = encrypted.toString("base64");
      await this.writeFile(contents);
    });
  }

  private async readFile(): Promise<CredentialFile> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Credential vault has an invalid format.");
      }
      return parsed as CredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeFile(contents: CredentialFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(contents), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private isCredential(value: unknown, provider: StoredCredential["provider"]): value is StoredCredential {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Record<string, unknown>;
    return item.provider === provider &&
      typeof item.accessToken === "string" &&
      (item.refreshToken === null || typeof item.refreshToken === "string") &&
      (item.expiresAt === null || typeof item.expiresAt === "string") &&
      typeof item.tokenType === "string" &&
      (item.scope === null || typeof item.scope === "string");
  }
}

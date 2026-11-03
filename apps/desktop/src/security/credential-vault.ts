import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredCredential {
  readonly provider: "github" | "notion";
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly tokenType: string;
  readonly scope: string | null;
}

type CredentialFile = Record<string, string>;

/** Local secrets the app generates for itself, such as listener tokens. */
export type LocalSecretName = "mcp-http-token" | "vscode-listener-token";

/** The part of the vault that stores the app's own secrets. */
export interface LocalSecretStore {
  getSecret(name: LocalSecretName): Promise<string | null>;
  saveSecret(name: LocalSecretName, value: string): Promise<void>;
}

export class CredentialVault implements LocalSecretStore {
  private readonly filePath = join(app.getPath("userData"), "credentials.json");
  private writeQueue: Promise<void> = Promise.resolve();

  async save(credential: StoredCredential): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("Windows credential encryption is unavailable.");
    }

    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credential));
    await this.enqueueWrite(async () => {
      const contents: CredentialFile = await this.readFile();
      contents[credential.provider] = encrypted.toString("base64");
      await this.writeFile(contents);
    });
  }

  async get(provider: StoredCredential["provider"]): Promise<StoredCredential | null> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("Windows credential encryption is unavailable.");
    }

    const contents = await this.readFile();
    const encrypted = contents[provider];
    if (encrypted === undefined) return null;

    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
    const parsed: unknown = JSON.parse(decrypted.result);
    if (!this.isCredential(parsed, provider)) {
      throw new Error(`Stored ${provider} credential has an invalid shape.`);
    }
    if (decrypted.shouldReEncrypt) {
      // The OS key was rotated; store the credential under the current key.
      await this.save(parsed);
    }
    return parsed;
  }

  async remove(provider: StoredCredential["provider"]): Promise<void> {
    await this.enqueueWrite(async () => {
      const contents = await this.readFile();
      delete contents[provider];
      await this.writeFile(contents);
    });
  }

  async has(provider: StoredCredential["provider"]): Promise<boolean> {
    const contents = await this.readFile();
    return contents[provider] !== undefined;
  }

  async getSecret(name: LocalSecretName): Promise<string | null> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("Windows credential encryption is unavailable.");
    }
    const encrypted = (await this.readFile())[`secret:${name}`];
    if (encrypted === undefined) return null;
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
    if (decrypted.shouldReEncrypt) {
      await this.saveSecret(name, decrypted.result);
    }
    return decrypted.result;
  }

  async saveSecret(name: LocalSecretName, value: string): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("Windows credential encryption is unavailable.");
    }
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

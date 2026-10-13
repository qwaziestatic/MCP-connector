import { app, safeStorage } from "electron";
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

export class CredentialVault {
  private readonly filePath = join(app.getPath("userData"), "credentials.json");

  async save(credential: StoredCredential): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows credential encryption is unavailable.");
    }

    const contents: CredentialFile = await this.readFile();
    contents[credential.provider] = safeStorage.encryptString(JSON.stringify(credential)).toString("base64");
    await this.writeFile(contents);
  }

  async get(provider: StoredCredential["provider"]): Promise<StoredCredential | null> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows credential encryption is unavailable.");
    }

    const contents = await this.readFile();
    const encrypted = contents[provider];
    if (encrypted === undefined) return null;

    const parsed: unknown = JSON.parse(
      safeStorage.decryptString(Buffer.from(encrypted, "base64"))
    );
    if (!this.isCredential(parsed, provider)) {
      throw new Error(`Stored ${provider} credential has an invalid shape.`);
    }
    return parsed;
  }

  async remove(provider: StoredCredential["provider"]): Promise<void> {
    const contents = await this.readFile();
    delete contents[provider];
    await this.writeFile(contents);
  }

  async has(provider: StoredCredential["provider"]): Promise<boolean> {
    const contents = await this.readFile();
    return contents[provider] !== undefined;
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
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(contents), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
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

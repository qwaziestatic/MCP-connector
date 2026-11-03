import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// Non-secret settings that should survive a restart. Secrets belong in the
// CredentialVault, never here.
const appSettingsSchema = z.object({
  workspacePath: z.string().min(1).optional()
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export class AppSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  /** Returns the saved settings, or defaults if the file is missing or invalid. */
  async read(): Promise<AppSettings> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      const parsed = appSettingsSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : {};
    } catch {
      // A corrupt settings file must not stop the app from starting.
      return {};
    }
  }

  async update(changes: Partial<AppSettings>): Promise<AppSettings> {
    let updated: AppSettings = {};
    const operation = async (): Promise<void> => {
      updated = appSettingsSchema.parse({ ...await this.read(), ...changes });
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(updated, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    };
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    await next;
    return updated;
  }

  /**
   * The saved workspace, if it is still an existing directory. Never throws:
   * an unreadable settings file must not stop the app from starting.
   */
  async readExistingWorkspace(): Promise<string | undefined> {
    try {
      const { workspacePath } = await this.read();
      if (workspacePath === undefined) return undefined;
      return (await stat(workspacePath)).isDirectory() ? workspacePath : undefined;
    } catch {
      return undefined;
    }
  }
}

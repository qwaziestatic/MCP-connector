import {
  externalServerSecretsSchema,
  parseServerSetup,
  needsApproval,
  type ApprovalMode,
  type ExternalServerConfig,
  type ExternalServers,
  type ExternalServerSecrets
} from "@mcp-connector/core";
import type { LocalSecretName } from "../security/credential-vault";
import type { AppSettings } from "../settings/app-settings";

/** One server as the window shows it. Secrets appear by name only. */
export interface ExternalServerItem {
  readonly id: string;
  readonly name: string;
  /** The command line, or the URL. */
  readonly address: string;
  readonly approval: ApprovalMode;
  /** Names of the environment variables or headers kept in the vault. */
  readonly secretNames: readonly string[];
  readonly status: "connecting" | "connected" | "failed";
  readonly message: string | null;
  readonly tools: readonly { readonly name: string; readonly asksForApproval: boolean }[];
}

interface SettingsFile {
  read(): Promise<AppSettings>;
  update(changes: Partial<AppSettings>): Promise<AppSettings>;
}

interface SecretStore {
  getSecret(name: LocalSecretName): Promise<string | null>;
  saveSecret(name: LocalSecretName, value: string): Promise<void>;
  removeSecret(name: LocalSecretName): Promise<void>;
}

const secretName = (id: string): LocalSecretName => `external-server:${id}`;
const NO_SECRETS: ExternalServerSecrets = { env: {}, headers: {} };

function quote(part: string): string {
  return /^[\w./:=@\\-]+$/.test(part) ? part : `"${part}"`;
}

/**
 * The servers the user added: their setup in settings.json, their secrets in
 * the vault, and their live connections in ExternalServers.
 */
export class ExternalServerStore {
  private configs: ExternalServerConfig[] = [];
  private secretNames = new Map<string, readonly string[]>();

  public constructor(private readonly options: {
    readonly settings: SettingsFile;
    readonly vault: SecretStore;
    readonly servers: ExternalServers;
  }) {}

  /** Connects to every saved server. Each connects on its own, so a slow one does not hold up the rest. */
  async start(): Promise<void> {
    this.configs = [...(await this.options.settings.read()).externalServers ?? []];
    await Promise.all(this.configs.map(async (config) => {
      const secrets = await this.readSecrets(config.id);
      this.secretNames.set(config.id, [...Object.keys(secrets.env), ...Object.keys(secrets.headers)]);
      await this.options.servers.set(config, secrets);
    }));
  }

  list(): readonly ExternalServerItem[] {
    const states = new Map(this.options.servers.list().map((view) => [view.config.id, view]));
    return this.configs.map((saved) => {
      const view = states.get(saved.id);
      const config = view?.config ?? saved;
      const state = view?.state ?? { status: "connecting" as const };
      return {
        id: config.id,
        name: config.name,
        address: config.transport.kind === "http"
          ? config.transport.url
          : [config.transport.command, ...config.transport.args].map(quote).join(" "),
        approval: config.approval,
        secretNames: this.secretNames.get(config.id) ?? [],
        status: state.status,
        message: state.status === "failed" ? state.message : null,
        tools: state.status === "connected"
          ? state.tools.map((tool) => ({ name: tool.name, asksForApproval: needsApproval(config, tool) }))
          : []
      };
    });
  }

  /** Adds the servers in a pasted setup. They start connecting; the list shows how that goes. */
  async add(setup: unknown, approval: unknown): Promise<readonly ExternalServerItem[]> {
    if (typeof setup !== "string") throw new Error("Paste the server's setup first.");
    if (approval !== "changes" && approval !== "all") throw new Error("Choose when MCP Connector should ask for approval.");
    const parsed = parseServerSetup(setup, { approval, takenIds: new Set(this.configs.map((config) => config.id)) });
    for (const { config, secrets } of parsed) {
      if (Object.keys(secrets.env).length > 0 || Object.keys(secrets.headers).length > 0) {
        await this.options.vault.saveSecret(secretName(config.id), JSON.stringify(secrets));
      }
      this.secretNames.set(config.id, [...Object.keys(secrets.env), ...Object.keys(secrets.headers)]);
    }
    this.configs = [...this.configs, ...parsed.map(({ config }) => config)];
    await this.save();
    for (const { config, secrets } of parsed) {
      void this.options.servers.set(config, secrets);
    }
    return this.list();
  }

  async remove(id: unknown): Promise<readonly ExternalServerItem[]> {
    const config = this.require(id);
    this.configs = this.configs.filter((candidate) => candidate.id !== config.id);
    await this.save();
    await this.options.vault.removeSecret(secretName(config.id));
    this.secretNames.delete(config.id);
    await this.options.servers.remove(config.id);
    return this.list();
  }

  reconnect(id: unknown): readonly ExternalServerItem[] {
    const config = this.require(id);
    void this.options.servers.reconnect(config.id).catch(() => undefined);
    return this.list();
  }

  async setApproval(id: unknown, approval: unknown): Promise<readonly ExternalServerItem[]> {
    const config = this.require(id);
    if (approval !== "changes" && approval !== "all") throw new Error("Choose when MCP Connector should ask for approval.");
    this.configs = this.configs.map((candidate) => candidate.id === config.id ? { ...candidate, approval } : candidate);
    await this.save();
    this.options.servers.setApproval(config.id, approval);
    return this.list();
  }

  private require(id: unknown): ExternalServerConfig {
    const config = typeof id === "string" ? this.configs.find((candidate) => candidate.id === id) : undefined;
    if (config === undefined) throw new Error("MCP Connector has no such server.");
    return config;
  }

  private async save(): Promise<void> {
    await this.options.settings.update({ externalServers: this.configs });
  }

  private async readSecrets(id: string): Promise<ExternalServerSecrets> {
    const stored = await this.options.vault.getSecret(secretName(id));
    if (stored === null) return NO_SECRETS;
    try {
      return externalServerSecretsSchema.parse(JSON.parse(stored));
    } catch {
      return NO_SECRETS;
    }
  }
}

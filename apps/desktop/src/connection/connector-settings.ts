import type { ConnectorDefinition } from "@mcp-connector/core";
import type { AppSettings } from "../settings/app-settings";

export type SettingSource = "app" | "environment";

export interface SettingValue {
  readonly value: string;
  readonly source: SettingSource;
}

/**
 * Settings an environment variable can still provide, for setups made before
 * the app could store them. A value saved in the app wins.
 */
export const SETTING_ENVIRONMENT_VARIABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  notion: { databaseId: "MCP_NOTION_DATABASE_ID" }
};

type Values = Readonly<Record<string, Readonly<Record<string, string>>>>;

interface SettingsFile {
  read(): Promise<AppSettings>;
  update(changes: Partial<AppSettings>): Promise<AppSettings>;
}

/**
 * Each connector's settings, kept in memory so tools can read them while the
 * MCP server runs, and saved in settings.json when they change.
 */
export class ConnectorSettings {
  private constructor(
    private readonly file: SettingsFile,
    private values: Values,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  static async load(file: SettingsFile, env: NodeJS.ProcessEnv = process.env): Promise<ConnectorSettings> {
    return new ConnectorSettings(file, (await file.read()).connectorSettings ?? {}, env);
  }

  get(definition: ConnectorDefinition, key: string): SettingValue | null {
    const saved = this.values[definition.id]?.[key];
    if (saved !== undefined) return { value: saved, source: "app" };
    const variable = SETTING_ENVIRONMENT_VARIABLES[definition.id]?.[key];
    const raw = variable === undefined ? undefined : this.env[variable]?.trim();
    if (raw === undefined || raw.length === 0) return null;
    const setting = definition.settings.find((candidate) => candidate.key === key);
    try {
      return { value: setting === undefined ? raw : setting.parse(raw), source: "environment" };
    } catch {
      // A malformed environment value counts as not set, so the app asks for one.
      return null;
    }
  }

  /** For tools: the value, or a message saying where to set it. */
  require(definition: ConnectorDefinition, key: string): string {
    const found = this.get(definition, key);
    if (found !== null) return found.value;
    const label = definition.settings.find((setting) => setting.key === key)?.label ?? key;
    throw new Error(`${definition.name} needs "${label}". Set it in MCP Connector, under ${definition.name}.`);
  }

  /** Saves what the user typed; an empty value clears the setting. */
  async set(definition: ConnectorDefinition, key: string, input: string): Promise<SettingValue | null> {
    const setting = definition.settings.find((candidate) => candidate.key === key);
    if (setting === undefined) throw new Error(`${definition.name} has no setting called "${key}".`);
    const own = { ...this.values[definition.id] };
    if (input.trim().length === 0) {
      delete own[key];
    } else {
      own[key] = setting.parse(input);
    }
    const next: Record<string, Readonly<Record<string, string>>> = { ...this.values, [definition.id]: own };
    if (Object.keys(own).length === 0) delete next[definition.id];
    await this.file.update({ connectorSettings: next });
    this.values = next;
    return this.get(definition, key);
  }
}

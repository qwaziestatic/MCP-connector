import {
  isConnectorId,
  type ConnectedConnector,
  type ConnectorDefinition,
  type ConnectorSignIn,
  type OAuthTokenSet
} from "@mcp-connector/core";
import type { StoredCredential } from "../security/credential-vault";
import type { SignInFlow, SignInPrompt } from "../security/sign-in-flow";
import { VaultTokenProvider } from "../security/vault-token-provider";
import type { ConnectorSettings, SettingSource } from "./connector-settings";

/** One connector as the window shows it. */
export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly signIn: ConnectorSignIn["kind"];
  /** False when this copy cannot sign in to the service yet; the window says it comes later. */
  readonly signInAvailable: boolean;
  readonly connected: boolean;
  readonly settings: readonly {
    readonly key: string;
    readonly label: string;
    readonly help: string;
    readonly placeholder: string;
    readonly value: string | null;
    readonly source: SettingSource | null;
  }[];
}

export interface ConnectorVault {
  get(provider: string): Promise<StoredCredential | null>;
  save(credential: StoredCredential): Promise<void>;
  has(provider: string): Promise<boolean>;
  remove(provider: string): Promise<void>;
}

export interface ConnectorHubOptions {
  readonly definitions: readonly ConnectorDefinition[];
  readonly vault: ConnectorVault;
  readonly settings: ConnectorSettings;
  /** The sign-in flow for a definition's kind of sign-in. */
  readonly createSignIn: (definition: ConnectorDefinition) => SignInFlow;
  /** How a definition's tokens renew, or null when they cannot. */
  readonly createRefresh: (definition: ConnectorDefinition) => ((refreshToken: string) => Promise<OAuthTokenSet>) | null;
  /** Whether this copy can sign in to a definition's service at all. Every one can when left out. */
  readonly isSignInAvailable?: (definition: ConnectorDefinition) => boolean;
}

/** Every connector the app offers, with its sign-in, settings, and tools' runtime. */
export class ConnectorHub {
  /** The connectors and the runtime their MCP tools use. */
  readonly connectors: readonly ConnectedConnector[];
  private readonly flows = new Map<string, SignInFlow>();

  public constructor(private readonly options: ConnectorHubOptions) {
    this.connectors = options.definitions.map((definition) => ({
      definition,
      runtime: {
        tokens: new VaultTokenProvider(options.vault, definition.id, definition.name, options.createRefresh(definition)),
        requireSetting: (key: string) => options.settings.require(definition, key)
      }
    }));
  }

  async list(): Promise<readonly ConnectorView[]> {
    return Promise.all(this.options.definitions.map((definition) => this.view(definition)));
  }

  async startSignIn(id: unknown): Promise<SignInPrompt> {
    return this.flow(id).start();
  }

  async openSignInPage(id: unknown): Promise<void> {
    return this.flow(id).openPage();
  }

  async finishSignIn(id: unknown): Promise<void> {
    return this.flow(id).finish();
  }

  cancelSignIn(id: unknown): void {
    this.flow(id).cancel();
  }

  async disconnect(id: unknown): Promise<void> {
    const definition = this.definition(id);
    this.flows.get(definition.id)?.cancel();
    await this.options.vault.remove(definition.id);
  }

  async setSetting(id: unknown, key: unknown, input: unknown): Promise<ConnectorView> {
    const definition = this.definition(id);
    if (typeof key !== "string" || typeof input !== "string") throw new Error("Invalid setting.");
    await this.options.settings.set(definition, key, input);
    return this.view(definition);
  }

  /** Requests come from the window, so the id is checked against the list. */
  private definition(id: unknown): ConnectorDefinition {
    const definition = isConnectorId(id) ? this.options.definitions.find((candidate) => candidate.id === id) : undefined;
    if (definition === undefined) throw new Error("MCP Connector has no such connector.");
    return definition;
  }

  private flow(id: unknown): SignInFlow {
    const definition = this.definition(id);
    let flow = this.flows.get(definition.id);
    if (flow === undefined) {
      flow = this.options.createSignIn(definition);
      this.flows.set(definition.id, flow);
    }
    return flow;
  }

  private async view(definition: ConnectorDefinition): Promise<ConnectorView> {
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      signIn: definition.signIn.kind,
      signInAvailable: this.options.isSignInAvailable?.(definition) ?? true,
      connected: await this.options.vault.has(definition.id),
      settings: definition.settings.map((setting) => {
        const current = this.options.settings.get(definition, setting.key);
        return {
          key: setting.key,
          label: setting.label,
          help: setting.help,
          placeholder: setting.placeholder,
          value: current?.value ?? null,
          source: current?.source ?? null
        };
      })
    };
  }
}

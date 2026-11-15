// Runs the two local listeners that other programs connect to: the MCP HTTP
// server (for AI agents) and the VS Code context listener. Both use a fixed
// port and a token saved in the vault, so agents and the VS Code extension are
// set up once and keep working after the app restarts. The MCP server also
// accepts the browser extension's own key, which web chats use.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  startMcpHttpServer,
  type McpConnectorDependencies,
  type McpHttpServerHandle
} from "@mcp-connector/core";
import type { LocalSecretName, LocalSecretStore } from "../security/credential-vault";
import type { AppSettingsStore } from "../settings/app-settings";
import {
  startVsCodeContextServer,
  type VsCodeContext,
  type VsCodeContextServerHandle
} from "../security/vscode-context-server";

export const DEFAULT_MCP_PORT = 47_820;
export const DEFAULT_VSCODE_PORT = 47_821;

export interface ListenerStatus {
  readonly enabled: boolean;
  /** The address agents use. Null only when the port is 0 and nothing is running. */
  readonly url: string | null;
  readonly bearerToken: string;
}

export interface VsCodeListenerStatus extends ListenerStatus {
  readonly latestContext: VsCodeContext | null;
}

/** What the window shows under "Web chats". */
export interface WebChatStatus {
  /** The browser extension's key, or null while web chats are turned off. */
  readonly browserKey: string | null;
  /** Whether a web chat's read-only calls wait for the user's approval. */
  readonly askBeforeReads: boolean;
}

/** Written while the MCP server runs, so `--mcp-stdio` can find it. Holds no secrets. */
export interface McpEndpointFile {
  readonly url: string;
}

export interface ConnectionManagerOptions {
  readonly settings: AppSettingsStore;
  readonly secrets: LocalSecretStore;
  readonly getMcpDependencies: () => McpConnectorDependencies;
  readonly endpointFilePath: string;
  readonly onVsCodeContext?: (context: VsCodeContext) => void;
  readonly log?: (message: string) => void;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

export class AgentConnectionManager {
  private mcpServer: McpHttpServerHandle | null = null;
  private vsCodeServer: VsCodeContextServerHandle | null = null;
  // The browser key the running server accepts. The server reads it on every
  // request, so a new key, or none, takes effect at once, without a restart.
  private browserKey: string | null = null;
  // Set by "Turn off" and cleared only by a new key, so a key that could not
  // be removed from the vault is never read back and accepted again.
  private webChatsTurnedOff = false;

  public constructor(private readonly options: ConnectionManagerOptions) {}

  async getMcpStatus(): Promise<ListenerStatus> {
    const bearerToken = await this.token("mcp-http-token");
    if (this.mcpServer !== null) {
      return { enabled: true, url: this.mcpServer.url, bearerToken };
    }
    const port = await this.mcpPort();
    return { enabled: false, url: port === 0 ? null : `http://127.0.0.1:${port}/mcp`, bearerToken };
  }

  async startMcp(): Promise<ListenerStatus> {
    if (this.mcpServer === null) {
      await this.openMcpServer();
      await this.options.settings.update({ mcpServerEnabled: true });
    }
    return this.getMcpStatus();
  }

  async stopMcp(): Promise<ListenerStatus> {
    await this.closeMcpServer();
    await this.options.settings.update({ mcpServerEnabled: false });
    return this.getMcpStatus();
  }

  /** Replaces the MCP token. Agents set up with the old token must be set up again. */
  async regenerateMcpToken(): Promise<ListenerStatus> {
    await this.options.secrets.saveSecret("mcp-http-token", newToken());
    if (this.mcpServer !== null) {
      await this.closeMcpServer();
      await this.openMcpServer();
    }
    return this.getMcpStatus();
  }

  async getWebChatStatus(): Promise<WebChatStatus> {
    this.browserKey = await this.readBrowserKey();
    return { browserKey: this.browserKey, askBeforeReads: await this.askBeforeWebReads() };
  }

  /**
   * Creates the browser key, or replaces it; the old one stops working at
   * once. The agents' token and the running server are not touched.
   */
  async newBrowserKey(): Promise<WebChatStatus> {
    const key = newToken();
    await this.options.secrets.saveSecret("browser-key", key);
    // Only a new key turns web chats back on, and only once it is saved.
    await this.options.settings.update({ webChatsTurnedOff: false });
    this.webChatsTurnedOff = false;
    this.browserKey = key;
    return this.getWebChatStatus();
  }

  /**
   * Turns web chats off: no browser key is accepted until a new one is
   * created. That holds even if the key cannot be removed from the vault,
   * because the choice is remembered separately, in memory and in the settings.
   */
  async turnOffWebChats(): Promise<WebChatStatus> {
    // Refused from this moment, whatever happens below.
    this.browserKey = null;
    this.webChatsTurnedOff = true;
    const failures: unknown[] = [];
    // Remembered first, so the key stays refused after a restart too.
    await this.options.settings.update({ webChatsTurnedOff: true }).catch((error: unknown) => failures.push(error));
    await this.options.secrets.removeSecret("browser-key").catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      const reason = failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join(" ");
      throw new Error(
        `Web chats are turned off, but the old key could not be removed completely (${reason}). `
        + "It is no longer accepted. Click Turn off again to retry, or create a new key to replace it.",
        { cause: failures[0] }
      );
    }
    return this.getWebChatStatus();
  }

  async setAskBeforeWebReads(ask: boolean): Promise<WebChatStatus> {
    await this.options.settings.update({ askBeforeWebReads: ask });
    return this.getWebChatStatus();
  }

  async getVsCodeStatus(): Promise<VsCodeListenerStatus> {
    const bearerToken = await this.token("vscode-listener-token");
    const latestContext = this.vsCodeServer?.latestContext ?? null;
    if (this.vsCodeServer !== null) {
      return { enabled: true, url: this.vsCodeServer.url, bearerToken, latestContext };
    }
    const port = await this.vsCodePort();
    return { enabled: false, url: port === 0 ? null : `ws://127.0.0.1:${port}`, bearerToken, latestContext };
  }

  async startVsCode(): Promise<VsCodeListenerStatus> {
    if (this.vsCodeServer === null) {
      const port = await this.vsCodePort();
      try {
        this.vsCodeServer = await startVsCodeContextServer(
          (context) => this.options.onVsCodeContext?.(context),
          { port, bearerToken: await this.token("vscode-listener-token") }
        );
      } catch (error) {
        throw this.describeStartError("VS Code listener", "vscodePort", port, error);
      }
      this.options.log?.(`VS Code listener started at ${this.vsCodeServer.url}`);
      await this.options.settings.update({ vscodeListenerEnabled: true });
    }
    return this.getVsCodeStatus();
  }

  async stopVsCode(): Promise<VsCodeListenerStatus> {
    const server = this.vsCodeServer;
    this.vsCodeServer = null;
    await server?.close();
    await this.options.settings.update({ vscodeListenerEnabled: false });
    return this.getVsCodeStatus();
  }

  /**
   * Starts whatever was running when the app last closed. Failures are
   * reported, not thrown, so a busy port cannot stop the app from opening.
   */
  async restoreOnLaunch(overrides: { readonly mcp?: boolean } = {}): Promise<readonly string[]> {
    const settings = await this.options.settings.read();
    const problems: string[] = [];
    if (overrides.mcp === true || settings.mcpServerEnabled === true) {
      try {
        await this.openMcpServer();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (settings.vscodeListenerEnabled === true) {
      try {
        await this.startVsCode();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    return problems;
  }

  /** Closes both listeners on quit without forgetting that they were running. */
  async closeAll(): Promise<void> {
    await this.closeMcpServer();
    const server = this.vsCodeServer;
    this.vsCodeServer = null;
    await server?.close();
  }

  private async openMcpServer(): Promise<void> {
    if (this.mcpServer !== null) return;
    const port = await this.mcpPort();
    try {
      this.browserKey = await this.readBrowserKey();
      this.mcpServer = await startMcpHttpServer(
        // Read on every call, so changing the setting reaches the running server.
        { ...this.options.getMcpDependencies(), askBeforeWebReads: () => this.askBeforeWebReads() },
        {
          port,
          bearerToken: await this.token("mcp-http-token"),
          browserKey: () => this.browserKey
        }
      );
    } catch (error) {
      throw this.describeStartError("MCP server", "mcpPort", port, error);
    }
    const endpoint: McpEndpointFile = { url: this.mcpServer.url };
    await mkdir(dirname(this.options.endpointFilePath), { recursive: true });
    await writeFile(this.options.endpointFilePath, JSON.stringify(endpoint), "utf8");
    this.options.log?.(`MCP server started at ${this.mcpServer.url}`);
  }

  private async closeMcpServer(): Promise<void> {
    const server = this.mcpServer;
    this.mcpServer = null;
    if (server !== null) {
      await this.removeEndpointFileIfOurs(server.url);
    }
    await server?.close();
  }

  // Only remove the address this copy wrote, so a copy that never started a
  // server, or started a different one, cannot hide another copy's server.
  private async removeEndpointFileIfOurs(url: string): Promise<void> {
    try {
      const endpoint = JSON.parse(await readFile(this.options.endpointFilePath, "utf8")) as Partial<McpEndpointFile>;
      if (endpoint.url !== url) return;
    } catch {
      return;
    }
    await rm(this.options.endpointFilePath, { force: true });
  }

  private async token(name: LocalSecretName): Promise<string> {
    const existing = await this.options.secrets.getSecret(name);
    if (existing !== null) return existing;
    const token = newToken();
    await this.options.secrets.saveSecret(name, token);
    return token;
  }

  /** The key in the vault, unless web chats were turned off since it was created. */
  private async readBrowserKey(): Promise<string | null> {
    if (this.webChatsTurnedOff || (await this.options.settings.read()).webChatsTurnedOff === true) {
      this.webChatsTurnedOff = true;
      return null;
    }
    return this.options.secrets.getSecret("browser-key");
  }

  /** On unless the user turned it off; a settings file that cannot be read keeps it on. */
  private async askBeforeWebReads(): Promise<boolean> {
    return (await this.options.settings.read()).askBeforeWebReads ?? true;
  }

  private async mcpPort(): Promise<number> {
    return (await this.options.settings.read()).mcpPort ?? DEFAULT_MCP_PORT;
  }

  private async vsCodePort(): Promise<number> {
    return (await this.options.settings.read()).vscodePort ?? DEFAULT_VSCODE_PORT;
  }

  private describeStartError(name: string, setting: string, port: number, error: unknown): Error {
    if (isAddressInUse(error)) {
      return new Error(
        `The ${name} could not start: port ${port} is already in use, probably by another copy of `
        + `MCP Connector or another program. Close it, or set "${setting}" to a free port in `
        + `${this.options.settings.path}.`,
        { cause: error }
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

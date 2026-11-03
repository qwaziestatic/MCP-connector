// Runs the two local listeners that other programs connect to: the MCP HTTP
// server (for AI agents) and the VS Code context listener. Both use a fixed
// port and a token saved in the vault, so agents and the VS Code extension are
// set up once and keep working after the app restarts.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
      this.mcpServer = await startMcpHttpServer(this.options.getMcpDependencies(), {
        port,
        bearerToken: await this.token("mcp-http-token")
      });
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
    await rm(this.options.endpointFilePath, { force: true });
    await server?.close();
  }

  private async token(name: LocalSecretName): Promise<string> {
    const existing = await this.options.secrets.getSecret(name);
    if (existing !== null) return existing;
    const token = newToken();
    await this.options.secrets.saveSecret(name, token);
    return token;
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

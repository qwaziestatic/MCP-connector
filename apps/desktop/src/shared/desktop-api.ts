import type { AuditRecord, WorkflowPreview, WorkflowPreviewState, WorkspaceSnapshot } from "@mcp-connector/core";
import type { VsCodeContext } from "../security/vscode-context-server";
import type { ConnectorView } from "../connection/connector-hub";
import type { ExternalServerItem } from "../connection/external-server-store";
import type { SignInPrompt } from "../security/sign-in-flow";

export interface ListenerStatus {
  readonly enabled: boolean;
  /** Null only when the port is set to 0 and the listener is stopped. */
  readonly url: string | null;
  readonly bearerToken: string;
}

export interface AgentConfigs {
  readonly claudeCode: string;
  readonly cursor: string;
  readonly vsCode: string;
  readonly codex: string;
  readonly geminiCli: string;
  readonly windsurf: string;
  /** Null outside the installed app. */
  readonly claudeCodeStdio: string | null;
  readonly stdioJson: string | null;
}

export interface DesktopApi {
  readonly app: {
    readonly getVersion: () => Promise<string>;
    readonly getStartupProblems: () => Promise<readonly string[]>;
    readonly openLogsFolder: () => Promise<void>;
  };
  readonly updater: {
    readonly getStatus: () => Promise<{
      readonly enabled: boolean;
      readonly phase: "disabled" | "idle" | "checking" | "available" | "unavailable" | "downloading" | "downloaded" | "error";
      readonly currentVersion: string;
      readonly availableVersion: string | null;
      readonly downloadedVersion: string | null;
      readonly progressPercent: number | null;
      readonly lastCheckedAt: string | null;
      readonly message: string | null;
    }>;
    readonly check: () => Promise<{
      readonly enabled: boolean;
      readonly phase: "disabled" | "idle" | "checking" | "available" | "unavailable" | "downloading" | "downloaded" | "error";
      readonly currentVersion: string;
      readonly availableVersion: string | null;
      readonly downloadedVersion: string | null;
      readonly progressPercent: number | null;
      readonly lastCheckedAt: string | null;
      readonly message: string | null;
    }>;
    readonly download: () => Promise<{
      readonly enabled: boolean;
      readonly phase: "disabled" | "idle" | "checking" | "available" | "unavailable" | "downloading" | "downloaded" | "error";
      readonly currentVersion: string;
      readonly availableVersion: string | null;
      readonly downloadedVersion: string | null;
      readonly progressPercent: number | null;
      readonly lastCheckedAt: string | null;
      readonly message: string | null;
    }>;
    readonly quitAndInstall: () => Promise<void>;
  };
  readonly filesystem: {
    readonly chooseWorkspace: () => Promise<string | null>;
    readonly inspectWorkspace: (workspacePath: string) => Promise<WorkspaceSnapshot>;
    readonly getSelectedWorkspace: () => Promise<string | null>;
  };
  readonly workflow: {
    readonly createPreview: (
      action: WorkflowPreview["action"],
      target: string,
      summary: string,
      payload: Readonly<Record<string, unknown>>
    ) => Promise<WorkflowPreview>;
    readonly approve: (previewId: string) => Promise<WorkflowPreview>;
    readonly reject: (previewId: string) => Promise<WorkflowPreview>;
    readonly listPending: () => Promise<readonly WorkflowPreviewState[]>;
    readonly subscribe: (listener: (previews: readonly WorkflowPreviewState[]) => void) => () => void;
    readonly createNotionPagePreview: (title: string, markdown: string) => Promise<WorkflowPreview>;
    readonly executeApproved: (previewId: string) => Promise<{ readonly pageId: string; readonly url: string | null }>;
    readonly listAuditRecords: () => Promise<readonly AuditRecord[]>;
  };
  /** Every service the app connects to, from the connector definitions. */
  readonly connectors: {
    readonly list: () => Promise<readonly ConnectorView[]>;
    /** Starts signing in; the prompt says whether to show a code or wait for the browser. */
    readonly startSignIn: (id: string) => Promise<SignInPrompt>;
    /** Opens the page where the user enters the code. */
    readonly openSignInPage: (id: string) => Promise<void>;
    /** Resolves once the user approved and the token is saved. */
    readonly finishSignIn: (id: string) => Promise<void>;
    readonly cancelSignIn: (id: string) => Promise<void>;
    readonly disconnect: (id: string) => Promise<void>;
    /** Saves a setting from what the user typed; an empty value clears it. */
    readonly setSetting: (id: string, key: string, value: string) => Promise<ConnectorView>;
  };
  /** Other MCP servers the user added, offered to agents with the same approvals. */
  readonly external: {
    readonly list: () => Promise<readonly ExternalServerItem[]>;
    /** Adds the servers in a pasted "mcpServers" setup. */
    readonly add: (setup: string, approval: "changes" | "all") => Promise<readonly ExternalServerItem[]>;
    readonly remove: (id: string) => Promise<readonly ExternalServerItem[]>;
    readonly reconnect: (id: string) => Promise<readonly ExternalServerItem[]>;
    readonly setApproval: (id: string, approval: "changes" | "all") => Promise<readonly ExternalServerItem[]>;
    /** Called whenever a server connects, stops, or changes its tools. */
    readonly subscribe: (listener: (servers: readonly ExternalServerItem[]) => void) => () => void;
  };
  readonly mcp: {
    readonly getStatus: () => Promise<ListenerStatus>;
    readonly start: () => Promise<ListenerStatus>;
    readonly stop: () => Promise<ListenerStatus>;
    readonly regenerateToken: () => Promise<ListenerStatus>;
    readonly getAgentConfigs: () => Promise<AgentConfigs>;
  };
  readonly vscode: {
    readonly getStatus: () => Promise<ListenerStatus & { readonly latestContext: VsCodeContext | null }>;
    readonly start: () => Promise<ListenerStatus & { readonly latestContext: VsCodeContext | null }>;
    readonly stop: () => Promise<ListenerStatus & { readonly latestContext: VsCodeContext | null }>;
  };
}

import type { AuditRecord, WorkflowPreview, WorkflowPreviewState, WorkspaceSnapshot } from "@mcp-connector/core";
import type { VsCodeContext } from "../security/vscode-context-server";

export interface ListenerStatus {
  readonly enabled: boolean;
  /** Null only when the port is set to 0 and the listener is stopped. */
  readonly url: string | null;
  readonly bearerToken: string;
}

export interface AgentConfigs {
  readonly claudeCode: string;
  readonly cursor: string;
  /** Null outside the installed app. */
  readonly claudeCodeStdio: string | null;
  readonly stdioJson: string | null;
}

export interface DesktopApi {
  readonly app: {
    readonly getVersion: () => Promise<string>;
    readonly getStartupProblems: () => Promise<readonly string[]>;
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
  readonly credentials: {
    readonly getStatus: () => Promise<Readonly<Record<"github" | "notion", boolean>>>;
    readonly connect: (provider: "github" | "notion") => Promise<void>;
    readonly disconnect: (provider: "github" | "notion") => Promise<void>;
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

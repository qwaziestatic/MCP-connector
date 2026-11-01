import type { AuditRecord, WorkflowPreview, WorkspaceSnapshot } from "@mcp-connector/core";
import type { VsCodeContext } from "../security/vscode-context-server";

export interface DesktopApi {
  readonly app: {
    readonly getVersion: () => Promise<string>;
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
    readonly executeApproved: (previewId: string) => Promise<{ readonly pageId: string; readonly url: string | null }>;
    readonly listAuditRecords: () => Promise<readonly AuditRecord[]>;
  };
  readonly credentials: {
    readonly getStatus: () => Promise<Readonly<Record<"github" | "notion", boolean>>>;
    readonly connect: (provider: "github" | "notion") => Promise<void>;
    readonly disconnect: (provider: "github" | "notion") => Promise<void>;
  };
  readonly mcp: {
    readonly getStatus: () => Promise<{ readonly enabled: boolean; readonly url: string | null; readonly bearerToken: string | null }>;
    readonly start: () => Promise<{ readonly url: string; readonly bearerToken: string }>;
    readonly stop: () => Promise<void>;
  };
  readonly vscode: {
    readonly getStatus: () => Promise<{ readonly enabled: boolean; readonly url: string | null; readonly bearerToken: string | null; readonly latestContext: VsCodeContext | null }>;
    readonly start: () => Promise<{ readonly url: string; readonly bearerToken: string }>;
    readonly stop: () => Promise<void>;
  };
}

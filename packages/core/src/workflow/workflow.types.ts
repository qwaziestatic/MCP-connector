export type WorkflowAction = "READ" | "CREATE" | "UPDATE" | "DELETE" | "UPLOAD";
export type WorkflowStatus = "PREVIEWED" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";

export interface WorkflowPreview {
  readonly id: string;
  readonly action: WorkflowAction;
  readonly target: string;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requiresApproval: boolean;
  readonly createdAt: string;
}

export interface AuditRecord {
  readonly id: string;
  readonly action: WorkflowAction;
  readonly target: string;
  readonly status: WorkflowStatus;
  readonly previewJson: string;
  readonly createdAt: string;
}

export interface AuditRepository {
  create(record: AuditRecord): Promise<void>;
  list(): Promise<readonly AuditRecord[]>;
}

export interface WorkflowPreviewRepository {
  createPreview(preview: WorkflowPreview): Promise<void>;
  get(id: string): Promise<WorkflowPreviewRecord | undefined>;
  markApproved(id: string, approvedAt: string): Promise<void>;
  markRejected(id: string, rejectedAt: string): Promise<void>;
  markExecuted(id: string, executedAt: string): Promise<void>;
  markFailed(id: string, failedAt: string): Promise<void>;
}

export interface WorkflowPreviewRecord {
  readonly preview: WorkflowPreview;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly executedAt?: string;
  readonly failedAt?: string;
}

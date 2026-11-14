/** CALL: a call to another MCP server's tool, run once the user approves it. */
export type WorkflowAction = "READ" | "CREATE" | "UPDATE" | "DELETE" | "UPLOAD" | "CALL";
export type WorkflowStatus = "PREVIEWED" | "APPROVED" | "REJECTED" | "EXECUTING" | "EXECUTED" | "FAILED";
/**
 * Who asked: the app's own window ("ui"), an agent with the MCP token ("mcp"),
 * or a web chat through the browser extension's key ("web").
 */
export type WorkflowSource = "ui" | "mcp" | "web";
/** The sources that reach the MCP server. */
export type McpClientSource = Exclude<WorkflowSource, "ui">;

export interface WorkflowPreview {
  readonly id: string;
  readonly action: WorkflowAction;
  readonly target: string;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requiresApproval: boolean;
  readonly source: WorkflowSource;
  readonly createdAt: string;
}

export interface AuditRecord {
  readonly id: string;
  readonly action: WorkflowAction;
  readonly target: string;
  readonly status: WorkflowStatus;
  readonly source: WorkflowSource;
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
  claimExecution(id: string, executingAt: string): Promise<boolean>;
  markExecuting(id: string, executingAt: string): Promise<void>;
  markExecuted(id: string, executedAt: string): Promise<void>;
  markFailed(id: string, failedAt: string): Promise<void>;
  /** Previews not yet rejected, executing, executed or failed. */
  listOpenPreviews(): Promise<readonly WorkflowPreviewRecord[]>;
}

export interface WorkflowPreviewRecord {
  readonly preview: WorkflowPreview;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly executingAt?: string;
  readonly executedAt?: string;
  readonly failedAt?: string;
}

export interface WorkflowPreviewState extends WorkflowPreviewRecord {
  readonly status: WorkflowStatus;
}

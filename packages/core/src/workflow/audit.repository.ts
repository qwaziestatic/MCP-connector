import type {
  AuditRecord,
  AuditRepository,
  WorkflowPreview,
  WorkflowPreviewRecord,
  WorkflowPreviewRepository
} from "./workflow.types.js";

export class InMemoryAuditRepository implements AuditRepository, WorkflowPreviewRepository {
  private readonly records: AuditRecord[] = [];
  private readonly previews = new Map<string, WorkflowPreviewRecord>();

  async create(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  async list(): Promise<readonly AuditRecord[]> {
    return [...this.records].reverse();
  }

  async createPreview(preview: WorkflowPreview): Promise<void> {
    this.previews.set(preview.id, { preview });
  }

  async get(id: string): Promise<WorkflowPreviewRecord | undefined> {
    return this.previews.get(id);
  }

  async listPreviews(): Promise<readonly WorkflowPreviewRecord[]> {
    return [...this.previews.values()];
  }

  async markApproved(id: string, approvedAt: string): Promise<void> {
    const record = this.requirePreview(id);
    this.previews.set(id, { ...record, approvedAt });
  }

  async markRejected(id: string, rejectedAt: string): Promise<void> {
    const record = this.requirePreview(id);
    this.previews.set(id, { preview: record.preview, rejectedAt });
  }

  async markExecuted(id: string, executedAt: string): Promise<void> {
    const record = this.requirePreview(id);
    this.previews.set(id, { ...record, executedAt });
  }

  async markExecuting(id: string, executingAt: string): Promise<void> {
    const record = this.requirePreview(id);
    this.previews.set(id, { ...record, executingAt });
  }

  async claimExecution(id: string, executingAt: string): Promise<boolean> {
    const record = this.requirePreview(id);
    if (
      record.approvedAt === undefined
      || record.rejectedAt !== undefined
      || record.executingAt !== undefined
      || record.executedAt !== undefined
      || record.failedAt !== undefined
    ) {
      return false;
    }
    this.previews.set(id, { ...record, executingAt });
    return true;
  }

  async markFailed(id: string, failedAt: string): Promise<void> {
    const record = this.requirePreview(id);
    this.previews.set(id, { ...record, failedAt });
  }

  private requirePreview(id: string): WorkflowPreviewRecord {
    const record = this.previews.get(id);
    if (record === undefined) {
      throw new Error("Workflow preview was not found.");
    }
    return record;
  }
}

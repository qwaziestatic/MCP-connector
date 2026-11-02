import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuditRepository,
  WorkflowPreview,
  WorkflowPreviewRecord,
  WorkflowPreviewRepository,
  WorkflowPreviewState,
  WorkflowSource,
  WorkflowStatus
} from "./workflow.types.js";

const actionSchema = z.enum(["READ", "CREATE", "UPDATE", "DELETE", "UPLOAD"]);

interface PendingWorkflow {
  readonly preview: WorkflowPreview;
  approved: boolean;
  executing: boolean;
  executed: boolean;
  failed: boolean;
}

export class WorkflowService {
  private readonly pending = new Map<string, PendingWorkflow>();
  private readonly listeners = new Set<(state: readonly WorkflowPreviewState[]) => void>();
  private readonly previewRepository: WorkflowPreviewRepository | undefined;

  public constructor(
    private readonly auditRepository: AuditRepository,
    previewRepository?: WorkflowPreviewRepository
  ) {
    this.previewRepository = previewRepository;
  }

  async createPreview(
    action: unknown,
    target: unknown,
    summary: unknown,
    payload: unknown,
    source: WorkflowSource = "ui"
  ): Promise<WorkflowPreview> {
    const validatedAction = actionSchema.parse(action);
    const validatedTarget = z.string().trim().min(1).parse(target);
    const validatedSummary = z.string().trim().min(1).parse(summary);
    const validatedPayload = z.record(z.string(), z.unknown()).parse(payload);
    if (validatedTarget.length === 0 || validatedSummary.length === 0) {
      throw new Error("Workflow target and summary are required.");
    }

    const preview: WorkflowPreview = {
      id: randomUUID(),
      action: validatedAction,
      target: validatedTarget,
      summary: validatedSummary,
      payload: validatedPayload,
      requiresApproval: validatedAction !== "READ",
      source,
      createdAt: new Date().toISOString()
    };

    this.pending.set(preview.id, { preview, approved: false, executing: false, executed: false, failed: false });
    if (this.previewRepository !== undefined) {
      await this.previewRepository.createPreview(preview);
    }
    await this.auditRepository.create({
      id: randomUUID(),
      action: preview.action,
      target: preview.target,
      status: "PREVIEWED",
      previewJson: JSON.stringify(preview),
      createdAt: preview.createdAt
    });
    this.notify();

    return preview;
  }

  async approve(previewId: string): Promise<WorkflowPreview> {
    const pending = await this.getPending(previewId);
    if (pending === undefined) {
      throw new Error("Workflow preview was not found or has expired.");
    }

    pending.approved = true;
    await this.previewRepository?.markApproved(previewId, new Date().toISOString());
    await this.auditRepository.create({
      id: randomUUID(),
      action: pending.preview.action,
      target: pending.preview.target,
      status: "APPROVED",
      previewJson: JSON.stringify(pending.preview),
      createdAt: new Date().toISOString()
    });
    this.notify();

    return pending.preview;
  }

  async reject(previewId: string): Promise<WorkflowPreview> {
    const pending = await this.getPending(previewId);
    if (pending === undefined) {
      throw new Error("Workflow preview was not found or has expired.");
    }

    this.pending.delete(previewId);
    await this.previewRepository?.markRejected(previewId, new Date().toISOString());
    await this.auditRepository.create({
      id: randomUUID(),
      action: pending.preview.action,
      target: pending.preview.target,
      status: "REJECTED",
      previewJson: JSON.stringify(pending.preview),
      createdAt: new Date().toISOString()
    });
    this.notify();

    return pending.preview;
  }

  assertApproved(previewId: string): WorkflowPreview {
    const pending = this.pending.get(previewId);
    if (pending === undefined || !pending.approved) {
      throw new Error("Explicit approval is required before executing this workflow.");
    }
    return pending.preview;
  }

  async executeApproved<T>(
    previewId: string,
    executor: (preview: WorkflowPreview) => Promise<T>
  ): Promise<T> {
    const pending = await this.getPending(previewId);
    if (pending === undefined || !pending.approved) {
      throw new Error("Explicit approval is required before executing this workflow.");
    }
    if (pending.executed || pending.failed || pending.executing) {
      throw new Error(
        pending.executed ? "This workflow preview has already been executed."
          : pending.failed ? "This workflow preview has already failed."
            : "This workflow preview is already executing."
      );
    }

    const executingAt = new Date().toISOString();
    if (this.previewRepository !== undefined) {
      const claimed = await this.previewRepository.claimExecution(previewId, executingAt);
      if (!claimed) {
        throw new Error("This workflow preview is already executing or has been executed.");
      }
    }
    pending.executing = true;
    try {
      const result = await executor(pending.preview);
      pending.executed = true;
      pending.executing = false;
      await this.previewRepository?.markExecuted(previewId, new Date().toISOString());
      await this.auditRepository.create({
        id: randomUUID(),
        action: pending.preview.action,
        target: pending.preview.target,
        status: "EXECUTED",
        previewJson: JSON.stringify({ preview: pending.preview, result }),
        createdAt: new Date().toISOString()
      });
      this.notify();
      return result;
    } catch (error) {
      pending.executing = false;
      pending.failed = true;
      await this.previewRepository?.markFailed(previewId, new Date().toISOString());
      await this.auditRepository.create({
        id: randomUUID(),
        action: pending.preview.action,
        target: pending.preview.target,
        status: "FAILED",
        previewJson: JSON.stringify(pending.preview),
        createdAt: new Date().toISOString()
      });
      this.notify();
      throw error;
    }
  }

  async listPending(): Promise<readonly WorkflowPreviewState[]> {
    if (this.previewRepository !== undefined) {
      for (const record of await this.previewRepository.listPreviews()) {
        if (!this.pending.has(record.preview.id)) {
          this.pending.set(record.preview.id, this.fromPersisted(record));
        }
      }
    }
    return [...this.pending.values()]
      .map((pending) => ({ preview: pending.preview, status: this.statusOf(pending) }))
      .filter((state) => state.status === "PREVIEWED" || state.status === "APPROVED");
  }

  async getStatus(previewId: string): Promise<WorkflowStatus> {
    const pending = await this.getPending(previewId);
    if (pending === undefined) {
      throw new Error("Workflow preview was not found.");
    }
    return this.statusOf(pending);
  }

  subscribe(listener: (state: readonly WorkflowPreviewState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private statusOf(pending: PendingWorkflow): WorkflowStatus {
    if (pending.failed) return "FAILED";
    if (pending.executed) return "EXECUTED";
    if (pending.executing) return "EXECUTING";
    if (pending.approved) return "APPROVED";
    return "PREVIEWED";
  }

  private notify(): void {
    void this.listPending().then((state) => this.listeners.forEach((listener) => listener(state)));
  }
  private async getPending(previewId: string): Promise<PendingWorkflow | undefined> {
    const inMemory = this.pending.get(previewId);
    if (inMemory !== undefined) {
      return inMemory;
    }
    const persisted = await this.previewRepository?.get(previewId);
    // Rejected previews are final; they must not be reloaded and re-approved.
    if (persisted === undefined || persisted.rejectedAt !== undefined) {
      return undefined;
    }
    const pending = this.fromPersisted(persisted);
    this.pending.set(previewId, pending);
    return pending;
  }

  private fromPersisted(record: WorkflowPreviewRecord): PendingWorkflow {
    return {
      preview: record.preview,
      approved: record.approvedAt !== undefined && record.rejectedAt === undefined,
      executing: record.executingAt !== undefined && record.executedAt === undefined && record.failedAt === undefined,
      executed: record.executedAt !== undefined,
      failed: record.failedAt !== undefined
    };
  }
}

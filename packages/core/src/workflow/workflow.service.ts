import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuditRepository,
  WorkflowPreview,
  WorkflowPreviewRecord,
  WorkflowPreviewRepository
} from "./workflow.types.js";

const actionSchema = z.enum(["READ", "CREATE", "UPDATE", "DELETE", "UPLOAD"]);

interface PendingWorkflow {
  readonly preview: WorkflowPreview;
  approved: boolean;
  executed: boolean;
}

export class WorkflowService {
  private readonly pending = new Map<string, PendingWorkflow>();
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
    payload: unknown
  ): Promise<WorkflowPreview> {
    const validatedAction = actionSchema.parse(action);
    const validatedTarget = z.string().trim().min(1).parse(target);
    const validatedSummary = z.string().trim().min(1).parse(summary);
    const validatedPayload = z.record(z.unknown()).parse(payload);
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
      createdAt: new Date().toISOString()
    };

    this.pending.set(preview.id, { preview, approved: false, executed: false });
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
    if (pending.executed) {
      throw new Error("This workflow preview has already been executed.");
    }

    try {
      const result = await executor(pending.preview);
      pending.executed = true;
      await this.previewRepository?.markExecuted(previewId, new Date().toISOString());
      await this.auditRepository.create({
        id: randomUUID(),
        action: pending.preview.action,
        target: pending.preview.target,
        status: "EXECUTED",
        previewJson: JSON.stringify({ preview: pending.preview, result }),
        createdAt: new Date().toISOString()
      });
      return result;
    } catch (error) {
      await this.previewRepository?.markFailed(previewId, new Date().toISOString());
      await this.auditRepository.create({
        id: randomUUID(),
        action: pending.preview.action,
        target: pending.preview.target,
        status: "FAILED",
        previewJson: JSON.stringify(pending.preview),
        createdAt: new Date().toISOString()
      });
      throw error;
    }
  }

  private async getPending(previewId: string): Promise<PendingWorkflow | undefined> {
    const inMemory = this.pending.get(previewId);
    if (inMemory !== undefined) {
      return inMemory;
    }
    const persisted = await this.previewRepository?.get(previewId);
    if (persisted === undefined) {
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
      executed: record.executedAt !== undefined
    };
  }
}

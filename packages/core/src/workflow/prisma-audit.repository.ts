import type { PrismaClient } from "@prisma/client";
import type {
  AuditRecord,
  AuditRepository,
  WorkflowPreview,
  WorkflowPreviewRecord,
  WorkflowPreviewRepository
} from "./workflow.types.js";

export class PrismaAuditRepository implements AuditRepository, WorkflowPreviewRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  async create(record: AuditRecord): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        id: record.id,
        action: record.action,
        target: record.target,
        status: record.status,
        previewJson: record.previewJson,
        createdAt: new Date(record.createdAt)
      }
    });
  }

  async list(): Promise<readonly AuditRecord[]> {
    const records = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" }
    });

    return records.map((record) => ({
      id: record.id,
      action: record.action as AuditRecord["action"],
      target: record.target,
      status: record.status as AuditRecord["status"],
      previewJson: record.previewJson,
      createdAt: record.createdAt.toISOString()
    }));
  }

  async createPreview(preview: WorkflowPreview): Promise<void> {
    await this.prisma.workflowPreview.create({
      data: {
        id: preview.id,
        action: preview.action,
        target: preview.target,
        summary: preview.summary,
        payloadJson: JSON.stringify(preview.payload),
        requiresApproval: preview.requiresApproval,
        source: preview.source,
        createdAt: new Date(preview.createdAt)
      }
    });
  }

  async get(id: string): Promise<WorkflowPreviewRecord | undefined> {
    const record = await this.prisma.workflowPreview.findUnique({ where: { id } });
    if (record === null) {
      return undefined;
    }
    return {
      preview: {
        id: record.id,
        action: record.action as WorkflowPreview["action"],
        target: record.target,
        summary: record.summary,
        payload: JSON.parse(record.payloadJson) as Record<string, unknown>,
        requiresApproval: record.requiresApproval,
        source: record.source as WorkflowPreview["source"],
        createdAt: record.createdAt.toISOString()
      },
      ...(record.approvedAt === null ? {} : { approvedAt: record.approvedAt.toISOString() }),
      ...(record.rejectedAt === null ? {} : { rejectedAt: record.rejectedAt.toISOString() }),
      ...(record.executingAt === null ? {} : { executingAt: record.executingAt.toISOString() }),
      ...(record.executedAt === null ? {} : { executedAt: record.executedAt.toISOString() }),
      ...(record.failedAt === null ? {} : { failedAt: record.failedAt.toISOString() })
    };
  }

  async listPreviews(): Promise<readonly WorkflowPreviewRecord[]> {
    const records = await this.prisma.workflowPreview.findMany({ orderBy: { createdAt: "desc" } });
    return Promise.all(records.map(async (record) => (await this.get(record.id))!));
  }

  async markApproved(id: string, approvedAt: string): Promise<void> {
    await this.prisma.workflowPreview.update({ where: { id }, data: { approvedAt: new Date(approvedAt) } });
  }

  async markRejected(id: string, rejectedAt: string): Promise<void> {
    await this.prisma.workflowPreview.update({
      where: { id },
      data: { approvedAt: null, rejectedAt: new Date(rejectedAt) }
    });
  }

  async markExecuted(id: string, executedAt: string): Promise<void> {
    await this.prisma.workflowPreview.update({ where: { id }, data: { executedAt: new Date(executedAt) } });
  }

  async markExecuting(id: string, executingAt: string): Promise<void> {
    await this.prisma.workflowPreview.update({ where: { id }, data: { executingAt: new Date(executingAt) } });
  }

  async claimExecution(id: string, executingAt: string): Promise<boolean> {
    const result = await this.prisma.workflowPreview.updateMany({
      where: {
        id,
        approvedAt: { not: null },
        rejectedAt: null,
        executingAt: null,
        executedAt: null,
        failedAt: null
      },
      data: { executingAt: new Date(executingAt) }
    });
    return result.count === 1;
  }

  async markFailed(id: string, failedAt: string): Promise<void> {
    await this.prisma.workflowPreview.update({ where: { id }, data: { failedAt: new Date(failedAt) } });
  }
}

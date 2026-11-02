import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "./audit.repository.js";
import { WorkflowService } from "./workflow.service.js";

describe("WorkflowService", () => {
  it("requires approval before execution and permits execution once", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository);
    const preview = await service.createPreview("CREATE", "Notion project page", "Create page", {
      title: "Project"
    });

    await expect(service.executeApproved(preview.id, async () => "created")).rejects.toThrow(
      "Explicit approval is required"
    );

    await service.approve(preview.id);
    await expect(service.executeApproved(preview.id, async () => "created")).resolves.toBe("created");
    await expect(service.executeApproved(preview.id, async () => "created")).rejects.toThrow(
      "already been executed"
    );

    const records = await repository.list();
    expect(records.map((record) => record.status)).toEqual(["EXECUTED", "APPROVED", "PREVIEWED"]);
  });

  it("records rejected previews and removes them from the pending set", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository);
    const preview = await service.createPreview("DELETE", "workspace/file.txt", "Delete file", {});

    await service.reject(preview.id);
    await expect(service.approve(preview.id)).rejects.toThrow("not found or has expired");

    const records = await repository.list();
    expect(records[0]?.status).toBe("REJECTED");
  });

  it("records failed executions and rethrows the executor error", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository);
    const preview = await service.createPreview("UPDATE", "target", "Update target", {});
    await service.approve(preview.id);

    await expect(
      service.executeApproved(preview.id, async () => {
        throw new Error("remote failure");
      })
    ).rejects.toThrow("remote failure");

    const records = await repository.list();
    expect(records[0]?.status).toBe("FAILED");
    await expect(service.executeApproved(preview.id, async () => "retry")).rejects.toThrow("already failed");
  });

  it("runs an approved preview only once when executions overlap", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("UPDATE", "target", "Update target", {});
    await service.approve(preview.id);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = service.executeApproved(preview.id, async () => {
      calls += 1;
      await blocked;
      return "done";
    });

    await expect(service.executeApproved(preview.id, async () => "duplicate")).rejects.toThrow("already executing");
    release();
    await expect(first).resolves.toBe("done");
    expect(calls).toBe(1);
  });

  it("lists durable pending previews with source and never executes on approval", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("CREATE", "target", "Create target", {}, "mcp");
    const before = await service.listPending();
    expect(before[0]).toMatchObject({ preview, status: "PREVIEWED" });
    await service.approve(preview.id);
    const after = await service.listPending();
    expect(after[0]).toMatchObject({ preview: { id: preview.id, source: "mcp" }, status: "APPROVED" });
  });

  it("restores an approved preview after the service is recreated", async () => {
    const repository = new InMemoryAuditRepository();
    const firstService = new WorkflowService(repository, repository);
    const preview = await firstService.createPreview("CREATE", "Notion", "Create page", {
      title: "Persisted"
    });
    await firstService.approve(preview.id);

    const restartedService = new WorkflowService(repository, repository);
    await expect(
      restartedService.executeApproved(preview.id, async (restored) => restored.payload.title)
    ).resolves.toBe("Persisted");
  });

  it("cannot re-approve a persisted preview after it has been rejected", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("CREATE", "Notion", "Create page", {});
    await service.reject(preview.id);

    await expect(service.approve(preview.id)).rejects.toThrow("not found or has expired");
    await expect(
      service.executeApproved(preview.id, async () => "should not execute")
    ).rejects.toThrow("Explicit approval is required");
  });

  it("cannot execute a preview after it has been rejected", async () => {
    const repository = new InMemoryAuditRepository();
    const firstService = new WorkflowService(repository, repository);
    const preview = await firstService.createPreview("CREATE", "Notion", "Create page", {});
    await firstService.approve(preview.id);
    await firstService.reject(preview.id);

    const restartedService = new WorkflowService(repository, repository);
    await expect(
      restartedService.executeApproved(preview.id, async () => "should not execute")
    ).rejects.toThrow("Explicit approval is required");
  });
});

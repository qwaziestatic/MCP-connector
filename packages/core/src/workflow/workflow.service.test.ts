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
    await expect(service.approve(preview.id)).rejects.toThrow("was rejected");

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

    await expect(service.approve(preview.id)).rejects.toThrow("was rejected");
    await expect(
      service.executeApproved(preview.id, async () => "should not execute")
    ).rejects.toThrow("Explicit approval is required");
  });

  it("does not list rejected previews as pending", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("CREATE", "Notion", "Create page", {}, "mcp");
    await service.reject(preview.id);

    expect(await service.listPending()).toEqual([]);
    expect(await new WorkflowService(repository, repository).listPending()).toEqual([]);
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

  it("reports REJECTED to agents instead of an unknown preview", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("CREATE", "Notion", "Create page", {}, "mcp");
    await service.reject(preview.id);

    expect(await service.getStatus(preview.id)).toBe("REJECTED");
    expect(await new WorkflowService(repository, repository).getStatus(preview.id)).toBe("REJECTED");
    await expect(service.getStatus("6b2c8f2e-1f1e-4c47-9b1a-6f1d2f3e4a5b")).rejects.toThrow("not found");
  });

  it("reports REJECTED without a preview repository", async () => {
    const service = new WorkflowService(new InMemoryAuditRepository());
    const preview = await service.createPreview("CREATE", "Notion", "Create page", {}, "mcp");
    await service.reject(preview.id);

    expect(await service.getStatus(preview.id)).toBe("REJECTED");
    await expect(service.reject(preview.id)).rejects.toThrow("already rejected");
  });

  it("records one approval per preview and refuses to approve a preview that has run", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("CREATE", "Notion", "Create page", {});
    await service.approve(preview.id);
    await service.approve(preview.id);
    await service.executeApproved(preview.id, async () => "done");

    await expect(service.approve(preview.id)).rejects.toThrow("already run");
    await expect(service.reject(preview.id)).rejects.toThrow("already run");
    const approvals = (await repository.list()).filter((record) => record.status === "APPROVED");
    expect(approvals).toHaveLength(1);
    expect(await service.getStatus(preview.id)).toBe("EXECUTED");
  });

  it("notifies subscribers before each state change resolves", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const updates: string[][] = [];
    service.subscribe((state) => updates.push(state.map((item) => item.status)));

    const preview = await service.createPreview("CREATE", "Notion", "Create page", {});
    expect(updates.at(-1)).toEqual(["PREVIEWED"]);
    await service.approve(preview.id);
    expect(updates.at(-1)).toEqual(["APPROVED"]);
    await service.reject(preview.id);
    expect(updates.at(-1)).toEqual([]);
  });

  it("keeps a state change when refreshing subscribers fails", async () => {
    const repository = new InMemoryAuditRepository();
    const service = new WorkflowService(repository, repository);
    const preview = await service.createPreview("CREATE", "Notion", "Create page", {});
    repository.listOpenPreviews = async () => {
      throw new Error("database unavailable");
    };
    service.subscribe(() => undefined);

    await expect(service.approve(preview.id)).resolves.toMatchObject({ id: preview.id });
    expect(await service.getStatus(preview.id)).toBe("APPROVED");
  });
});

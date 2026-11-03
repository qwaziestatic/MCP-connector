// Runs the desktop app's own migrations and the Prisma repository against a
// real SQLite database. migrations.test.ts only checks the SQL text with a
// mocked client, so a broken statement or a missing column would pass there.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { PrismaAuditRepository, WorkflowService } from "@mcp-connector/core";
import { afterEach, describe, expect, it } from "vitest";
import { applyDatabaseMigrations } from "./migrations";

const schemaPath = join(__dirname, "../../../../packages/core/prisma/schema.prisma");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openDatabase(directory?: string) {
  const databaseDirectory = directory ?? await mkdtemp(join(tmpdir(), "mcp-connector-db-"));
  if (directory === undefined) {
    cleanups.push(() => rm(databaseDirectory, { recursive: true, force: true }));
  }
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${join(databaseDirectory, "test.db")}` })
  });
  cleanups.push(() => prisma.$disconnect());
  await applyDatabaseMigrations(prisma);
  const repository = new PrismaAuditRepository(prisma);
  return {
    directory: databaseDirectory,
    prisma,
    repository,
    workflow: new WorkflowService(repository, repository)
  };
}

function schemaColumns(schema: string, model: string): string[] {
  const body = new RegExp(`model ${model} \\{([^}]*)\\}`, "u").exec(schema)?.[1];
  if (body === undefined) throw new Error(`Model ${model} is missing from schema.prisma.`);
  return body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("@@") && !line.startsWith("//"))
    .map((line) => line.split(/\s+/u)[0]!)
    .sort();
}

describe("workflow persistence on a real SQLite database", () => {
  it("creates every column that schema.prisma declares", async () => {
    const { prisma } = await openDatabase();
    const schema = await readFile(schemaPath, "utf8");
    for (const model of ["AuditLog", "WorkflowPreview"]) {
      const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${model}")`);
      expect(columns.map((column) => column.name).sort(), model).toEqual(schemaColumns(schema, model));
    }
  });

  it("applies migrations again without errors", async () => {
    const first = await openDatabase();
    await expect(applyDatabaseMigrations(first.prisma)).resolves.toBeUndefined();
  });

  it("previews, approves and executes a request exactly once", async () => {
    const { workflow, repository } = await openDatabase();
    const preview = await workflow.createPreview("CREATE", "Notion project page", "Create page", {
      title: "Plan"
    }, "mcp");
    expect((await workflow.listPending()).map((item) => item.preview.id)).toEqual([preview.id]);

    await workflow.approve(preview.id);
    let calls = 0;
    const execute = () => workflow.executeApproved(preview.id, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "page";
    });
    const results = await Promise.allSettled([execute(), execute()]);

    expect(results.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(calls).toBe(1);
    expect(await workflow.getStatus(preview.id)).toBe("EXECUTED");
    expect((await repository.get(preview.id))?.preview.source).toBe("mcp");
    expect((await repository.list()).map((record) => record.status).sort())
      .toEqual(["APPROVED", "EXECUTED", "PREVIEWED"]);
  });

  it("keeps approvals and rejections across a restart", async () => {
    const first = await openDatabase();
    const approved = await first.workflow.createPreview("CREATE", "Notion project page", "Create", { a: 1 });
    await first.workflow.approve(approved.id);
    const rejected = await first.workflow.createPreview("CREATE", "Notion project page", "Create", { a: 2 });
    await first.workflow.reject(rejected.id);
    await first.prisma.$disconnect();

    const second = await openDatabase(first.directory);
    expect((await second.workflow.listPending()).map((item) => [item.preview.id, item.status]))
      .toEqual([[approved.id, "APPROVED"]]);
    expect(await second.workflow.getStatus(rejected.id)).toBe("REJECTED");
    await expect(second.workflow.approve(rejected.id)).rejects.toThrow("was rejected");
    await expect(second.workflow.executeApproved(rejected.id, async () => "no")).rejects.toThrow();
    await expect(second.workflow.executeApproved(approved.id, async () => "done")).resolves.toBe("done");
  });

  it("lists only open previews, with all their fields, in one query", async () => {
    const { workflow, repository } = await openDatabase();
    const executed = await workflow.createPreview("CREATE", "Notion project page", "Done", { n: 1 });
    await workflow.approve(executed.id);
    await workflow.executeApproved(executed.id, async () => "page");
    const rejected = await workflow.createPreview("CREATE", "Notion project page", "No", { n: 2 });
    await workflow.reject(rejected.id);
    const approved = await workflow.createPreview("CREATE", "Notion project page", "Ready", { n: 3 }, "mcp");
    await workflow.approve(approved.id);
    const waiting = await workflow.createPreview("CREATE", "Notion project page", "Waiting", { n: 4 });

    const open = await repository.listOpenPreviews();

    expect(open.map((record) => record.preview.id).sort()).toEqual([approved.id, waiting.id].sort());
    expect(open.find((record) => record.preview.id === approved.id)).toMatchObject({
      preview: { summary: "Ready", payload: { n: 3 }, source: "mcp" },
      approvedAt: expect.any(String)
    });
  });
});

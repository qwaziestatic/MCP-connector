import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations } from "./migrations";

describe("embedded database migrations", () => {
  it("creates durable workflow previews and their execution state", async () => {
    const unsafeStatements: string[] = [];
    const prisma = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      $executeRawUnsafe: async (statement: string) => {
        unsafeStatements.push(statement);
        return 1;
      },
      $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    } as never;

    await applyDatabaseMigrations(prisma);

    expect(unsafeStatements.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "WorkflowPreview"'))).toBe(true);
    expect(unsafeStatements.some((statement) => statement.includes('ALTER TABLE "WorkflowPreview" ADD COLUMN "executingAt"'))).toBe(true);
  });
});

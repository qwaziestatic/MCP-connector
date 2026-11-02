import type { PrismaClient } from "@prisma/client";

export const migrations = [
  {
    id: "20261008220000_create_audit_log",
    statements: [
      `CREATE TABLE IF NOT EXISTS "AuditLog" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "action" TEXT NOT NULL,
        "target" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "previewJson" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"
       ON "AuditLog" ("createdAt")`
    ]
  },
  {
    id: "20261008220001_create_workflow_preview",
    statements: [
      `CREATE TABLE IF NOT EXISTS "WorkflowPreview" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "action" TEXT NOT NULL,
        "target" TEXT NOT NULL,
        "summary" TEXT NOT NULL,
        "payloadJson" TEXT NOT NULL,
        "requiresApproval" BOOLEAN NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "approvedAt" DATETIME,
        "rejectedAt" DATETIME,
        "executedAt" DATETIME,
        "failedAt" DATETIME
      )`,
      `CREATE INDEX IF NOT EXISTS "WorkflowPreview_createdAt_idx"
       ON "WorkflowPreview" ("createdAt")`
    ]
  },
  {
    id: "20261008220002_add_workflow_preview_executing_at",
    statements: [
      `ALTER TABLE "WorkflowPreview" ADD COLUMN "executingAt" DATETIME`
    ]
  },
  {
    id: "20261008220003_add_workflow_preview_source",
    statements: [
      `ALTER TABLE "WorkflowPreview" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ui'`
    ]
  }
] as const;

export async function applyDatabaseMigrations(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "_McpConnectorMigration" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  for (const migration of migrations) {
    const applied = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "_McpConnectorMigration"
      WHERE "id" = ${migration.id}
      LIMIT 1
    `;

    if (applied.length > 0) {
      continue;
    }

    const statements = migration.statements.map((statement) => prisma.$executeRawUnsafe(statement));
    await prisma.$transaction([
      ...statements,
      prisma.$executeRaw`
        INSERT INTO "_McpConnectorMigration" ("id")
        VALUES (${migration.id})
      `
    ]);
  }
}

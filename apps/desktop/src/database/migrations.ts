import type { PrismaClient } from "@prisma/client";

const migrations = [
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

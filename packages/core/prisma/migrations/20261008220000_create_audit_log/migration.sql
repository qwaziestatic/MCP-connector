-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "previewJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkflowPreview" (
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
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkflowPreview_createdAt_idx" ON "WorkflowPreview"("createdAt");

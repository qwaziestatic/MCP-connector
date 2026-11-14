-- AddColumn
ALTER TABLE "AuditLog" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ui';

-- Records written before this column kept their source inside previewJson.
UPDATE "AuditLog"
SET "source" = 'mcp'
WHERE CASE WHEN json_valid("previewJson")
  THEN COALESCE(json_extract("previewJson", '$.preview.source'), json_extract("previewJson", '$.source'))
END = 'mcp';

-- This non-destructive, idempotent migration replaces the historical unjournaled
-- 0102 file. Re-running it is safe where that orphan was applied manually.
INSERT INTO "goat"."brain_folders" ("id", "user_workos_id", "brain_ref", "path", "source")
SELECT
  'goat_brain_folder_' || substring(md5("brains"."id" || ':' || "defaults"."path"), 1, 24),
  "brains"."created_by_workos_id",
  "brains"."id",
  "defaults"."path",
  "defaults"."source"
FROM "goat"."brains" AS "brains"
CROSS JOIN (
  VALUES
    ('inbox', 'system'),
    ('people', 'system'),
    ('companies', 'system'),
    ('evidence', 'system'),
    ('projects', 'custom'),
    ('meetings', 'custom'),
    ('research', 'custom'),
    ('decisions', 'custom'),
    ('concepts', 'custom')
) AS "defaults"("path", "source")
ON CONFLICT ("brain_ref", "path") DO NOTHING;
--> statement-breakpoint
UPDATE "goat"."brain_folders"
SET "source" = CASE
  WHEN "path" IN ('inbox', 'people', 'companies', 'evidence') THEN 'system'
  ELSE 'custom'
END;

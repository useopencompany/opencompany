-- Goat Brain folder defaults: hard roots are system rows; core folders are
-- editable custom rows. Existing legacy defaults stay only when they contain
-- documents or already represent user-created structure.
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
--> statement-breakpoint
DELETE FROM "goat"."brain_folders" AS "folder"
WHERE "folder"."path" IN ('analysis', 'sources', 'media', 'writing', 'emails')
  AND NOT EXISTS (
    SELECT 1
    FROM "goat"."brain_documents" AS "document"
    WHERE "document"."brain_ref" = "folder"."brain_ref"
      AND (
        "document"."folder_path" = "folder"."path"
        OR "document"."folder_path" LIKE "folder"."path" || '/%'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "goat"."brain_folders" AS "child"
    WHERE "child"."brain_ref" = "folder"."brain_ref"
      AND "child"."path" LIKE "folder"."path" || '/%'
  );

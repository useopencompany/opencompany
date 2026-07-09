-- Add the thoughts folder as an adjustable default for existing Goat Brains.
INSERT INTO "goat"."brain_folders" ("id", "user_workos_id", "brain_ref", "path", "source")
SELECT
  'goat_brain_folder_' || substring(md5("brains"."id" || ':thoughts'), 1, 24),
  "brains"."created_by_workos_id",
  "brains"."id",
  'thoughts',
  'custom'
FROM "goat"."brains" AS "brains"
ON CONFLICT ("brain_ref", "path") DO NOTHING;

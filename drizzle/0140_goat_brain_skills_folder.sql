INSERT INTO "goat"."brain_folders" (
  "id",
  "user_workos_id",
  "brain_ref",
  "path",
  "source",
  "created_at",
  "updated_at"
)
SELECT
  'goat_brain_folder_' || substring(encode(sha256(convert_to(brain."id" || ':skills', 'UTF8')), 'hex') from 1 for 24),
  brain."created_by_workos_id",
  brain."id",
  'skills',
  'system',
  now(),
  now()
FROM "goat"."brains" AS brain
ON CONFLICT ("brain_ref", "path") DO UPDATE
SET
  "user_workos_id" = EXCLUDED."user_workos_id",
  "source" = 'system',
  "updated_at" = now();

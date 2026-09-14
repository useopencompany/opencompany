-- Tasks & Workflows left beta and is on for every user, so the per-user opt-in column goes away.
-- Forward-only: a code revert would read a missing column, so revert the migration with the app.
ALTER TABLE "goat"."users" DROP COLUMN IF EXISTS "task_spawning_enabled";

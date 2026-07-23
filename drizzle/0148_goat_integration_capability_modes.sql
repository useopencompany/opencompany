ALTER TABLE "goat"."integrations" ADD COLUMN IF NOT EXISTS "capability_modes" jsonb NOT NULL DEFAULT '{}'::jsonb;

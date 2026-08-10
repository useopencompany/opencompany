-- Adds source provenance to goat.skills so a skill can be imported from an
-- external SKILL.md (GitHub / skills.sh) instead of only hand-authored in
-- Goat. NULL source_type means unchanged, hand-authored behavior; imported
-- rows are read-only (enforced in apps/goat/lib/skills.ts, not the DB).
ALTER TABLE "goat"."skills" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD COLUMN "resolved_commit" text;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD COLUMN "integrity" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_skills_workspace_source_idx" ON "goat"."skills" ("workspace_id","source_url","source_ref","source_path") WHERE "source_type" IS NOT NULL AND "archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD CONSTRAINT "goat_skills_source_type_check" CHECK ("goat"."skills"."source_type" IS NULL OR "goat"."skills"."source_type" IN ('github', 'skills.sh')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."skills" ADD CONSTRAINT "goat_skills_source_url_required_check" CHECK ("goat"."skills"."source_type" IS NULL OR "goat"."skills"."source_url" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."skills" VALIDATE CONSTRAINT "goat_skills_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."skills" VALIDATE CONSTRAINT "goat_skills_source_url_required_check";

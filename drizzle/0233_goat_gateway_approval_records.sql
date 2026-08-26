ALTER TABLE "goat"."action_turns" ADD COLUMN "approval_records" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "goat"."action_turns"
SET "policy" = 'foregroundInteractive'
WHERE "policy" = 'cloudReadOnly';
--> statement-breakpoint
ALTER TABLE "goat"."action_turns" DROP CONSTRAINT "goat_action_turns_policy_check";
--> statement-breakpoint
ALTER TABLE "goat"."action_turns" ADD CONSTRAINT "goat_action_turns_policy_check" CHECK ("policy" IN ('foregroundInteractive', 'headless'));

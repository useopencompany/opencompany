ALTER TABLE "goat"."chat_session_skill_bundles" ADD COLUMN "name" text;
--> statement-breakpoint
UPDATE "goat"."chat_session_skill_bundles" AS "snapshot"
SET "name" = "bundle"."name"
FROM "goat"."skill_bundles" AS "bundle"
WHERE "bundle"."id" = "snapshot"."bundle_id";
--> statement-breakpoint
ALTER TABLE "goat"."chat_session_skill_bundles" ALTER COLUMN "name" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "goat_chat_session_skill_bundles_chat_name_idx" ON "goat"."chat_session_skill_bundles" USING btree ("chat_session_id","name");

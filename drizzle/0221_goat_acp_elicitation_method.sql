ALTER TABLE "goat"."codex_chat_interactions"
DROP CONSTRAINT "goat_codex_chat_interactions_method_check";
--> statement-breakpoint
UPDATE "goat"."codex_chat_interactions"
SET "method" = 'elicitation/create'
WHERE "method" = 'item/tool/requestUserInput';
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_interactions"
ADD CONSTRAINT "goat_codex_chat_interactions_method_check"
CHECK ("codex_chat_interactions"."method" = 'elicitation/create');

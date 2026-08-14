ALTER TABLE "goat"."knowledge_command_idempotency"
  DROP CONSTRAINT "goat_knowledge_command_idempotency_operation_check";--> statement-breakpoint
ALTER TABLE "goat"."knowledge_command_idempotency"
  ADD CONSTRAINT "goat_knowledge_command_idempotency_operation_check"
  CHECK ("goat"."knowledge_command_idempotency"."operation" IN ('brain_document.create', 'brain_asset.create', 'brain_asset.replace', 'wiki_page.create', 'wiki_timeline.create', 'skill.create', 'skill.import', 'brain_import.start'));

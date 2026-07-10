ALTER TABLE "goat"."chat_messages" ADD COLUMN IF NOT EXISTS "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "goat"."chat_messages" ADD COLUMN IF NOT EXISTS "attachment_texts" jsonb;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_format_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_format_check" CHECK ("goat"."brain_documents"."format" IN ('markdown', 'pdf', 'docx', 'xlsx', 'image'));

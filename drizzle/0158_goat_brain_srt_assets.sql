ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_format_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_format_check" CHECK ("goat"."brain_documents"."format" IN ('markdown', 'pdf', 'docx', 'xlsx', 'srt', 'image'));

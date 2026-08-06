ALTER TABLE "goat"."brain_documents" DROP CONSTRAINT IF EXISTS "goat_brain_documents_format_check";

ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_format_check" CHECK ("format" IN ('markdown', 'pdf', 'docx', 'xlsx', 'srt', 'csv', 'tsv', 'json', 'text', 'image'));

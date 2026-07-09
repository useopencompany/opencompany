-- Goat Brain binary assets (PDF v1): asset columns on brain_documents and the
-- "upload" ingestion provider. The blob bytes live in the private Vercel Blob
-- store; these columns carry the extracted text (search + agent context) and
-- the blob's own hash/size, which are distinct from the markdown projection's
-- content_hash/size_bytes.
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "asset_extracted_text" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "asset_content_hash" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "asset_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_provider_check" CHECK ("goat"."brain_source_items"."source_provider" IN ('jamie', 'goat-chat', 'upload'));--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" DROP CONSTRAINT IF EXISTS "goat_brain_source_items_source_type_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_source_items" ADD CONSTRAINT "goat_brain_source_items_source_type_check" CHECK ("goat"."brain_source_items"."source_type" IN ('meeting', 'capture', 'asset'));--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" DROP CONSTRAINT IF EXISTS "goat_brain_ingest_jobs_source_provider_check";--> statement-breakpoint
ALTER TABLE "goat"."brain_ingest_jobs" ADD CONSTRAINT "goat_brain_ingest_jobs_source_provider_check" CHECK ("goat"."brain_ingest_jobs"."source_provider" IN ('jamie', 'goat-chat', 'upload'));

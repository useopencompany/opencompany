CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "name_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- asset_extracted_text (0102) is folded in directly so PDF/DOCX extraction updates — which touch
-- only that column — reindex without having to recompose search_text.
ALTER TABLE "goat"."brain_documents" ADD COLUMN IF NOT EXISTS "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("search_text", '') || ' ' || coalesce("asset_extracted_text", ''))) STORED;--> statement-breakpoint
UPDATE "goat"."brain_documents" SET
  "name_text" = trim(concat_ws(' ',
    coalesce("title", ''),
    coalesce((SELECT string_agg(a.value, ' ') FROM jsonb_array_elements_text("aliases") AS a(value)), '')
  )),
  "search_text" = concat_ws(E'\n',
    coalesce("title", ''),
    coalesce((SELECT string_agg(a.value, ' ') FROM jsonb_array_elements_text("aliases") AS a(value)), ''),
    coalesce("body", ''),
    coalesce((SELECT string_agg(t.value->>'body', E'\n') FROM jsonb_array_elements("timeline") AS t(value)), ''),
    coalesce((SELECT string_agg((r.value->>'type') || ' ' || (r.value->>'to'), E'\n') FROM jsonb_array_elements("relations") AS r(value)), '')
  );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_documents_search_tsv_idx" ON "goat"."brain_documents" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_documents_name_trgm_idx" ON "goat"."brain_documents" USING gin ("name_text" gin_trgm_ops);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."brain_document_embeddings" (
	"document_id" text PRIMARY KEY NOT NULL REFERENCES "goat"."brain_documents"("id") ON DELETE CASCADE,
	"brain_ref" text NOT NULL REFERENCES "goat"."brains"("id") ON DELETE CASCADE,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_brain_document_embeddings_brain_ref_idx" ON "goat"."brain_document_embeddings" ("brain_ref");

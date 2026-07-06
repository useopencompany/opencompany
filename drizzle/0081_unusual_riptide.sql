ALTER TABLE "goat"."brain_documents" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "timeline" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "kind" text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "original_file_name" text;--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD COLUMN "asset_storage_key" text;--> statement-breakpoint
UPDATE "goat"."brain_documents"
SET
  "body" = btrim(
    replace(
      CASE
        WHEN strpos("content", '## Compiled truth') > 0 THEN
          substring(
            "content"
            FROM strpos("content", '## Compiled truth') + length('## Compiled truth')
            FOR CASE
              WHEN strpos("content", '## Timeline') > strpos("content", '## Compiled truth') THEN
                strpos("content", '## Timeline') - (strpos("content", '## Compiled truth') + length('## Compiled truth'))
              ELSE
                char_length("content")
            END
          )
        ELSE "content"
      END,
      '<!-- TIMELINE:BELOW - append only past this marker -->',
      ''
    )
  ),
  "kind" = 'markdown',
  "mime_type" = 'text/markdown';--> statement-breakpoint
WITH timeline_source AS (
  SELECT
    "id",
    CASE
      WHEN strpos("content", '## Timeline') > 0 THEN
        substring("content" FROM strpos("content", '## Timeline') + length('## Timeline'))
      ELSE
        ''
    END AS timeline_text
  FROM "goat"."brain_documents"
),
timeline_parts AS (
  SELECT
    "id",
    ord,
    CASE
      WHEN ord = 1 THEN regexp_replace(part, '^###\s+', '')
      ELSE part
    END AS entry_text
  FROM timeline_source,
    unnest(string_to_array(btrim(timeline_text), E'\n### ')) WITH ORDINALITY AS parts(part, ord)
  WHERE btrim(part) <> ''
),
timeline_entries AS (
  SELECT
    "id",
    ord,
    btrim(split_part(entry_text, E'\n', 1)) AS entry_at,
    btrim(substr(entry_text, length(split_part(entry_text, E'\n', 1)) + 2)) AS entry_body
  FROM timeline_parts
),
timeline_json AS (
  SELECT
    "id",
    jsonb_agg(jsonb_build_object('at', entry_at, 'body', entry_body) ORDER BY ord) AS entries
  FROM timeline_entries
  WHERE entry_at <> ''
  GROUP BY "id"
)
UPDATE "goat"."brain_documents"
SET "timeline" = COALESCE(timeline_json.entries, '[]'::jsonb)
FROM timeline_json
WHERE "goat"."brain_documents"."id" = timeline_json."id";--> statement-breakpoint
ALTER TABLE "goat"."brain_documents" ADD CONSTRAINT "goat_brain_documents_kind_check" CHECK ("goat"."brain_documents"."kind" IN ('markdown', 'pdf', 'docx'));

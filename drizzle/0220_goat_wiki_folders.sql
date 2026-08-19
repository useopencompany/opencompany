ALTER TABLE "goat"."wiki_pages"
ADD COLUMN "node_type" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_pages"
ADD CONSTRAINT "goat_wiki_pages_node_type_check"
CHECK ("goat"."wiki_pages"."node_type" IN ('page', 'folder'));--> statement-breakpoint
DROP INDEX "goat"."goat_wiki_pages_workspace_slug_idx";--> statement-breakpoint
DO $$
DECLARE
  existing_page "goat"."wiki_pages"%ROWTYPE;
  nested_page_id text;
BEGIN
  FOR existing_page IN
    SELECT page.*
    FROM "goat"."wiki_pages" page
    WHERE EXISTS (
      SELECT 1
      FROM "goat"."wiki_pages" child
      WHERE child."workspace_id" = page."workspace_id"
        AND child."path" LIKE page."path" || '/%'
    )
    ORDER BY length(page."path") DESC
  LOOP
    IF existing_page."content" <> '' THEN
      nested_page_id := gen_random_uuid()::text;
      INSERT INTO "goat"."wiki_pages" (
        "id", "workspace_id", "slug", "path", "node_type", "title", "kind",
        "content", "content_hash", "size_bytes", "format", "mime_type",
        "original_file_name", "asset_storage_key", "asset_extracted_text",
        "asset_content_hash", "asset_size_bytes", "created_by_workos_id",
        "updated_by_workos_id", "created_at", "updated_at"
      ) VALUES (
        nested_page_id, existing_page."workspace_id", existing_page."slug",
        existing_page."path" || '/' || existing_page."slug", 'page',
        existing_page."title", existing_page."kind", existing_page."content",
        existing_page."content_hash", existing_page."size_bytes", existing_page."format",
        existing_page."mime_type", existing_page."original_file_name",
        existing_page."asset_storage_key", existing_page."asset_extracted_text",
        existing_page."asset_content_hash", existing_page."asset_size_bytes",
        existing_page."created_by_workos_id", existing_page."updated_by_workos_id",
        existing_page."created_at", existing_page."updated_at"
      );

      UPDATE "goat"."wiki_timeline_entries"
      SET "page_id" = nested_page_id
      WHERE "page_id" = existing_page."id";

      UPDATE "goat"."wiki_page_versions"
      SET "page_id" = nested_page_id
      WHERE "page_id" = existing_page."id";

      INSERT INTO "goat"."wiki_page_versions" (
        "id", "workspace_id", "page_id", "slug", "path", "title", "kind",
        "content", "content_hash", "operation", "added_lines", "removed_lines",
        "actor_workos_id"
      ) VALUES (
        gen_random_uuid()::text, existing_page."workspace_id", nested_page_id,
        existing_page."slug", existing_page."path" || '/' || existing_page."slug",
        existing_page."title", existing_page."kind", existing_page."content",
        existing_page."content_hash", 'move', 0, 0, existing_page."updated_by_workos_id"
      );
    END IF;

    UPDATE "goat"."wiki_pages"
    SET "node_type" = 'folder',
        "content" = '',
        "content_hash" = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        "size_bytes" = 0,
        "format" = 'markdown',
        "mime_type" = NULL,
        "original_file_name" = NULL,
        "asset_storage_key" = NULL,
        "asset_extracted_text" = NULL,
        "asset_content_hash" = NULL,
        "asset_size_bytes" = NULL
    WHERE "id" = existing_page."id";
  END LOOP;
END $$;

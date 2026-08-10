-- Wiki (brain v2): one wiki per workspace, pages in a tree. `slug` is a page's
-- stable workspace-unique identity ([[wiki-links]] target slugs, so links
-- survive restructuring); `path` is its tree position as the ancestor slug
-- chain plus its own slug. Brain tables are untouched — the wiki ships behind
-- the per-user "wiki_enabled" preview flag while brain keeps running.
ALTER TABLE "goat"."users" ADD COLUMN IF NOT EXISTS "wiki_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."wiki_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"mime_type" text,
	"original_file_name" text,
	"asset_storage_key" text,
	"asset_extracted_text" text,
	"asset_content_hash" text,
	"asset_size_bytes" integer,
	"search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", '') || ' ' || coalesce("asset_extracted_text", ''))) STORED,
	"created_by_workos_id" text REFERENCES "goat"."users"("workos_user_id") ON DELETE SET NULL,
	"updated_by_workos_id" text REFERENCES "goat"."users"("workos_user_id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_wiki_pages_kind_check" CHECK ("kind" IN ('project', 'person', 'company', 'research', 'meeting', 'other')),
	CONSTRAINT "goat_wiki_pages_format_check" CHECK ("format" IN ('markdown', 'pdf', 'docx', 'xlsx', 'srt', 'csv', 'tsv', 'json', 'text', 'image'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_wiki_pages_workspace_slug_idx" ON "goat"."wiki_pages" ("workspace_id", "slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_wiki_pages_workspace_path_idx" ON "goat"."wiki_pages" ("workspace_id", "path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_pages_workspace_updated_idx" ON "goat"."wiki_pages" ("workspace_id", "updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_pages_search_tsv_idx" ON "goat"."wiki_pages" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_pages_title_trgm_idx" ON "goat"."wiki_pages" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
-- Append-only history: survives page deletion (page_id nulls out) and powers
-- undo plus the recent-changes feed. Line deltas are computed at write time so
-- "how much changed since X" is a pure aggregation.
CREATE TABLE IF NOT EXISTS "goat"."wiki_page_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"page_id" text REFERENCES "goat"."wiki_pages"("id") ON DELETE SET NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"operation" text NOT NULL,
	"added_lines" integer DEFAULT 0 NOT NULL,
	"removed_lines" integer DEFAULT 0 NOT NULL,
	"actor_workos_id" text REFERENCES "goat"."users"("workos_user_id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_wiki_page_versions_operation_check" CHECK ("operation" IN ('write', 'move', 'delete'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_page_versions_workspace_created_idx" ON "goat"."wiki_page_versions" ("workspace_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_page_versions_page_created_idx" ON "goat"."wiki_page_versions" ("page_id", "created_at");--> statement-breakpoint
-- Timeline entries live OUTSIDE the markdown body: agents only pay for
-- timeline tokens when they ask, and TipTap editing stays plain markdown.
CREATE TABLE IF NOT EXISTS "goat"."wiki_timeline_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"page_id" text NOT NULL REFERENCES "goat"."wiki_pages"("id") ON DELETE CASCADE,
	"at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"created_by_workos_id" text REFERENCES "goat"."users"("workos_user_id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_timeline_entries_page_at_idx" ON "goat"."wiki_timeline_entries" ("page_id", "at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_timeline_entries_workspace_at_idx" ON "goat"."wiki_timeline_entries" ("workspace_id", "at");--> statement-breakpoint
-- Derived link index rebuilt from a page's body on every write; `target` is a
-- page slug (which need not exist yet) or a source ref ("linear:issue:ENG-1").
CREATE TABLE IF NOT EXISTS "goat"."wiki_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"from_page_id" text NOT NULL REFERENCES "goat"."wiki_pages"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_wiki_links_kind_check" CHECK ("kind" IN ('page', 'source'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_wiki_links_from_kind_target_idx" ON "goat"."wiki_links" ("from_page_id", "kind", "target");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_wiki_links_workspace_kind_target_idx" ON "goat"."wiki_links" ("workspace_id", "kind", "target");

-- Makes a wiki a first-class entity. Before this migration `workspace_id` *was*
-- the wiki identity; after it, `goat.wikis` holds the named wiki (with its own
-- markdown instructions and access level) and every wiki table carries a
-- `wiki_id`.
--
-- Staged so it is safe on a populated database: create the entity, seed exactly
-- one default wiki per workspace, add `wiki_id` nullable, backfill it from
-- `workspace_id`, then constrain it. `workspace_id` is retained on every table —
-- it still scopes ingestion dedup and the workspace-level import projections.
--
-- One-way: the page identity index moves from (workspace_id, path) to
-- (wiki_id, path). Reverting the application leaves the additive columns and the
-- new index in place and keeps working, because every row's wiki_id points at
-- its workspace's default wiki.

CREATE TABLE "goat"."wikis" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"access" text DEFAULT 'workspace' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_wikis_access_check" CHECK ("goat"."wikis"."access" IN ('workspace', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "goat"."wiki_members" (
	"id" text PRIMARY KEY NOT NULL,
	"wiki_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"added_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."wikis" ADD CONSTRAINT "wikis_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wikis" ADD CONSTRAINT "wikis_created_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("created_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_members" ADD CONSTRAINT "wiki_members_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "goat"."wiki_members" ADD CONSTRAINT "wiki_members_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goat_wikis_workspace_slug_idx" ON "goat"."wikis" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_wikis_workspace_default_idx" ON "goat"."wikis" USING btree ("workspace_id") WHERE "goat"."wikis"."is_default";--> statement-breakpoint
CREATE INDEX "goat_wikis_workspace_idx" ON "goat"."wikis" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goat_wiki_members_wiki_user_idx" ON "goat"."wiki_members" USING btree ("wiki_id","user_workos_id");--> statement-breakpoint
CREATE INDEX "goat_wiki_members_user_idx" ON "goat"."wiki_members" USING btree ("user_workos_id");--> statement-breakpoint

-- Exactly one default wiki per existing workspace. Deterministic id so a rerun
-- of this migration on a partially migrated database is a no-op.
INSERT INTO goat.wikis (id, workspace_id, name, slug, access, is_default, created_by_workos_id)
SELECT
  'goat_wiki_default_' || workspace."id",
  workspace."id",
  'Wiki',
  'wiki',
  'workspace',
  true,
  workspace."created_by_workos_id"
FROM goat.workspaces AS workspace
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

ALTER TABLE "goat"."wiki_sources" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_event_claims" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_pages" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_page_versions" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_timeline_entries" ADD COLUMN "wiki_id" text;--> statement-breakpoint
ALTER TABLE "goat"."wiki_links" ADD COLUMN "wiki_id" text;--> statement-breakpoint

UPDATE goat.wiki_sources AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_source_items AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_ingest_jobs AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_source_event_claims AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_pages AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_page_versions AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_timeline_entries AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint
UPDATE goat.wiki_links AS target SET wiki_id = wiki."id" FROM goat.wikis AS wiki WHERE wiki."workspace_id" = target."workspace_id" AND wiki."is_default" AND target."wiki_id" IS NULL;--> statement-breakpoint

ALTER TABLE "goat"."wiki_sources" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_event_claims" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_pages" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_page_versions" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_timeline_entries" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."wiki_links" ALTER COLUMN "wiki_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "goat"."wiki_sources" ADD CONSTRAINT "wiki_sources_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_items" ADD CONSTRAINT "wiki_source_items_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_ingest_jobs" ADD CONSTRAINT "wiki_ingest_jobs_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_source_event_claims" ADD CONSTRAINT "wiki_source_event_claims_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_pages" ADD CONSTRAINT "wiki_pages_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_page_versions" ADD CONSTRAINT "wiki_page_versions_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_timeline_entries" ADD CONSTRAINT "wiki_timeline_entries_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goat"."wiki_links" ADD CONSTRAINT "wiki_links_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Page identity is now (wiki_id, path): two wikis can hold the same path.
DROP INDEX IF EXISTS "goat"."goat_wiki_pages_workspace_path_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_wiki_pages_workspace_updated_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_wiki_page_versions_workspace_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_wiki_timeline_entries_workspace_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "goat"."goat_wiki_links_workspace_kind_target_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "goat_wiki_pages_wiki_path_idx" ON "goat"."wiki_pages" USING btree ("wiki_id","path");--> statement-breakpoint
CREATE INDEX "goat_wiki_pages_wiki_updated_idx" ON "goat"."wiki_pages" USING btree ("wiki_id","updated_at");--> statement-breakpoint
CREATE INDEX "goat_wiki_page_versions_wiki_created_idx" ON "goat"."wiki_page_versions" USING btree ("wiki_id","created_at");--> statement-breakpoint
CREATE INDEX "goat_wiki_timeline_entries_wiki_at_idx" ON "goat"."wiki_timeline_entries" USING btree ("wiki_id","at");--> statement-breakpoint
CREATE INDEX "goat_wiki_links_wiki_kind_target_idx" ON "goat"."wiki_links" USING btree ("wiki_id","kind","target");--> statement-breakpoint
CREATE INDEX "opencompany_wiki_sources_wiki_idx" ON "goat"."wiki_sources" USING btree ("wiki_id");--> statement-breakpoint
CREATE INDEX "opencompany_wiki_source_items_wiki_idx" ON "goat"."wiki_source_items" USING btree ("wiki_id");--> statement-breakpoint
CREATE INDEX "opencompany_wiki_ingest_jobs_wiki_idx" ON "goat"."wiki_ingest_jobs" USING btree ("wiki_id");--> statement-breakpoint
CREATE INDEX "opencompany_wiki_source_event_claims_wiki_idx" ON "goat"."wiki_source_event_claims" USING btree ("wiki_id");

-- Project wikis shipped before the product scope was decided. Delete only wikis attached through
-- the Project association, including their cascading content, then remove that association. Wikis
-- created independently remain untouched even when their ids happen to use the same prefix.
WITH project_wikis AS MATERIALIZED (
  SELECT DISTINCT "wiki_id"
  FROM "goat"."projects"
  WHERE "wiki_id" IS NOT NULL
)
DELETE FROM "goat"."wikis" AS wiki
USING project_wikis
WHERE wiki."id" = project_wikis."wiki_id";--> statement-breakpoint
ALTER TABLE "goat"."projects" DROP CONSTRAINT "projects_wiki_id_wikis_id_fk";--> statement-breakpoint
DROP INDEX "goat"."opencompany_projects_wiki_idx";--> statement-breakpoint
ALTER TABLE "goat"."projects" DROP COLUMN "wiki_id";

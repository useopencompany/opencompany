-- Give every sidebar Project a private wiki. Existing Projects get a deterministic wiki and
-- membership so the backfill is safe to retry; new Projects use a deterministic wiki id in the
-- application. The association stays nullable so a retry can repair a request interrupted between
-- claiming a client-generated Project id and attaching its wiki.

ALTER TABLE "goat"."projects" ADD COLUMN "wiki_id" text;--> statement-breakpoint

INSERT INTO "goat"."wikis" (
  "id",
  "workspace_id",
  "name",
  "slug",
  "instructions",
  "access",
  "is_default",
  "created_by_workos_id",
  "created_at",
  "updated_at"
)
SELECT
  'wiki_project_' || md5(project."id"),
  project."workspace_id",
  project."name",
  'project-' || md5(project."id"),
  '',
  'restricted',
  false,
  project."user_workos_id",
  project."created_at",
  project."updated_at"
FROM "goat"."projects" AS project
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

INSERT INTO "goat"."wiki_members" (
  "id",
  "wiki_id",
  "user_workos_id",
  "added_by_workos_id",
  "created_at"
)
SELECT
  'goat_wkm_project_' || md5(project."id"),
  'wiki_project_' || md5(project."id"),
  project."user_workos_id",
  project."user_workos_id",
  project."created_at"
FROM "goat"."projects" AS project
ON CONFLICT ("wiki_id", "user_workos_id") DO NOTHING;--> statement-breakpoint

UPDATE "goat"."projects" AS project
SET "wiki_id" = 'wiki_project_' || md5(project."id")
WHERE project."wiki_id" IS NULL;--> statement-breakpoint

ALTER TABLE "goat"."projects" ADD CONSTRAINT "projects_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "goat"."wikis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opencompany_projects_wiki_idx" ON "goat"."projects" USING btree ("wiki_id");

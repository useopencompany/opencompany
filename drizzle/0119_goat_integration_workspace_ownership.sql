-- Integration ownership model: connections are owned by a principal — a user
-- (identity-bound OAuth: gmail, google_calendar, slack user token, linear) or
-- a workspace (installation-bound: github app installs, jamie webhooks).
-- workspace_id set = workspace-owned; user_workos_id stays as the connecting
-- user (attribution + credential AAD). shared_with_workspace is foundation for
-- offering personal connections to workspace admins later (no UI yet).
ALTER TABLE "goat"."integrations" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD COLUMN IF NOT EXISTS "shared_with_workspace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goat"."integrations" ADD CONSTRAINT "integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill installation-bound providers to workspace ownership. Prefer the
-- workspace of a brain the integration already feeds; otherwise the connecting
-- user's earliest workspace membership. Owners without any workspace keep the
-- row personal (should not happen; connect flows require a workspace context).
UPDATE "goat"."integrations" i
SET "workspace_id" = COALESCE(
  (
    SELECT b."workspace_id"
    FROM "goat"."brain_sources" bs
    JOIN "goat"."brains" b ON b."id" = bs."brain_id"
    WHERE bs."integration_id" = i."id"
    ORDER BY bs."created_at"
    LIMIT 1
  ),
  (
    SELECT wm."workspace_id"
    FROM "goat"."workspace_members" wm
    WHERE wm."user_workos_id" = i."user_workos_id"
    ORDER BY wm."created_at"
    LIMIT 1
  )
)
WHERE i."provider" IN ('github', 'jamie') AND i."workspace_id" IS NULL;--> statement-breakpoint
-- Two admins may have connected the same external account (e.g. the same
-- GitHub installation) before workspace ownership existed. Keep the freshest
-- row workspace-owned; older duplicates fall back to personal so the unique
-- index below can be created.
UPDATE "goat"."integrations" i
SET "workspace_id" = NULL
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "workspace_id", "provider", "external_id"
    ORDER BY "updated_at" DESC, "id"
  ) AS rn
  FROM "goat"."integrations"
  WHERE "workspace_id" IS NOT NULL
) ranked
WHERE i."id" = ranked."id" AND ranked.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_integrations_workspace_provider_external_idx" ON "goat"."integrations" ("workspace_id","provider","external_id") WHERE "goat"."integrations"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_integrations_workspace_provider_idx" ON "goat"."integrations" ("workspace_id","provider");--> statement-breakpoint
-- Personal uniqueness becomes partial: a workspace-owned row must not block
-- the same admin from holding the account in another workspace, nor be picked
-- as the arbiter for personal-connection upserts.
DROP INDEX IF EXISTS "goat"."goat_integrations_user_provider_external_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_integrations_user_provider_external_idx" ON "goat"."integrations" ("user_workos_id","provider","external_id") WHERE "goat"."integrations"."workspace_id" IS NULL;

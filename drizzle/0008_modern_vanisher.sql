ALTER TABLE "workspace_memberships" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workos_organization_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_workos_organization_id_idx" ON "workspaces" USING btree ("workos_organization_id");
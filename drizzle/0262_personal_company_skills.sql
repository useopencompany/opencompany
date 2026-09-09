ALTER TABLE goat.skill_installations ADD COLUMN scope text NOT NULL DEFAULT 'company';
--> statement-breakpoint
ALTER TABLE goat.skill_installations ADD COLUMN created_by_user_id text;
--> statement-breakpoint
ALTER TABLE goat.skill_installations ALTER COLUMN scope SET DEFAULT 'personal';
--> statement-breakpoint
ALTER TABLE goat.skill_installations ADD CONSTRAINT skill_installations_scope_check CHECK (scope IN ('personal', 'company') AND (scope = 'company' OR created_by_user_id IS NOT NULL));
--> statement-breakpoint
DROP INDEX goat.skill_installations_workspace_live_name_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX skill_installations_workspace_live_name_idx ON goat.skill_installations (workspace_id, name) WHERE archived_at IS NULL AND scope = 'company';
--> statement-breakpoint
CREATE UNIQUE INDEX skill_installations_personal_live_name_idx ON goat.skill_installations (workspace_id, created_by_user_id, name) WHERE archived_at IS NULL AND scope = 'personal';
--> statement-breakpoint
CREATE TABLE goat.skill_installation_versions (
  company_shared boolean NOT NULL DEFAULT false,
  installation_id text NOT NULL REFERENCES goat.skill_installations(id) ON DELETE CASCADE,
  bundle_id text NOT NULL REFERENCES goat.skill_bundles(id) ON DELETE RESTRICT,
  PRIMARY KEY (installation_id, bundle_id)
);
--> statement-breakpoint
CREATE INDEX skill_installation_versions_bundle_idx ON goat.skill_installation_versions (bundle_id);
--> statement-breakpoint
-- All existing standalone revisions were shared in their workspace. Keep that lineage, including
-- archived installations, so existing Chat and Workflow snapshots remain usable.
INSERT INTO goat.skill_installation_versions (installation_id, bundle_id, company_shared)
SELECT installation.id, bundle.id, true
FROM goat.skill_installations installation
JOIN goat.skill_bundles bundle ON bundle.workspace_id = installation.workspace_id AND bundle.name = installation.name
ON CONFLICT DO NOTHING;

ALTER TABLE goat.skill_installations ADD COLUMN scope text NOT NULL DEFAULT 'company';
--> statement-breakpoint
ALTER TABLE goat.skill_installations ADD COLUMN created_by_user_id text;
--> statement-breakpoint
CREATE TABLE goat.skill_scope_rollout (
  id text PRIMARY KEY,
  personal_enabled boolean NOT NULL DEFAULT false,
  activated_at timestamp with time zone,
  activated_release text,
  CONSTRAINT skill_scope_rollout_id_check CHECK (id = 'personal_skills'),
  CONSTRAINT skill_scope_rollout_activation_check CHECK ((personal_enabled AND activated_at IS NOT NULL AND activated_release IS NOT NULL) OR (NOT personal_enabled AND activated_at IS NULL AND activated_release IS NULL))
);
--> statement-breakpoint
INSERT INTO goat.skill_scope_rollout (id) VALUES ('personal_skills');
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
CREATE FUNCTION goat.record_skill_installation_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO goat.skill_installation_versions (installation_id, bundle_id, company_shared)
  VALUES (NEW.id, NEW.bundle_id, NEW.scope = 'company')
  ON CONFLICT (installation_id, bundle_id) DO UPDATE
  SET company_shared = goat.skill_installation_versions.company_shared OR EXCLUDED.company_shared;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER skill_installations_record_version
AFTER INSERT OR UPDATE OF bundle_id, scope ON goat.skill_installations
FOR EACH ROW EXECUTE FUNCTION goat.record_skill_installation_version();
--> statement-breakpoint
-- All existing standalone revisions were shared in their workspace. Keep that lineage, including
-- archived installations, so existing Chat and Workflow snapshots remain usable.
INSERT INTO goat.skill_installation_versions (installation_id, bundle_id, company_shared)
SELECT installation.id, bundle.id, true
FROM goat.skill_installations installation
JOIN goat.skill_bundles bundle ON bundle.workspace_id = installation.workspace_id AND bundle.name = installation.name
ON CONFLICT DO NOTHING;

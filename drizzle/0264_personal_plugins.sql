-- Expand ownership without assigning legacy credentials, installations, or private data.
-- NULL/empty owners identify quarantined legacy records and are never valid personal readers.
ALTER TABLE goat.plugins ADD COLUMN owner_user_id text REFERENCES goat.users(workos_user_id) ON DELETE CASCADE;
--> statement-breakpoint
DROP INDEX goat.plugins_workspace_live_name_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX plugins_workspace_live_name_idx ON goat.plugins (workspace_id, owner_user_id, name) WHERE status <> 'archived';
--> statement-breakpoint
ALTER TABLE goat.workspace_plugin_data ADD COLUMN owner_user_id text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE goat.workspace_plugin_data ALTER COLUMN owner_user_id DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE goat.workspace_plugin_data DROP CONSTRAINT goat_workspace_plugin_data_workspace_id_plugin_name_pk;
--> statement-breakpoint
ALTER TABLE goat.workspace_plugin_data ADD CONSTRAINT goat_workspace_plugin_data_workspace_id_owner_user_id_plugin_name_pk PRIMARY KEY (workspace_id, owner_user_id, plugin_name);
--> statement-breakpoint
ALTER TABLE goat.infisical_connections ADD COLUMN owner_user_id text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE goat.infisical_connections ALTER COLUMN owner_user_id DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE goat.infisical_connections DROP CONSTRAINT infisical_connections_pkey;
--> statement-breakpoint
ALTER TABLE goat.infisical_connections ADD CONSTRAINT goat_infisical_connections_workspace_id_owner_user_id_pk PRIMARY KEY (workspace_id, owner_user_id);
--> statement-breakpoint
CREATE TABLE goat.plugin_ownership_rollout (
  id text PRIMARY KEY,
  personal_enabled boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
INSERT INTO goat.plugin_ownership_rollout (id) VALUES ('personal_plugins');

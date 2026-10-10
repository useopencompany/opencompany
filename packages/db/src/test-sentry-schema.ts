import { readFile } from "node:fs/promises";
import { snapshotPGliteSchema } from "./test-schema-snapshot";
export function snapshotSentryTestSchema() {
  return snapshotPGliteSchema(async (database) => {
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY, onboarded_at timestamptz);
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text);
      CREATE TABLE goat.integrations (id text PRIMARY KEY, provider text CONSTRAINT goat_integrations_provider_check CHECK (provider IN ('github_app','linear')), workspace_id text, user_workos_id text, status text, status_reason text, external_id text, company_agent_id text, shared_with_workspace boolean DEFAULT false, slack_app_id text, account_name text, account_type text, account_email text, connection_label text, scopes jsonb DEFAULT '[]', capability_modes jsonb DEFAULT '{}', tool_modes jsonb DEFAULT '{}', last_synced_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE goat.integration_credentials (id text PRIMARY KEY, user_workos_id text, integration_id text, provider text CONSTRAINT goat_integration_credentials_provider_check CHECK (provider = 'github_app'), kind text, encrypted_payload jsonb, encryption_key_version int, expires_at timestamptz, last_rotated_at timestamptz, refresh_lease_until timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(integration_id,kind));
      CREATE TABLE goat.integration_resources (provider text CONSTRAINT goat_integration_resources_provider_check CHECK (provider = 'linear'));
      CREATE TABLE goat.plugins (workspace_id text, owner_user_id text, name text, status text, archived_at timestamptz, events jsonb, event_modes jsonb);
      CREATE TABLE goat.workflows (id text PRIMARY KEY, workspace_id text, slug text, name text, trigger text, status text, scope text DEFAULT 'company', kind text DEFAULT 'workflow', archived_at timestamptz, automation_triggers jsonb DEFAULT '[]', event_user_workos_id text, event_config jsonb, event_harness_spec jsonb, event_activated_at timestamptz);
      CREATE TABLE goat.tasks (id text PRIMARY KEY, status text DEFAULT 'queued', result text, session_id text, updated_at timestamptz DEFAULT now(), agent_id text);
      CREATE TABLE goat.session_pull_requests (url text, chat_session_id text);
      CREATE TABLE goat.workflow_event_runs (id text PRIMARY KEY, workflow_id text REFERENCES goat.workflows(id), trigger_id text, workspace_id text, user_workos_id text, workflow_slug text, workflow_name text, provider text, event_type text, delivery_id text, goal text, harness_spec jsonb, event_at timestamptz, task_id text REFERENCES goat.tasks(id), status text DEFAULT 'pending', attempt_count int DEFAULT 0, next_attempt_at timestamptz DEFAULT now(), last_error text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(workflow_id,trigger_id,provider,delivery_id));
    `);
    const migration = await readFile(
      new URL("../../../drizzle/0314_sentry_public_integration.sql", import.meta.url),
      "utf8",
    );
    await database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  });
}

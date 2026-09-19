CREATE TABLE goat.slack_provisioning_connections (
  workspace_id text PRIMARY KEY REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  team_id text NOT NULL UNIQUE,
  team_name text NOT NULL,
  authorized_by text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  encrypted_payload jsonb NOT NULL,
  encryption_key_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'connected',
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE goat.slack_provisioning_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
  encrypted_payload jsonb NOT NULL,
  encryption_key_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
CREATE TABLE goat.slack_agent_provisioning (
  agent_id text PRIMARY KEY REFERENCES goat.workflows(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  team_id text NOT NULL,
  app_id text,
  state text NOT NULL DEFAULT 'queued',
  reason text,
  encrypted_payload jsonb,
  encryption_key_version integer NOT NULL DEFAULT 1,
  profile_hash text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The old default described cosmetic Slack output, not consent to create an app.
UPDATE goat.workflows AS agent SET slack_channel_enabled = false
WHERE kind = 'agent' AND NOT EXISTS (
  SELECT 1 FROM goat.integrations i WHERE i.company_agent_id = agent.id AND i.status <> 'disconnected'
);

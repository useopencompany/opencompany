-- Sentry provider support. Existing provider contracts are preserved.
ALTER TABLE goat.integrations DROP CONSTRAINT goat_integrations_provider_check;
--> statement-breakpoint
ALTER TABLE goat.integrations ADD CONSTRAINT goat_integrations_provider_check CHECK (provider IN ('gmail','google_admin','google_calendar','google_drive','linear','github','github_app','github_user','jamie','slack','slack_bot','hubspot','granola','fathom','attio','betterstack','convex','render','vercel','signoz','dash0','stripe','latitude','posthog','neon','notion','supabase','resend','todoist','x_account','custom_mcp','sentry'));
--> statement-breakpoint
ALTER TABLE goat.integration_credentials DROP CONSTRAINT goat_integration_credentials_provider_check;
--> statement-breakpoint
ALTER TABLE goat.integration_credentials ADD CONSTRAINT goat_integration_credentials_provider_check CHECK (provider IN ('gmail','google_admin','google_calendar','google_drive','linear','github','github_app','github_user','jamie','slack','slack_bot','hubspot','granola','fathom','attio','betterstack','convex','render','vercel','signoz','dash0','stripe','latitude','posthog','neon','notion','supabase','resend','todoist','x_account','custom_mcp','sentry'));
--> statement-breakpoint
ALTER TABLE goat.integration_resources DROP CONSTRAINT goat_integration_resources_provider_check;
--> statement-breakpoint
ALTER TABLE goat.integration_resources ADD CONSTRAINT goat_integration_resources_provider_check CHECK (provider IN ('gmail','google_admin','google_calendar','google_drive','linear','github','github_app','github_user','jamie','slack','hubspot','granola','fathom','attio','betterstack','convex','render','vercel','signoz','dash0','stripe','latitude','posthog','neon','notion','supabase','resend','todoist','x_account','custom_mcp','sentry'));
--> statement-breakpoint
CREATE TABLE goat.sentry_connections (
  integration_id text PRIMARY KEY REFERENCES goat.integrations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL UNIQUE REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  installation_id text NOT NULL UNIQUE,
  organization_id text NOT NULL,
  organization_slug text NOT NULL,
  region text NOT NULL CONSTRAINT sentry_connections_region_check CHECK (region IN ('us','eu')),
  selected_project_ids jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT sentry_connections_projects_check CHECK (jsonb_typeof(selected_project_ids) = 'array'),
  cooldown_minutes integer NOT NULL DEFAULT 30,
  daily_cap integer NOT NULL DEFAULT 25,
  revoked_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT sentry_connections_limits_check CHECK (cooldown_minutes BETWEEN 0 AND 10080 AND daily_cap BETWEEN 0 AND 1000)
);
--> statement-breakpoint
CREATE TABLE goat.sentry_webhook_receipts (
  id text PRIMARY KEY,
  installation_id text NOT NULL,
  resource text NOT NULL,
  payload jsonb NOT NULL,
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending',
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  selected_event_id text,
  evidence jsonb
);
--> statement-breakpoint
CREATE INDEX sentry_webhook_receipts_pending_idx ON goat.sentry_webhook_receipts(status, next_attempt_at);
--> statement-breakpoint
CREATE INDEX sentry_webhook_receipts_installation_idx ON goat.sentry_webhook_receipts(installation_id, received_at);
--> statement-breakpoint
CREATE TABLE goat.sentry_issue_runs (
  event_run_id text PRIMARY KEY REFERENCES goat.workflow_event_runs(id) ON DELETE CASCADE,
  receipt_id text NOT NULL REFERENCES goat.sentry_webhook_receipts(id),
  integration_id text NOT NULL REFERENCES goat.integrations(id),
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  workflow_id text NOT NULL REFERENCES goat.workflows(id) ON DELETE CASCADE,
  issue_id text NOT NULL,
  project_id text NOT NULL,
  trigger_filters jsonb NOT NULL,
  task_id text REFERENCES goat.tasks(id) ON DELETE SET NULL,
  started_at timestamptz
);
--> statement-breakpoint
CREATE INDEX sentry_issue_runs_issue_idx ON goat.sentry_issue_runs(workspace_id, workflow_id, issue_id, started_at);

ALTER TABLE goat.integrations ADD COLUMN company_agent_id text REFERENCES goat.workflows(id) ON DELETE CASCADE;
ALTER TABLE goat.integrations ADD COLUMN slack_app_id text;
ALTER TABLE goat.integrations ADD CONSTRAINT integrations_company_agent_check CHECK (
  (company_agent_id IS NULL AND slack_app_id IS NULL) OR
  (company_agent_id IS NOT NULL AND slack_app_id IS NOT NULL AND workspace_id IS NOT NULL AND provider = 'slack_bot')
);
DROP INDEX goat.goat_integrations_workspace_provider_external_idx;
CREATE UNIQUE INDEX goat_integrations_workspace_provider_external_idx ON goat.integrations(workspace_id, provider, external_id)
  WHERE workspace_id IS NOT NULL AND company_agent_id IS NULL;
DROP INDEX goat.goat_integrations_slack_bot_workspace_idx;
CREATE UNIQUE INDEX goat_integrations_slack_bot_workspace_idx ON goat.integrations(workspace_id, provider)
  WHERE workspace_id IS NOT NULL AND provider = 'slack_bot' AND company_agent_id IS NULL;
CREATE UNIQUE INDEX integrations_company_agent_idx ON goat.integrations(company_agent_id);
CREATE UNIQUE INDEX integrations_slack_agent_app_idx ON goat.integrations(external_id, slack_app_id) WHERE company_agent_id IS NOT NULL;

CREATE TABLE goat.slack_agent_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_id text NOT NULL REFERENCES goat.integrations(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  message_ts text NOT NULL,
  slack_user_id text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'ignored')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX slack_agent_messages_message_idx ON goat.slack_agent_messages(integration_id, channel_id, message_ts);
CREATE INDEX slack_agent_messages_pending_idx ON goat.slack_agent_messages(next_attempt_at, id) WHERE status = 'pending';

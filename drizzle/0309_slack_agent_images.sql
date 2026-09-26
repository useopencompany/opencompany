ALTER TABLE goat.slack_agent_messages
  ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT slack_agent_messages_files_check CHECK (jsonb_typeof(files) = 'array');

UPDATE goat.integrations
SET status = 'needs_reauth',
    status_reason = 'Reconnect this agent to let it read attached Slack images.',
    updated_at = now()
WHERE company_agent_id IS NOT NULL
  AND provider = 'slack_bot'
  AND status = 'connected'
  AND NOT (scopes ? 'files:read');

UPDATE goat.slack_agent_provisioning AS job
SET state = 'created', reason = NULL, lease_until = NULL, updated_at = now()
FROM goat.integrations AS integration
WHERE integration.company_agent_id = job.agent_id
  AND integration.status = 'needs_reauth'
  AND NOT (integration.scopes ? 'files:read')
  AND job.state = 'ready';

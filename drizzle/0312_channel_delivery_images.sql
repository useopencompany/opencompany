-- Images a queued Slack post shows under its text, as pinned artifact version IDs. Existing rows
-- default to no images and deliver exactly as before.
ALTER TABLE goat.channel_deliveries
  ADD COLUMN image_artifact_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT channel_deliveries_images_check CHECK (jsonb_typeof(image_artifact_version_ids) = 'array');

-- Managed company-agent apps reinstall themselves with the new manifest scope. The installation
-- stays connected meanwhile; until the reinstall lands its posts link to the task for images.
UPDATE goat.slack_agent_provisioning AS job
SET state = 'created', reason = NULL, lease_until = NULL, updated_at = now()
FROM goat.integrations AS integration
WHERE integration.company_agent_id = job.agent_id
  AND integration.provider = 'slack_bot'
  AND integration.status = 'connected'
  AND NOT (integration.scopes ? 'files:write')
  AND job.state = 'ready';

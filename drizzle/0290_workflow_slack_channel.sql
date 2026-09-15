-- Per-workflow Slack channel toggle and cosmetic bot identity.
--
-- Every existing workflow implicitly had the Slack send tool, so the toggle defaults to true and
-- behavior does not change silently for rows written before the Channels section existed. The
-- display name is a cosmetic chat.postMessage `username` override; empty keeps the default bot.
ALTER TABLE "goat"."workflows"
	ADD COLUMN "slack_channel_enabled" boolean DEFAULT true NOT NULL,
	ADD COLUMN "slack_bot_display_name" text DEFAULT '' NOT NULL;

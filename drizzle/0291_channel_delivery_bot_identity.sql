-- The workflow's cosmetic Slack name is snapshotted onto the queued delivery, so editing the
-- workflow cannot retroactively change how an already-queued post is attributed in Slack.
ALTER TABLE "goat"."channel_deliveries"
	ADD COLUMN "bot_display_name" text DEFAULT '' NOT NULL;

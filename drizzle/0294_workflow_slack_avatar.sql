-- Public HTTPS avatar for a workflow's cosmetic Slack identity. Snapshot it with each queued
-- delivery so later workflow edits cannot change an already-created delivery.
ALTER TABLE "goat"."workflows"
	ADD COLUMN "slack_bot_avatar_url" text DEFAULT '' NOT NULL;

ALTER TABLE "goat"."channel_deliveries"
	ADD COLUMN "bot_avatar_url" text DEFAULT '' NOT NULL;

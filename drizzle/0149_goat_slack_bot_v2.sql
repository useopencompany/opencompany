-- Slack answer bot v2: threads the bot has replied in, so the message-event
-- webhook can decide with one indexed lookup whether a reply-without-mention
-- should get an answer. Rows upsert on each bot reply and are pruned after
-- ~30 days of thread inactivity.
CREATE TABLE IF NOT EXISTS "goat"."slack_bot_thread_participation" (
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"integration_id" text NOT NULL,
	"last_bot_reply_ts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_bot_thread_participation_pkey" PRIMARY KEY ("team_id","channel_id","thread_ts"),
	CONSTRAINT "slack_bot_thread_participation_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "goat"."integrations"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "goat_sbtp_updated_at_idx" ON "goat"."slack_bot_thread_participation" ("updated_at");--> statement-breakpoint

-- Slack sender → goat user mapping resolves by email on every bot event; the
-- users table previously had no email index.
CREATE INDEX IF NOT EXISTS "goat_users_email_lower_idx" ON "goat"."users" (lower("email"));

-- One answer-bot installation per Goat workspace. Reinstalling for another
-- Slack team updates the existing integration and preserves its brain routes.
-- Abort instead of guessing which installation and dependent routes should be
-- kept if a preview database already contains duplicates.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "goat"."integrations"
		WHERE "workspace_id" IS NOT NULL AND "provider" = 'slack_bot'
		GROUP BY "workspace_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Cannot enforce one Goat Slack bot per workspace: reconcile duplicate installations and their brain routes first.';
	END IF;
END
$$;--> statement-breakpoint

CREATE UNIQUE INDEX "goat_integrations_slack_bot_workspace_idx" ON "goat"."integrations" ("workspace_id","provider") WHERE "workspace_id" IS NOT NULL AND "provider" = 'slack_bot';--> statement-breakpoint

-- Slack retries failed HTTP deliveries. This lease deduplicates concurrent
-- deliveries by Slack's globally unique event_id while allowing a delivery to
-- be reclaimed with a safety margin after the web task's maximum runtime.
CREATE TABLE "goat"."slack_bot_event_claims" (
	"event_id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

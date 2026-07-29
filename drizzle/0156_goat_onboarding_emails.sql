-- Founder onboarding email drip (Resend). One row per (owner, step); a cron
-- sweep claims due `pending` rows (status flips to `sending` under a soft lease
-- keyed on updated_at), sends via Resend, then marks `sent`. The unique
-- (user, step) index makes enrollment idempotent and gives each send a stable
-- Resend idempotency key. Only workspace owners are enrolled — invited members
-- never reach the create-default-workspace branch that triggers enrollment.
CREATE TABLE IF NOT EXISTS "goat"."onboarding_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workos_user_id" text NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_emails_workos_user_id_users_workos_user_id_fk" FOREIGN KEY ("workos_user_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "goat_onboarding_emails_step_check" CHECK ("goat"."onboarding_emails"."step" IN ('welcome', 'checkin', 'feedback_call')),
	CONSTRAINT "goat_onboarding_emails_status_check" CHECK ("goat"."onboarding_emails"."status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "goat_onboarding_emails_user_step_idx" ON "goat"."onboarding_emails" ("workos_user_id","step");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "goat_onboarding_emails_status_scheduled_idx" ON "goat"."onboarding_emails" ("status","scheduled_at");

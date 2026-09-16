-- Pull requests a coding-agent session opened. Additive: a session without a PR simply has no row,
-- which is what every existing session reads as. `state` caches GitHub's answer and `checked_at`
-- records when it was last asked, so a NULL `checked_at` means the link has never been confirmed.
CREATE TABLE "goat"."session_pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_session_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_session_pull_requests_number_check" CHECK ("goat"."session_pull_requests"."number" > 0),
	CONSTRAINT "goat_session_pull_requests_state_check" CHECK ("goat"."session_pull_requests"."state" IN ('draft', 'open', 'blocked', 'merged', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "goat"."session_pull_requests"
	ADD CONSTRAINT "session_pull_requests_chat_session_id_chat_sessions_id_fk"
	FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."session_pull_requests"
	ADD CONSTRAINT "session_pull_requests_user_workos_id_users_workos_user_id_fk"
	FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "goat_session_pull_requests_session_pr_idx"
	ON "goat"."session_pull_requests" USING btree ("chat_session_id","repository_full_name","number");
--> statement-breakpoint
CREATE INDEX "goat_session_pull_requests_user_session_idx"
	ON "goat"."session_pull_requests" USING btree ("user_workos_id","chat_session_id");

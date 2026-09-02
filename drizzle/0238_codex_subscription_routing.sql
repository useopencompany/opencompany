ALTER TABLE "goat"."codex_credentials" ADD COLUMN "refresh_lock_id" text;
--> statement-breakpoint
ALTER TABLE "goat"."codex_credentials" ADD COLUMN "refresh_lock_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "goat"."workspace_codex_engine_accounts" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"provider_user_workos_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_updated_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("updated_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_membership_fk" FOREIGN KEY ("workspace_id", "provider_user_workos_id") REFERENCES "goat"."workspace_members"("workspace_id", "user_workos_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_credential_fk" FOREIGN KEY ("provider_user_workos_id") REFERENCES "goat"."codex_credentials"("user_workos_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'included_usage_grant', 'included_usage_expiration', 'stripe_topup', 'chat_model_usage', 'subscription_covered', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" VALIDATE CONSTRAINT "goat_credit_ledger_source_check";

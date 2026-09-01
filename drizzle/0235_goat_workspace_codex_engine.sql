CREATE TABLE "goat"."workspace_codex_engine_accounts" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"provider_user_workos_id" text NOT NULL,
	"designated_by_workos_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_provider_user_workos_id_codex_credentials_user_workos_id_fk" FOREIGN KEY ("provider_user_workos_id") REFERENCES "goat"."codex_credentials"("user_workos_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_designated_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("designated_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_codex_engine_accounts" ADD CONSTRAINT "workspace_codex_engine_accounts_provider_membership_fk" FOREIGN KEY ("workspace_id","provider_user_workos_id") REFERENCES "goat"."workspace_members"("workspace_id","user_workos_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workspace_codex_engine_accounts_provider_idx" ON "goat"."workspace_codex_engine_accounts" USING btree ("provider_user_workos_id");
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT "goat_credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("goat"."credit_ledger"."source" IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'included_usage_grant', 'included_usage_expiration', 'stripe_topup', 'subscription_covered', 'chat_model_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment'));

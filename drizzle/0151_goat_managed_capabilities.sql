-- Managed public-data capabilities and their paid execution ledger.
CREATE TABLE "goat"."workspace_capabilities" (
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by_workos_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_workspace_capabilities_workspace_id_source_pk" PRIMARY KEY("workspace_id","source"),
	CONSTRAINT "goat_workspace_capabilities_source_check" CHECK ("source" IN ('x', 'linkedin', 'youtube', 'instagram', 'tiktok', 'lead'))
);
--> statement-breakpoint
ALTER TABLE "goat"."workspace_capabilities" ADD CONSTRAINT "goat_workspace_capabilities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_capabilities" ADD CONSTRAINT "goat_workspace_capabilities_updated_by_workos_id_users_workos_user_id_fk" FOREIGN KEY ("updated_by_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "goat"."capability_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_workos_id" text NOT NULL,
	"chat_session_id" text NOT NULL,
	"tool_call_id" text,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"input_hash" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"quote_provider_cost_usd_micros" bigint NOT NULL,
	"quote_platform_fee_usd_micros" bigint NOT NULL,
	"quote_total_cost_usd_micros" bigint NOT NULL,
	"monid_run_id" text,
	"provider_http_status" integer,
	"result_count" integer,
	"provider_cost_usd_micros" bigint,
	"platform_fee_usd_micros" bigint,
	"total_cost_usd_micros" bigint,
	"error_code" text,
	"error_message" text,
	"approval_expires_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_capability_runs_source_check" CHECK ("source" IN ('x', 'linkedin', 'youtube', 'instagram', 'tiktok', 'lead')),
	CONSTRAINT "goat_capability_runs_provider_check" CHECK ("provider" IN ('tikhub', 'apify', 'pdl')),
	CONSTRAINT "goat_capability_runs_input_hash_check" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "goat_capability_runs_money_check" CHECK ("quote_provider_cost_usd_micros" >= 0
		AND "quote_platform_fee_usd_micros" >= 0
		AND "quote_total_cost_usd_micros" >= 0
		AND "quote_total_cost_usd_micros" = "quote_provider_cost_usd_micros" + "quote_platform_fee_usd_micros"
		AND ("provider_cost_usd_micros" IS NULL OR "provider_cost_usd_micros" >= 0)
		AND ("platform_fee_usd_micros" IS NULL OR "platform_fee_usd_micros" >= 0)
		AND ("total_cost_usd_micros" IS NULL OR "total_cost_usd_micros" >= 0)
		AND (
			("provider_cost_usd_micros" IS NULL AND "platform_fee_usd_micros" IS NULL AND "total_cost_usd_micros" IS NULL)
			OR (
				"provider_cost_usd_micros" IS NOT NULL
				AND "platform_fee_usd_micros" IS NOT NULL
				AND "total_cost_usd_micros" = "provider_cost_usd_micros" + "platform_fee_usd_micros"
			)
		)
		AND ("result_count" IS NULL OR "result_count" >= 0)),
	CONSTRAINT "goat_capability_runs_status_check" CHECK ("status" IN ('awaiting_approval', 'approved', 'canceled', 'expired', 'executing', 'running', 'stopping', 'succeeded', 'failed', 'stopped', 'timed_out'))
);
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs" ADD CONSTRAINT "goat_capability_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "goat"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs" ADD CONSTRAINT "goat_capability_runs_user_workos_id_users_workos_user_id_fk" FOREIGN KEY ("user_workos_id") REFERENCES "goat"."users"("workos_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goat"."capability_runs" ADD CONSTRAINT "goat_capability_runs_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "goat"."chat_sessions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "goat_capability_runs_monid_run_idx" ON "goat"."capability_runs" USING btree ("monid_run_id") WHERE "monid_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "goat_capability_runs_workspace_created_idx" ON "goat"."capability_runs" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "goat_capability_runs_reconciliation_idx" ON "goat"."capability_runs" USING btree ("updated_at","id") WHERE "status" IN ('executing', 'running', 'stopping') AND "settled_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "goat_capability_runs_approval_idx" ON "goat"."capability_runs" USING btree ("user_workos_id","chat_session_id","status","approval_expires_at");
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'stripe_topup', 'chat_model_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" VALIDATE CONSTRAINT "goat_credit_ledger_source_check";

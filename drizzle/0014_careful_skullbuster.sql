ALTER TABLE "workspace_credit_balances" ADD COLUMN "balance_usd_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "amount_usd_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "workspace_credit_balances" SET "balance_usd_micros" = "balance_cents"::bigint * 10000;--> statement-breakpoint
UPDATE "workspace_credit_ledger" SET "amount_usd_micros" = "amount_cents"::bigint * 10000;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "model_usage_id" integer;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "tool_usage_id" integer;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "provider_cost_usd_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "platform_fee_usd_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD COLUMN "cost_basis" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_message_id_agent_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."agent_session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_model_usage_id_agent_session_usage_id_fk" FOREIGN KEY ("model_usage_id") REFERENCES "public"."agent_session_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_tool_usage_id_agent_session_tool_usage_id_fk" FOREIGN KEY ("tool_usage_id") REFERENCES "public"."agent_session_tool_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_credit_ledger_session_idx" ON "workspace_credit_ledger" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_credit_ledger_model_usage_idx" ON "workspace_credit_ledger" USING btree ("model_usage_id") WHERE "workspace_credit_ledger"."model_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_credit_ledger_tool_usage_idx" ON "workspace_credit_ledger" USING btree ("tool_usage_id") WHERE "workspace_credit_ledger"."tool_usage_id" IS NOT NULL;

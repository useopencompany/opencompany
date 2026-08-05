ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "included_usage_period_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "included_usage_period_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "goat"."credit_balances" ADD COLUMN IF NOT EXISTS "included_balance_usd_micros" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."credit_balances" ADD COLUMN IF NOT EXISTS "top_up_balance_usd_micros" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "goat"."credit_balances"
SET "top_up_balance_usd_micros" = "balance_usd_micros"
WHERE "included_balance_usd_micros" = 0
  AND "top_up_balance_usd_micros" = 0
  AND "balance_usd_micros" <> 0;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'stripe_topup', 'chat_model_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment'));

ALTER TABLE "goat"."browser_profile_sessions"
  ADD COLUMN IF NOT EXISTS "provider_cost_usd_micros" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "platform_fee_usd_micros" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_cost_usd_micros" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'included_usage_grant', 'included_usage_expiration', 'stripe_topup', 'chat_model_usage', 'subscription_covered', 'sandbox_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" VALIDATE CONSTRAINT "goat_credit_ledger_source_check";

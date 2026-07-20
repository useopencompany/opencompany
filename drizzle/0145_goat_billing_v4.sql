-- Billing v4: pure usage-based wallet. Seats/plans are retired (columns stay
-- for now, unused); every ingestion debits credits — model cost per attempt
-- ("ingest_model_usage", all tiers) plus a flat per-item fee charged once at
-- reservation admission ("ingest_fee"). Old source values remain valid for
-- historical rows.
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'stripe_topup', 'chat_model_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment')) NOT VALID;--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" VALIDATE CONSTRAINT "goat_credit_ledger_source_check";
--> statement-breakpoint
-- Auto-refill: a card saved during top-up Checkout (setup_future_usage) is
-- charged off-session when the balance drops below the threshold. The
-- in-flight timestamp is a lease so concurrent triggers charge at most once.
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_amount_cents" integer NOT NULL DEFAULT 2000;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_in_flight_at" timestamptz;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_last_attempt_at" timestamptz;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "auto_refill_last_error" text;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP CONSTRAINT IF EXISTS "goat_workspace_billing_auto_refill_amount_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD CONSTRAINT "goat_workspace_billing_auto_refill_amount_check" CHECK ("auto_refill_amount_cents" >= 500);

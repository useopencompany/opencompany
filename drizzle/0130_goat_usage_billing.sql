-- Pricing rework: seat-priced Pro ($18/seat, 300 ingestions per seat pooled),
-- Free at 300 pooled, plus a goat-scoped USD credit system that funds
-- usage-based chat, frontier-ingest cost pass-through, and Pro ingestion
-- overage ($2 per 100 raw events). The connected-source bonus is retired
-- (it was computed live from brain sources; nothing to drop).

-- Per-brain intelligence tier: included ingestions run the open-source
-- "basic" model; "frontier" (Claude Sonnet) passes model cost to credits.
ALTER TABLE "goat"."brains" ADD COLUMN IF NOT EXISTS "intelligence" text NOT NULL DEFAULT 'basic';--> statement-breakpoint
ALTER TABLE "goat"."brains" DROP CONSTRAINT IF EXISTS "goat_brains_intelligence_check";--> statement-breakpoint
ALTER TABLE "goat"."brains" ADD CONSTRAINT "goat_brains_intelligence_check" CHECK ("intelligence" IN ('basic', 'frontier'));
--> statement-breakpoint
-- Seat projection: written only from Stripe subscription webhooks (the
-- subscription item quantity); the pooled Pro allowance is 300 x this value.
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "seat_quantity" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" DROP CONSTRAINT IF EXISTS "goat_workspace_billing_seat_quantity_check";--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD CONSTRAINT "goat_workspace_billing_seat_quantity_check" CHECK ("seat_quantity" >= 1);
--> statement-breakpoint
-- Overage marker: > 0 on reservations that were admitted by debiting credits
-- instead of fitting the monthly allowance. Doubles as the usage report line.
ALTER TABLE "goat"."workspace_ingestion_reservations" ADD COLUMN IF NOT EXISTS "billed_overage_usd_micros" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."credit_balances" (
	"workspace_id" text PRIMARY KEY REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"balance_cents" integer NOT NULL DEFAULT 0,
	"balance_usd_micros" bigint NOT NULL DEFAULT 0,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."stripe_checkout_sessions" (
	"id" text PRIMARY KEY,
	"stripe_checkout_session_id" text,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"user_workos_id" text REFERENCES "goat"."users"("workos_user_id") ON DELETE SET NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"fulfilled_at" timestamptz,
	CONSTRAINT "goat_stripe_checkout_sessions_status_check" CHECK ("status" IN ('pending', 'open', 'fulfilled', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goat_stripe_checkout_sessions_stripe_id_idx" ON "goat"."stripe_checkout_sessions" ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_stripe_checkout_sessions_workspace_idx" ON "goat"."stripe_checkout_sessions" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goat"."credit_ledger" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" text NOT NULL REFERENCES "goat"."workspaces"("id") ON DELETE CASCADE,
	"user_workos_id" text REFERENCES "goat"."users"("workos_user_id") ON DELETE SET NULL,
	"amount_cents" integer NOT NULL,
	"amount_usd_micros" bigint NOT NULL DEFAULT 0,
	"source" text NOT NULL,
	"idempotency_key" text,
	"checkout_session_id" text REFERENCES "goat"."stripe_checkout_sessions"("id") ON DELETE SET NULL,
	"chat_session_id" text REFERENCES "goat"."chat_sessions"("id") ON DELETE SET NULL,
	"ingest_job_id" text REFERENCES "goat"."brain_ingest_jobs"("id") ON DELETE SET NULL,
	"reservation_id" text REFERENCES "goat"."workspace_ingestion_reservations"("id") ON DELETE SET NULL,
	"provider_cost_usd_micros" bigint NOT NULL DEFAULT 0,
	"platform_fee_usd_micros" bigint NOT NULL DEFAULT 0,
	"cost_basis" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'stripe_topup', 'chat_model_usage', 'frontier_ingest', 'ingest_overage', 'adjustment'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goat_credit_ledger_workspace_created_idx" ON "goat"."credit_ledger" ("workspace_id", "created_at");--> statement-breakpoint
-- One generic dedupe key covers every debit/credit surface (chat turn,
-- frontier ingest attempt, overage reservation); typed reference columns
-- above stay for reporting.
CREATE UNIQUE INDEX IF NOT EXISTS "goat_credit_ledger_idempotency_idx" ON "goat"."credit_ledger" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
-- At most one starter grant per workspace, no matter how often workspace
-- bootstrap or the backfill runs.
CREATE UNIQUE INDEX IF NOT EXISTS "goat_credit_ledger_starter_grant_idx" ON "goat"."credit_ledger" ("workspace_id") WHERE "source" = 'starter_grant';

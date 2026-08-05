ALTER TABLE "goat"."workspace_billing" DROP CONSTRAINT IF EXISTS "goat_workspace_billing_plan_check";
--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ALTER COLUMN "plan" SET DEFAULT 'hobby';
--> statement-breakpoint
UPDATE "goat"."workspace_billing"
SET "plan" = CASE
      WHEN "stripe_product_key" = 'goat_pro'
        AND "subscription_status" IN ('active', 'trialing', 'past_due')
      THEN 'pro'
      ELSE 'hobby'
    END,
    "auto_refill_enabled" = CASE
      WHEN "stripe_product_key" = 'goat_pro'
        AND "subscription_status" IN ('active', 'trialing', 'past_due')
      THEN "auto_refill_enabled"
      ELSE false
    END;
--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD CONSTRAINT "goat_workspace_billing_plan_check" CHECK ("plan" IN ('hobby', 'pro'));
--> statement-breakpoint
ALTER TABLE "goat"."workspace_billing" ADD COLUMN IF NOT EXISTS "included_usage_allowance_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" DROP CONSTRAINT IF EXISTS "goat_credit_ledger_source_check";
--> statement-breakpoint
ALTER TABLE "goat"."credit_ledger" ADD CONSTRAINT "goat_credit_ledger_source_check" CHECK ("source" IN ('starter_grant', 'seat_included_grant', 'seat_included_expiration', 'included_usage_grant', 'included_usage_expiration', 'stripe_topup', 'chat_model_usage', 'capability_usage', 'frontier_ingest', 'ingest_overage', 'ingest_model_usage', 'ingest_fee', 'adjustment'));
--> statement-breakpoint
INSERT INTO "goat"."workspace_billing" ("workspace_id", "plan")
SELECT "id", 'hobby'
FROM "goat"."workspaces"
ON CONFLICT ("workspace_id") DO NOTHING;
--> statement-breakpoint
WITH monthly_hobby_grants AS (
  INSERT INTO "goat"."credit_ledger" (
    "workspace_id",
    "amount_cents",
    "amount_usd_micros",
    "source",
    "idempotency_key",
    "metadata"
  )
  SELECT
    billing."workspace_id",
    500,
    5000000,
    'included_usage_grant',
    'included_usage_grant:' || billing."workspace_id" || ':' || to_char(date_trunc('month', now(), 'UTC'), 'YYYY-MM-DD') || ':500',
    jsonb_build_object(
      'reason', 'monthly_included_usage',
      'plan', 'hobby',
      'seatQuantity', 1,
      'allowanceCents', 500,
      'periodStart', date_trunc('month', now(), 'UTC'),
      'periodEnd', date_trunc('month', now(), 'UTC') + interval '1 month',
      'migration', '0191_goat_hobby_billing'
    )
  FROM "goat"."workspace_billing" AS billing
  WHERE billing."plan" = 'hobby'
  ON CONFLICT DO NOTHING
  RETURNING "workspace_id", "amount_cents", "amount_usd_micros"
)
INSERT INTO "goat"."credit_balances" (
  "workspace_id",
  "balance_cents",
  "balance_usd_micros",
  "included_balance_usd_micros",
  "top_up_balance_usd_micros",
  "updated_at"
)
SELECT
  "workspace_id",
  "amount_cents",
  "amount_usd_micros",
  "amount_usd_micros",
  0,
  now()
FROM monthly_hobby_grants
ON CONFLICT ("workspace_id") DO UPDATE
SET "balance_usd_micros" = "goat"."credit_balances"."balance_usd_micros" + excluded."balance_usd_micros",
    "balance_cents" = round(("goat"."credit_balances"."balance_usd_micros" + excluded."balance_usd_micros")::numeric / 10000)::integer,
    "included_balance_usd_micros" = "goat"."credit_balances"."included_balance_usd_micros" + excluded."included_balance_usd_micros",
    "updated_at" = now();
--> statement-breakpoint
UPDATE "goat"."workspace_billing"
SET "included_usage_period_start" = date_trunc('month', now(), 'UTC'),
    "included_usage_period_end" = date_trunc('month', now(), 'UTC') + interval '1 month',
    "included_usage_allowance_cents" = greatest("included_usage_allowance_cents", 500),
    "updated_at" = now()
WHERE "plan" = 'hobby';
--> statement-breakpoint
UPDATE "goat"."workspace_billing"
SET "included_usage_period_start" = date_trunc('month', now(), 'UTC'),
    "included_usage_period_end" = date_trunc('month', now(), 'UTC') + interval '1 month',
    "included_usage_allowance_cents" = greatest("included_usage_allowance_cents", "seat_quantity" * 2000),
    "updated_at" = now()
WHERE "plan" = 'pro'
  AND "included_usage_period_start" IS NOT NULL;

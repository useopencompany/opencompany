// Pure Goat billing configuration, kept free of server-only imports (db
// client, node:crypto) so client components can share the exact numbers and
// math the server enforces instead of mirroring them. Re-exported by
// ./goat-billing.
//
// Billing v6: every workspace is seat-billed, and every seat contributes the
// same amount of included at-cost usage to the workspace pool for the current
// month. Overage/top-up funds live in a separate workspace pool.

export const GOAT_PRO_MONTHLY_PRICE_USD_CENTS = 2_000;
export const GOAT_SEAT_MONTHLY_PRICE_USD_CENTS = GOAT_PRO_MONTHLY_PRICE_USD_CENTS;
export const GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS = 2_000;
export const GOAT_PRO_STRIPE_PRODUCT_KEY = "goat_pro";
export const GOAT_FREE_MAX_MEMBERS = 10;
export const GOAT_PRO_MAX_MEMBERS = 10;

// Signup grant into the pay-per-use wallet. Under billing v6 there is no free
// plan, but the initial grant lets a founder try real usage before adding a
// card.
export const GOAT_STARTER_CREDIT_USD_CENTS = 2_000;

export const GOAT_TOP_UP_AMOUNTS_USD_CENTS = [500, 1_000, 2_000, 5_000, 10_000] as const;
export const GOAT_DEFAULT_TOP_UP_USD_CENTS = 2_000;
export const GOAT_MIN_TOP_UP_USD_CENTS = 500;
export const GOAT_MAX_TOP_UP_USD_CENTS = 100_000;

// Billing v6 charges usage at real cost. Brain ingestion is now only the model,
// capability, and sandbox COGS recorded elsewhere; no flat per-item platform
// fee is added.
export const GOAT_INGEST_ITEM_FEE_USD_MICROS = 0;

// Balance thresholds: warn in the UI below $2; auto-refill (when enabled and
// a card is saved) tops up once the balance drops below $5.
export const GOAT_LOW_BALANCE_WARN_USD_MICROS = 2_000_000;
export const GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS = 5_000_000;

export function goatWorkspaceMemberCap(plan: "free" | "pro") {
  return plan === "pro" ? GOAT_PRO_MAX_MEMBERS : GOAT_FREE_MAX_MEMBERS;
}

// Ingestion model tiers: both are metered (model cost + fee); "frontier" just
// runs a more expensive model.
//
// Basic is Haiku 4.5, not an open-source model: kimi-k2.6's per-token discount
// ($0.95/$4 vs Haiku's $1/$5) was erased by step inflation — in prod it
// averaged 23 steps/job (32% of jobs hit the 32-step cap) vs 6-8 steps for
// Anthropic models on the same events, netting ~23c/job vs ~7-12c for Haiku.
// Evidence: apps/runner/scripts/ingest-model-bench.ts replays.
export const GOAT_BASIC_INGEST_MODEL = "anthropic/claude-haiku-4.5";
export const GOAT_FRONTIER_INGEST_MODEL = "anthropic/claude-sonnet-5";

export function goatIngestItemFeeUsdMicros(rawEventCount: number) {
  return Math.max(0, rawEventCount) * GOAT_INGEST_ITEM_FEE_USD_MICROS;
}

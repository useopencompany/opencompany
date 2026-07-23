// Pure Goat billing configuration, kept free of server-only imports (db
// client, node:crypto) so client components can share the exact numbers and
// math the server enforces instead of mirroring them. Re-exported by
// ./goat-billing.
//
// Billing v4 is pure usage-based: no plans, no seats. A workspace wallet is
// topped up via Stripe and every billable action debits it — model cost from
// the pricing table plus a platform fee, and a flat per-item fee on ingestion.

// One-time grant at workspace creation — the only free usage. Everything
// after it is metered.
export const GOAT_STARTER_CREDIT_USD_CENTS = 500;

export const GOAT_TOP_UP_AMOUNTS_USD_CENTS = [500, 1_000, 2_000, 5_000, 10_000] as const;
export const GOAT_DEFAULT_TOP_UP_USD_CENTS = 2_000;
export const GOAT_MIN_TOP_UP_USD_CENTS = 500;
export const GOAT_MAX_TOP_UP_USD_CENTS = 100_000;

// Flat ingestion fee, charged once per admitted reservation on top of the
// pass-through model cost: $0.20 per 50 items = $0.004/item. Anchor: 2,000
// items/mo ≈ $8 in fees + basic-tier model cost ≲ $10 all-in. Validate against
// traced per-item model cost before locking; tune this fee, not the
// pass-through.
export const GOAT_INGEST_ITEM_FEE_USD_MICROS = 4_000;

// Balance thresholds: warn in the UI below $2; auto-refill (when enabled and
// a card is saved) tops up once the balance drops below $5.
export const GOAT_LOW_BALANCE_WARN_USD_MICROS = 2_000_000;
export const GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS = 5_000_000;

// Plain product cap, no longer tied to billing plans.
export const GOAT_MAX_MEMBERS = 50;

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

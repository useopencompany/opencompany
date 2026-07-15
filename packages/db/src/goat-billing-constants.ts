// Pure Goat plan configuration, kept free of server-only imports (db client,
// node:crypto) so client components can share the exact numbers and math the
// server enforces instead of mirroring them. Re-exported by ./goat-billing.

import type { GoatWorkspacePlan } from "./goat-schema";

export const GOAT_FREE_MONTHLY_INGESTION_LIMIT = 300;
export const GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT = 300;
export const GOAT_PRO_SEAT_MONTHLY_PRICE_USD_CENTS = 1_800;

export const GOAT_FREE_MAX_MEMBERS = 3;
export const GOAT_PRO_MAX_MEMBERS = 50;

// Pro overage: $2 per 100 raw events, debited from workspace credits per
// admitted reservation ($0.02 per raw event).
export const GOAT_INGESTION_OVERAGE_USD_CENTS_PER_100_EVENTS = 200;
export const GOAT_INGESTION_OVERAGE_USD_MICROS_PER_RAW_EVENT = 20_000;

// One-time grant at workspace creation so usage-based chat works before the
// first top-up.
export const GOAT_STARTER_CREDIT_USD_CENTS = 500;

export const GOAT_TOP_UP_AMOUNTS_USD_CENTS = [500, 1_000, 2_500, 5_000] as const;
export const GOAT_MIN_TOP_UP_USD_CENTS = 500;
export const GOAT_MAX_TOP_UP_USD_CENTS = 100_000;

// Ingestion model tiers: "basic" (open-source) is included in the plan;
// "frontier" passes model cost through to the workspace's credit balance.
export const GOAT_BASIC_INGEST_MODEL = "moonshotai/kimi-k2.6";
export const GOAT_FRONTIER_INGEST_MODEL = "anthropic/claude-sonnet-5";

export function goatMonthlyIngestionLimit(plan: GoatWorkspacePlan, seatQuantity: number) {
  if (plan !== "pro") return GOAT_FREE_MONTHLY_INGESTION_LIMIT;
  return GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT * Math.max(1, seatQuantity);
}

export function goatIngestionOverageUsdMicros(rawEventCount: number) {
  return Math.max(0, rawEventCount) * GOAT_INGESTION_OVERAGE_USD_MICROS_PER_RAW_EVENT;
}

// Pure Goat plan configuration, kept free of server-only imports (db client,
// node:crypto) so client components can share the exact numbers and math the
// server enforces instead of mirroring them. Re-exported by ./goat-billing.

export const GOAT_FREE_MONTHLY_INGESTION_LIMIT = 150;
export const GOAT_PRO_MONTHLY_INGESTION_LIMIT = 1_500;
export const GOAT_PRO_MONTHLY_PRICE_USD_CENTS = 9_900;
// Connecting sources grows the monthly allowance instead of a separate meter:
// allowance = plan base + 25 per connected source, capped at +100 (4 sources).
export const GOAT_SOURCE_BONUS_MONTHLY_ITEMS = 25;
export const GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS = 100;

export function goatSourceBonusItems(connectedSourceCount: number) {
  return Math.min(
    GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS,
    Math.max(0, connectedSourceCount) * GOAT_SOURCE_BONUS_MONTHLY_ITEMS,
  );
}

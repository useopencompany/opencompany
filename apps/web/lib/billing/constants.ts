export const TOP_UP_AMOUNTS_CENTS = [500, 1000, 2500, 5000] as const;
export const MIN_TOP_UP_AMOUNT_CENTS = 500;
export const MAX_TOP_UP_AMOUNT_CENTS = 100_000;

export type TopUpAmountCents = (typeof TOP_UP_AMOUNTS_CENTS)[number];

export function isPresetTopUpAmountCents(value: number): value is TopUpAmountCents {
  return TOP_UP_AMOUNTS_CENTS.some((amount) => amount === value);
}

export function isValidTopUpAmountCents(value: number) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_TOP_UP_AMOUNT_CENTS &&
    value <= MAX_TOP_UP_AMOUNT_CENTS
  );
}

export function normalizeCreditCode(code: string) {
  return code.trim().toUpperCase();
}

// Weekly spending limit bounds.
export const MIN_WEEKLY_SPEND_LIMIT_CENTS = 100; // $1
export const MAX_WEEKLY_SPEND_LIMIT_CENTS = 1_000_000; // $10,000

export function isValidWeeklySpendLimitCents(value: number) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_WEEKLY_SPEND_LIMIT_CENTS &&
    value <= MAX_WEEKLY_SPEND_LIMIT_CENTS
  );
}

// Automatic refill bounds. The charged amount reuses the top-up range; the
// threshold (balance at which a refill fires) may be anywhere from $0 up to the
// max top-up.
export const MIN_AUTO_REFILL_AMOUNT_CENTS = MIN_TOP_UP_AMOUNT_CENTS;
export const MAX_AUTO_REFILL_AMOUNT_CENTS = MAX_TOP_UP_AMOUNT_CENTS;
export const MIN_AUTO_REFILL_THRESHOLD_CENTS = 0;
export const MAX_AUTO_REFILL_THRESHOLD_CENTS = MAX_TOP_UP_AMOUNT_CENTS;

export function isValidAutoRefillAmountCents(value: number) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_AUTO_REFILL_AMOUNT_CENTS &&
    value <= MAX_AUTO_REFILL_AMOUNT_CENTS
  );
}

export function isValidAutoRefillThresholdCents(value: number) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_AUTO_REFILL_THRESHOLD_CENTS &&
    value <= MAX_AUTO_REFILL_THRESHOLD_CENTS
  );
}

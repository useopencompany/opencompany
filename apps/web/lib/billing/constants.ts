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

// Daily spend-cap bounds (per workspace). Floor keeps a cap meaningful; ceiling guards typos.
export const MIN_DAILY_CAP_CENTS = 100; // $1.00
export const MAX_DAILY_CAP_CENTS = 1_000_000; // $10,000.00

export function isValidDailyCapCents(value: number) {
  return (
    Number.isSafeInteger(value) && value >= MIN_DAILY_CAP_CENTS && value <= MAX_DAILY_CAP_CENTS
  );
}

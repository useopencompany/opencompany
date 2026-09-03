import type { BillingUsageDto } from "@opencompany/protocol";

export const USAGE_REPORTING_WINDOW_DAYS = 30;

export type SpendCategory = BillingUsageDto["breakdown"][number]["category"];

export type SpendDay = {
  day: string;
  chat: number;
  ingestion: number;
  capabilities: number;
  other: number;
  total: number;
};

export type SpendSeries = { key: SpendCategory; label: string; total: number };

const DAY_MS = 86_400_000;

function emptySpendDay(day: string): SpendDay {
  return { day, chat: 0, ingestion: 0, capabilities: 0, other: 0, total: 0 };
}

export function buildDailySpendSeries(
  rows: BillingUsageDto["breakdown"],
  options: { days?: number; now?: Date } = {},
): SpendDay[] {
  const days = options.days ?? USAGE_REPORTING_WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be a positive integer");

  const end = new Date(options.now ?? Date.now());
  end.setUTCHours(0, 0, 0, 0);
  const startMs = end.getTime() - (days - 1) * DAY_MS;
  const endMs = end.getTime();
  const byDay = new Map<string, SpendDay>();

  for (const row of rows) {
    const rowMs = Date.parse(`${row.day}T00:00:00.000Z`);
    if (rowMs < startMs || rowMs > endMs) continue;

    let entry = byDay.get(row.day);
    if (!entry) {
      entry = emptySpendDay(row.day);
      byDay.set(row.day, entry);
    }
    entry[row.category] += row.spendUsdMicros;
    entry.total += row.spendUsdMicros;
  }

  return Array.from({ length: days }, (_, index) => {
    const day = new Date(startMs + index * DAY_MS).toISOString().slice(0, 10);
    return byDay.get(day) ?? emptySpendDay(day);
  });
}

export function formatUsdMicros(usdMicros: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usdMicros / 1_000_000);
}

function fractionDigits(value: number) {
  for (let digits = 0; digits <= 6; digits += 1) {
    const scaled = value * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-8) return digits;
  }
  return 6;
}

function formatAxisNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits(value),
  }).format(value);
}

export function formatUsdAxisMicros(usdMicros: number) {
  const dollars = usdMicros / 1_000_000;
  if (dollars <= 0) return "$0";
  if (dollars >= 1000) return `$${formatAxisNumber(dollars / 1000)}k`;
  return `$${formatAxisNumber(dollars)}`;
}

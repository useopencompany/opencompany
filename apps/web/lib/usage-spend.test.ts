import { describe, expect, it } from "vitest";
import {
  buildDailySpendSeries,
  formatUsdAxisMicros,
  USAGE_REPORTING_WINDOW_DAYS,
} from "./usage-spend";

describe("usage spend presentation", () => {
  it("builds the complete reporting window around a single spend day", () => {
    const days = buildDailySpendSeries(
      [
        {
          day: "2026-08-10",
          category: "chat",
          spendUsdMicros: 250_000,
          providerCostUsdMicros: 200_000,
          platformFeeUsdMicros: 50_000,
        },
      ],
      { now: new Date("2026-09-03T18:00:00.000Z") },
    );

    expect(days).toHaveLength(USAGE_REPORTING_WINDOW_DAYS);
    expect(days[0]).toEqual({
      day: "2026-08-05",
      chat: 0,
      ingestion: 0,
      capabilities: 0,
      other: 0,
      total: 0,
    });
    expect(days.find((day) => day.day === "2026-08-10")).toMatchObject({
      chat: 250_000,
      total: 250_000,
    });
    expect(days.at(-1)).toEqual({
      day: "2026-09-03",
      chat: 0,
      ingestion: 0,
      capabilities: 0,
      other: 0,
      total: 0,
    });
  });

  it("excludes spend before the reporting window", () => {
    const days = buildDailySpendSeries(
      [
        {
          day: "2026-08-04",
          category: "chat",
          spendUsdMicros: 250_000,
          providerCostUsdMicros: 200_000,
          platformFeeUsdMicros: 50_000,
        },
      ],
      { now: new Date("2026-09-03T18:00:00.000Z") },
    );

    expect(days.every((day) => day.total === 0)).toBe(true);
  });

  it("keeps meaningful precision in sub-dollar and fractional axis ticks", () => {
    expect(formatUsdAxisMicros(50_000)).toBe("$0.05");
    expect(formatUsdAxisMicros(25_000)).toBe("$0.025");
    expect(formatUsdAxisMicros(12_500_000)).toBe("$12.5");
    expect(formatUsdAxisMicros(1_250_000_000)).toBe("$1.25k");
  });
});

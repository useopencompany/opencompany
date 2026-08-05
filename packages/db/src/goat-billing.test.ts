import { describe, expect, it } from "vitest";
import {
  GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS,
  GOAT_HOBBY_INCLUDED_USAGE_USD_CENTS,
  GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS,
  GOAT_INGEST_ITEM_FEE_USD_MICROS,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  goatCalendarMonthWindow,
  goatIncludedUsageAllowanceCents,
  goatIngestItemFeeUsdMicros,
  goatPlanForSubscriptionStatus,
  goatWorkspaceMemberCap,
} from "./goat-billing";

describe("Goat billing v7", () => {
  it("reports UTC calendar-month boundaries for usage stats", () => {
    expect(goatCalendarMonthWindow(new Date("2026-12-13T08:30:00.000Z"))).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      resetAt: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  it("does not add a flat ingestion platform fee", () => {
    expect(GOAT_INGEST_ITEM_FEE_USD_MICROS).toBe(0);
    expect(goatIngestItemFeeUsdMicros(50)).toBe(0);
    expect(goatIngestItemFeeUsdMicros(1)).toBe(0);
    expect(goatIngestItemFeeUsdMicros(2_000)).toBe(0);
    expect(goatIngestItemFeeUsdMicros(0)).toBe(0);
    expect(goatIngestItemFeeUsdMicros(-5)).toBe(0);
  });

  it("includes $20 of at-cost monthly usage per seat", () => {
    expect(GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS).toBe(2_000);
    expect(goatIncludedUsageAllowanceCents("pro", 3)).toBe(6_000);
  });

  it("includes $5 of monthly usage on Hobby", () => {
    expect(GOAT_HOBBY_INCLUDED_USAGE_USD_CENTS).toBe(500);
    expect(goatIncludedUsageAllowanceCents("hobby", 10)).toBe(500);
  });

  it("warns below the auto-refill threshold so refills fire before the warning", () => {
    expect(GOAT_LOW_BALANCE_WARN_USD_MICROS).toBeLessThan(GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS);
  });

  it("projects Pro only for usable subscription states", () => {
    expect(goatPlanForSubscriptionStatus("active")).toBe("pro");
    expect(goatPlanForSubscriptionStatus("trialing")).toBe("pro");
    expect(goatPlanForSubscriptionStatus("past_due")).toBe("pro");
    expect(goatPlanForSubscriptionStatus("unpaid")).toBe("hobby");
    expect(goatPlanForSubscriptionStatus("canceled")).toBe("hobby");
    expect(goatPlanForSubscriptionStatus(null)).toBe("hobby");
  });

  it("keeps the seat-billed workspace cap sized for small teams", () => {
    expect(goatWorkspaceMemberCap("hobby")).toBe(1);
    expect(goatWorkspaceMemberCap("pro")).toBe(10);
  });
});

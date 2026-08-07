import { describe, expect, it } from "vitest";
import {
  AUTO_REFILL_THRESHOLD_USD_MICROS,
  calendarMonthWindow,
  HOBBY_INCLUDED_USAGE_USD_CENTS,
  INCLUDED_USAGE_PER_SEAT_USD_CENTS,
  INGEST_ITEM_FEE_USD_MICROS,
  includedUsageAllowanceCents,
  ingestItemFeeUsdMicros,
  LOW_BALANCE_WARN_USD_MICROS,
  planForSubscriptionStatus,
  workspaceMemberCap,
} from "./billing";

describe("Billing v7", () => {
  it("reports UTC calendar-month boundaries for usage stats", () => {
    expect(calendarMonthWindow(new Date("2026-12-13T08:30:00.000Z"))).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      resetAt: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  it("does not add a flat ingestion platform fee", () => {
    expect(INGEST_ITEM_FEE_USD_MICROS).toBe(0);
    expect(ingestItemFeeUsdMicros(50)).toBe(0);
    expect(ingestItemFeeUsdMicros(1)).toBe(0);
    expect(ingestItemFeeUsdMicros(2_000)).toBe(0);
    expect(ingestItemFeeUsdMicros(0)).toBe(0);
    expect(ingestItemFeeUsdMicros(-5)).toBe(0);
  });

  it("includes $20 of at-cost monthly usage per seat", () => {
    expect(INCLUDED_USAGE_PER_SEAT_USD_CENTS).toBe(2_000);
    expect(includedUsageAllowanceCents("pro", 3)).toBe(6_000);
  });

  it("includes $5 of monthly usage on Hobby", () => {
    expect(HOBBY_INCLUDED_USAGE_USD_CENTS).toBe(500);
    expect(includedUsageAllowanceCents("hobby", 10)).toBe(500);
  });

  it("warns below the auto-refill threshold so refills fire before the warning", () => {
    expect(LOW_BALANCE_WARN_USD_MICROS).toBeLessThan(AUTO_REFILL_THRESHOLD_USD_MICROS);
  });

  it("projects Pro only for usable subscription states", () => {
    expect(planForSubscriptionStatus("active")).toBe("pro");
    expect(planForSubscriptionStatus("trialing")).toBe("pro");
    expect(planForSubscriptionStatus("past_due")).toBe("pro");
    expect(planForSubscriptionStatus("unpaid")).toBe("hobby");
    expect(planForSubscriptionStatus("canceled")).toBe("hobby");
    expect(planForSubscriptionStatus(null)).toBe("hobby");
  });

  it("keeps the seat-billed workspace cap sized for small teams", () => {
    expect(workspaceMemberCap("hobby")).toBe(1);
    expect(workspaceMemberCap("pro")).toBe(10);
  });
});

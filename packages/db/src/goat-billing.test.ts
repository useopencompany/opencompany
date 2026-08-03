import { describe, expect, it } from "vitest";
import {
  GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS,
  GOAT_INGEST_ITEM_FEE_USD_MICROS,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  goatCalendarMonthWindow,
  goatIngestItemFeeUsdMicros,
  goatPlanForSubscriptionStatus,
  goatWorkspaceMemberCap,
} from "./goat-billing";

describe("Goat billing v4", () => {
  it("reports UTC calendar-month boundaries for usage stats", () => {
    expect(goatCalendarMonthWindow(new Date("2026-12-13T08:30:00.000Z"))).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      resetAt: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  it("prices the flat ingestion fee at $0.20 per 50 items", () => {
    // $0.004/item keeps 2,000 items/mo at ~$8 in fees — under the $10 all-in
    // anchor once basic-tier model cost is added.
    expect(GOAT_INGEST_ITEM_FEE_USD_MICROS).toBe(4_000);
    expect(goatIngestItemFeeUsdMicros(50)).toBe(200_000);
    expect(goatIngestItemFeeUsdMicros(1)).toBe(4_000);
    expect(goatIngestItemFeeUsdMicros(2_000)).toBe(8_000_000);
    expect(goatIngestItemFeeUsdMicros(0)).toBe(0);
    expect(goatIngestItemFeeUsdMicros(-5)).toBe(0);
  });

  it("warns below the auto-refill threshold so refills fire before the warning", () => {
    expect(GOAT_LOW_BALANCE_WARN_USD_MICROS).toBeLessThan(GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS);
  });

  it("projects Pro only for usable subscription states", () => {
    expect(goatPlanForSubscriptionStatus("active")).toBe("pro");
    expect(goatPlanForSubscriptionStatus("trialing")).toBe("pro");
    expect(goatPlanForSubscriptionStatus("past_due")).toBe("pro");
    expect(goatPlanForSubscriptionStatus("unpaid")).toBe("free");
    expect(goatPlanForSubscriptionStatus("canceled")).toBe("free");
    expect(goatPlanForSubscriptionStatus(null)).toBe("free");
  });

  it("keeps Free personal and Pro sized for small teams", () => {
    expect(goatWorkspaceMemberCap("free")).toBe(1);
    expect(goatWorkspaceMemberCap("pro")).toBe(10);
  });
});

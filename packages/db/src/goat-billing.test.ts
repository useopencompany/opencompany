import { describe, expect, it } from "vitest";
import {
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_INGESTION_LIMIT,
  GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS,
  goatCalendarMonthWindow,
  goatIngestionWindow,
  goatPlanForSubscriptionStatus,
  goatReservationFitsAllowance,
  goatSourceBonusItems,
} from "./goat-billing";

describe("Goat billing entitlements", () => {
  it("reports UTC calendar-month boundaries for billing usage", () => {
    expect(goatCalendarMonthWindow(new Date("2026-12-13T08:30:00.000Z"))).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      resetAt: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  it.each([
    "active",
    "trialing",
    "past_due",
  ] as const)("keeps %s subscriptions on Pro", (status) => {
    expect(goatPlanForSubscriptionStatus(status)).toBe("pro");
  });

  it.each([
    null,
    "incomplete",
    "incomplete_expired",
    "canceled",
    "unpaid",
    "paused",
  ] as const)("uses Free entitlements for %s", (status) => {
    expect(goatPlanForSubscriptionStatus(status)).toBe("free");
  });

  it("uses a pooled UTC calendar month for Free", () => {
    const window = goatIngestionWindow({
      plan: "free",
      planStartedAt: new Date("2026-06-15T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
    });
    expect(window).toEqual({
      plan: "free",
      limit: GOAT_FREE_MONTHLY_INGESTION_LIMIT,
      baseLimit: GOAT_FREE_MONTHLY_INGESTION_LIMIT,
      sourceBonus: 0,
      start: new Date("2026-07-01T00:00:00.000Z"),
      resetAt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("uses a pooled UTC calendar month for Pro", () => {
    const window = goatIngestionWindow({
      plan: "pro",
      planStartedAt: new Date("2026-06-10T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
    });
    expect(window).toEqual({
      plan: "pro",
      limit: GOAT_PRO_MONTHLY_INGESTION_LIMIT,
      baseLimit: GOAT_PRO_MONTHLY_INGESTION_LIMIT,
      sourceBonus: 0,
      start: new Date("2026-07-01T00:00:00.000Z"),
      resetAt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("starts a fresh allowance on a mid-window plan transition", () => {
    const planStartedAt = new Date("2026-07-13T08:00:00.000Z");
    const window = goatIngestionWindow({
      plan: "pro",
      planStartedAt,
      now: new Date("2026-07-13T08:30:00.000Z"),
    });
    expect(window.start).toEqual(planStartedAt);
    expect(window.resetAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("adds 25 monthly items per connected source on top of the base allowance", () => {
    const window = goatIngestionWindow({
      plan: "free",
      planStartedAt: new Date("2026-06-15T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
      connectedSourceCount: 2,
    });
    expect(window.sourceBonus).toBe(50);
    expect(window.limit).toBe(GOAT_FREE_MONTHLY_INGESTION_LIMIT + 50);
  });

  it("caps the source bonus at +100 items per month", () => {
    expect(goatSourceBonusItems(0)).toBe(0);
    expect(goatSourceBonusItems(1)).toBe(25);
    expect(goatSourceBonusItems(4)).toBe(GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS);
    expect(goatSourceBonusItems(9)).toBe(GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS);
    expect(goatSourceBonusItems(-3)).toBe(0);
  });

  it("pauses a whole raw-event batch when it cannot fit", () => {
    expect(
      goatReservationFitsAllowance({
        consumedUnits: 150,
        pendingUnits: 0,
        rawEventCount: 51,
        limit: 200,
      }),
    ).toBe(false);
  });

  it("keeps newer work behind an existing FIFO backlog", () => {
    expect(
      goatReservationFitsAllowance({
        consumedUnits: 150,
        pendingUnits: 51,
        rawEventCount: 1,
        limit: 200,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_DAILY_INGESTION_LIMIT,
  goatCalendarMonthWindow,
  goatIngestionWindow,
  goatPlanForSubscriptionStatus,
  goatReservationFitsAllowance,
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

  it("uses a UTC calendar month for Free", () => {
    const window = goatIngestionWindow({
      plan: "free",
      planStartedAt: new Date("2026-06-15T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
    });
    expect(window).toEqual({
      plan: "free",
      limit: GOAT_FREE_MONTHLY_INGESTION_LIMIT,
      start: new Date("2026-07-01T00:00:00.000Z"),
      resetAt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("uses a UTC calendar day for Pro", () => {
    const window = goatIngestionWindow({
      plan: "pro",
      planStartedAt: new Date("2026-07-10T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
    });
    expect(window).toEqual({
      plan: "pro",
      limit: GOAT_PRO_DAILY_INGESTION_LIMIT,
      start: new Date("2026-07-13T00:00:00.000Z"),
      resetAt: new Date("2026-07-14T00:00:00.000Z"),
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

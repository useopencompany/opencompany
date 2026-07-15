import { describe, expect, it } from "vitest";
import {
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT,
  goatCalendarMonthWindow,
  goatIngestionOverageRawEventCount,
  goatIngestionOverageUsdMicros,
  goatIngestionWindow,
  goatMonthlyIngestionLimit,
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

  it("uses a pooled UTC calendar month for Free", () => {
    const window = goatIngestionWindow({
      plan: "free",
      planStartedAt: new Date("2026-06-15T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
    });
    expect(window).toEqual({
      plan: "free",
      limit: GOAT_FREE_MONTHLY_INGESTION_LIMIT,
      seatQuantity: 1,
      start: new Date("2026-07-01T00:00:00.000Z"),
      resetAt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("pools the per-seat allowance across the workspace on Pro", () => {
    const window = goatIngestionWindow({
      plan: "pro",
      planStartedAt: new Date("2026-06-10T12:00:00.000Z"),
      now: new Date("2026-07-13T08:30:00.000Z"),
      seatQuantity: 4,
    });
    expect(window).toEqual({
      plan: "pro",
      limit: GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT * 4,
      seatQuantity: 4,
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

  it("ignores seat quantity on Free and clamps Pro seats to at least one", () => {
    expect(goatMonthlyIngestionLimit("free", 10)).toBe(GOAT_FREE_MONTHLY_INGESTION_LIMIT);
    expect(goatMonthlyIngestionLimit("pro", 0)).toBe(GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT);
    expect(goatMonthlyIngestionLimit("pro", 50)).toBe(GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT * 50);
  });

  it("prices overage at $0.02 per raw event", () => {
    expect(goatIngestionOverageUsdMicros(1)).toBe(20_000);
    expect(goatIngestionOverageUsdMicros(100)).toBe(2_000_000);
    expect(goatIngestionOverageUsdMicros(0)).toBe(0);
    expect(goatIngestionOverageUsdMicros(-5)).toBe(0);
  });

  it("charges only the portion of a reservation beyond the allowance", () => {
    expect(
      goatIngestionOverageRawEventCount({
        consumedUnits: 250,
        rawEventCount: 100,
        limit: 300,
      }),
    ).toBe(50);
    expect(
      goatIngestionOverageRawEventCount({
        consumedUnits: 300,
        rawEventCount: 100,
        limit: 300,
      }),
    ).toBe(100);
    expect(
      goatIngestionOverageRawEventCount({
        consumedUnits: 100,
        rawEventCount: 100,
        limit: 300,
      }),
    ).toBe(0);
    expect(
      goatIngestionOverageRawEventCount({
        consumedUnits: 301,
        rawEventCount: 100,
        limit: 300,
      }),
    ).toBe(100);
    expect(
      goatIngestionOverageRawEventCount({
        consumedUnits: -1,
        rawEventCount: 100,
        limit: 300,
      }),
    ).toBe(0);
    expect(
      goatIngestionOverageRawEventCount({
        consumedUnits: 0,
        rawEventCount: -1,
        limit: 300,
      }),
    ).toBe(0);
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

  it("admits a batch larger than the whole allowance into an untouched window", () => {
    // Flush batches go up to 200 raw events while the Free base is 150; a
    // batch that never fits would otherwise wedge the FIFO backlog forever.
    expect(
      goatReservationFitsAllowance({
        consumedUnits: 0,
        pendingUnits: 0,
        rawEventCount: 200,
        limit: 150,
      }),
    ).toBe(true);
  });

  it("still pauses an oversized batch once the window has any usage", () => {
    expect(
      goatReservationFitsAllowance({
        consumedUnits: 1,
        pendingUnits: 0,
        rawEventCount: 200,
        limit: 150,
      }),
    ).toBe(false);
  });
});

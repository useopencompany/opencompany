import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillAutoRefill, fulfillCheckoutSession } from "./legacy-credits";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);

function mockDb(rows: unknown[]) {
  const db = {
    execute: vi.fn(async () => ({ rows })),
  };
  getDbMock.mockReturnValue(db as never);
  return db;
}

describe("legacy Stripe credit compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not credit unpaid Checkout sessions", async () => {
    const result = await fulfillCheckoutSession({
      id: "cs_test_123",
      payment_status: "unpaid",
      metadata: {},
    } as never);

    expect(result).toEqual({ ok: false, reason: "not_paid" });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("rejects paid Checkout sessions with incomplete ownership metadata", async () => {
    const result = await fulfillCheckoutSession({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {},
    } as never);

    expect(result).toEqual({ ok: false, reason: "missing_metadata" });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("credits a paid Checkout session with matching tenant metadata", async () => {
    mockDb([
      {
        checkoutRecordId: "chk_123",
        workspaceId: "wks_123",
        userId: "usr_123",
        amountCents: 2_500,
        balanceCents: 5_000,
        ledgerId: 22,
      },
    ]);

    await expect(
      fulfillCheckoutSession(
        {
          id: "cs_test_123",
          payment_status: "paid",
          metadata: {
            checkoutRecordId: "chk_123",
            workspaceId: "wks_123",
            userId: "usr_123",
            amountCents: "2500",
          },
        } as never,
        { eventId: "evt_123" },
      ),
    ).resolves.toEqual({
      ok: true,
      checkoutRecordId: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 2_500,
      balanceCents: 5_000,
      ledgerId: 22,
    });
  });

  it("does not double-credit an already fulfilled or mismatched Checkout session", async () => {
    mockDb([]);

    await expect(
      fulfillCheckoutSession({
        id: "cs_test_123",
        payment_status: "paid",
        metadata: {
          checkoutRecordId: "chk_123",
          workspaceId: "wks_123",
          userId: "usr_123",
          amountCents: "2500",
        },
      } as never),
    ).resolves.toEqual({ ok: false, reason: "already_fulfilled_or_mismatch" });
  });

  it("treats a repeated auto-refill fulfillment as an idempotent no-op", async () => {
    mockDb([]);

    await expect(
      fulfillAutoRefill({
        attemptId: "ar_123",
        stripePaymentIntentId: "pi_123",
        eventId: "evt_123",
      }),
    ).resolves.toEqual({ ok: false, alreadyFulfilled: true });
  });
});

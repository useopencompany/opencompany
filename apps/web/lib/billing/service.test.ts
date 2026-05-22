import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillCheckoutSession, redeemCreditCodeForWorkspace } from "./service";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);

function mockDb(input: { executeRows?: unknown[]; selectRows?: unknown[][] }) {
  const selectRows = [...(input.selectRows ?? [])];
  const db = {
    execute: vi.fn().mockResolvedValue({ rows: input.executeRows ?? [] }),
    select: vi.fn(() => {
      const rows = selectRows.shift() ?? [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(rows),
          })),
        })),
      };
    }),
  };
  getDbMock.mockReturnValue(db as never);
  return db;
}

describe("redeemCreditCodeForWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redeems a valid code and returns the credited amount", async () => {
    const db = mockDb({
      executeRows: [{ redemptionId: 1, amountCents: 2500, balanceCents: 2500, ledgerId: 10 }],
    });

    const result = await redeemCreditCodeForWorkspace({
      code: " free25 ",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({
      ok: true,
      redemptionId: 1,
      amountCents: 2500,
      balanceCents: 2500,
      ledgerId: 10,
    });
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("rejects unknown codes", async () => {
    mockDb({ executeRows: [], selectRows: [[]] });

    const result = await redeemCreditCodeForWorkspace({
      code: "missing",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({ ok: false, error: "Code not found." });
  });

  it("rejects codes already redeemed by the workspace", async () => {
    mockDb({
      executeRows: [],
      selectRows: [
        [
          {
            id: "cod_123",
            active: true,
            startsAt: null,
            expiresAt: null,
            maxRedemptions: null,
            redeemedCount: 0,
          },
        ],
        [{ id: 1 }],
      ],
    });

    const result = await redeemCreditCodeForWorkspace({
      code: "FREE25",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({
      ok: false,
      error: "Code has already been redeemed for this workspace.",
    });
  });

  it("rejects inactive, expired, and exhausted codes", async () => {
    const baseCode = {
      id: "cod_123",
      startsAt: null,
      expiresAt: null,
      maxRedemptions: null,
      redeemedCount: 0,
    };

    mockDb({ executeRows: [], selectRows: [[{ ...baseCode, active: false }], []] });
    await expect(
      redeemCreditCodeForWorkspace({ code: "FREE25", workspaceId: "wks_123", userId: "usr_123" }),
    ).resolves.toEqual({ ok: false, error: "Code is not active." });

    mockDb({
      executeRows: [],
      selectRows: [[{ ...baseCode, active: true, expiresAt: new Date(Date.now() - 1000) }], []],
    });
    await expect(
      redeemCreditCodeForWorkspace({ code: "FREE25", workspaceId: "wks_123", userId: "usr_123" }),
    ).resolves.toEqual({ ok: false, error: "Code has expired." });

    mockDb({
      executeRows: [],
      selectRows: [[{ ...baseCode, active: true, maxRedemptions: 1, redeemedCount: 1 }], []],
    });
    await expect(
      redeemCreditCodeForWorkspace({ code: "FREE25", workspaceId: "wks_123", userId: "usr_123" }),
    ).resolves.toEqual({ ok: false, error: "Code has already been fully redeemed." });
  });
});

describe("fulfillCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not credit unpaid sessions", async () => {
    const result = await fulfillCheckoutSession({
      id: "cs_test_123",
      payment_status: "unpaid",
      metadata: {},
    } as never);

    expect(result).toEqual({ ok: false, reason: "not_paid" });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("rejects paid sessions with missing metadata", async () => {
    const result = await fulfillCheckoutSession({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {},
    } as never);

    expect(result).toEqual({ ok: false, reason: "missing_metadata" });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("credits a paid Checkout Session once", async () => {
    mockDb({
      executeRows: [
        {
          checkoutRecordId: "chk_123",
          amountCents: 2500,
          balanceCents: 5000,
          ledgerId: 22,
        },
      ],
    });

    const result = await fulfillCheckoutSession(
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
    );

    expect(result).toEqual({
      ok: true,
      checkoutRecordId: "chk_123",
      amountCents: 2500,
      balanceCents: 5000,
      ledgerId: 22,
    });
  });

  it("does not double-credit fulfilled or mismatched sessions", async () => {
    mockDb({ executeRows: [] });

    const result = await fulfillCheckoutSession({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {
        checkoutRecordId: "chk_123",
        workspaceId: "wks_123",
        userId: "usr_123",
        amountCents: "2500",
      },
    } as never);

    expect(result).toEqual({ ok: false, reason: "already_fulfilled_or_mismatch" });
  });
});

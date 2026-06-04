import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNUP_CREDIT_AMOUNT_CENTS,
  fulfillCheckoutSession,
  grantDefaultSignupCreditForWorkspace,
  loadBillingOverview,
  redeemCreditCodeForWorkspace,
} from "./service";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);

function mockDb(input: {
  executeRows?: unknown[];
  executeRowSets?: unknown[][];
  selectRows?: unknown[][];
}) {
  const selectRows = [...(input.selectRows ?? [])];
  const executeRowSets = input.executeRowSets
    ? [...input.executeRowSets]
    : input.executeRows
      ? [input.executeRows]
      : [];
  const db = {
    execute: vi.fn(async () => ({ rows: executeRowSets.shift() ?? [] })),
    select: vi.fn(() => {
      const rows = selectRows.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        groupBy: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn().mockResolvedValue(rows),
      };
      return chain;
    }),
  };
  getDbMock.mockReturnValue(db as never);
  return db;
}

describe("loadBillingOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes timestamp strings from aggregate billing queries", async () => {
    mockDb({
      executeRowSets: [
        [{ spendLast7UsdMicros: "1250000", spendLast30UsdMicros: "2500000" }],
        [
          {
            sessionId: "ses_123",
            title: "Billing test",
            agentName: "Research agent",
            totalUsdMicros: "13500",
            modelCostUsdMicros: "10000",
            toolCostUsdMicros: "2500",
            sandboxCostUsdMicros: "1000",
            // provider + platform fee must reconcile to the total; the sandbox line's 1000
            // splits into 900 provider passthrough + 100 platform fee.
            providerCostUsdMicros: "10900",
            platformFeeUsdMicros: "2600",
            createdAt: "2026-05-22T13:00:00.000Z",
          },
        ],
      ],
      selectRows: [
        [{ balanceCents: 1000, balanceUsdMicros: 10_000_000 }],
        [
          {
            id: 1,
            amountCents: -1,
            amountUsdMicros: -12_500,
            source: "model_usage",
            sessionId: "ses_123",
            providerCostUsdMicros: 10_000,
            platformFeeUsdMicros: 2_500,
            createdAt: "2026-05-22T13:00:00.000Z",
            costBasis: {},
            metadata: {},
          },
        ],
      ],
    });

    const result = await loadBillingOverview("wks_123");

    expect(result.recentSessionCharges[0]?.createdAt).toBeInstanceOf(Date);
    expect(result.recentSessionCharges[0]?.createdAt.toISOString()).toBe(
      "2026-05-22T13:00:00.000Z",
    );
    expect(result.recentSessionCharges[0]?.agentName).toBe("Research agent");
    expect(result.recentSessionCharges[0]?.modelCostUsdMicros).toBe(10_000);
    expect(result.recentSessionCharges[0]?.toolCostUsdMicros).toBe(2_500);
    expect(result.recentSessionCharges[0]?.sandboxCostUsdMicros).toBe(1_000);
    expect(result.recentSessionCharges[0]?.providerCostUsdMicros).toBe(10_900);
    expect(result.recentSessionCharges[0]?.platformFeeUsdMicros).toBe(2_600);
    expect(result.ledger[0]?.createdAt).toBeInstanceOf(Date);
    expect(result.ledger[0]?.createdAt.toISOString()).toBe("2026-05-22T13:00:00.000Z");
  });

  it("maps delegated child spend to the grouped parent session charge row", async () => {
    mockDb({
      executeRowSets: [
        [{ spendLast7UsdMicros: "1200", spendLast30UsdMicros: "1200" }],
        [
          {
            sessionId: "ses_parent",
            title: "Parent run",
            agentName: "Manager",
            totalUsdMicros: "1200",
            modelCostUsdMicros: "900",
            toolCostUsdMicros: "300",
            providerCostUsdMicros: "1000",
            platformFeeUsdMicros: "200",
            createdAt: "2026-05-22T14:00:00.000Z",
          },
        ],
      ],
      selectRows: [[{ balanceCents: 1000, balanceUsdMicros: 10_000_000 }], []],
    });

    const result = await loadBillingOverview("wks_123");

    expect(result.recentSessionCharges).toEqual([
      expect.objectContaining({
        sessionId: "ses_parent",
        title: "Parent run",
        totalUsdMicros: 1200,
        modelCostUsdMicros: 900,
        toolCostUsdMicros: 300,
      }),
    ]);
  });
});

describe("grantDefaultSignupCreditForWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits the default signup amount once", async () => {
    const db = mockDb({
      executeRows: [{ ledgerId: 12, amountCents: 300, balanceCents: 300 }],
    });

    const result = await grantDefaultSignupCreditForWorkspace({
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({
      ok: true,
      ledgerId: 12,
      amountCents: DEFAULT_SIGNUP_CREDIT_AMOUNT_CENTS,
      balanceCents: DEFAULT_SIGNUP_CREDIT_AMOUNT_CENTS,
    });
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("does not credit the signup amount more than once", async () => {
    mockDb({ executeRows: [] });

    const result = await grantDefaultSignupCreditForWorkspace({
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({ ok: false, reason: "already_granted" });
  });
});

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
          workspaceId: "wks_123",
          userId: "usr_123",
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
      workspaceId: "wks_123",
      userId: "usr_123",
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

import { describe, expect, it, vi } from "vitest";
import {
  fulfillGoatTopUpCheckoutSession,
  getGoatCreditBalanceUsdMicros,
  goatUsdMicrosToCents,
  grantGoatStarterCredit,
  hasPositiveGoatCreditBalance,
  recordGoatCreditDebit,
} from "./goat-credits";

function fakeDb(rows: unknown[]) {
  return { execute: vi.fn(async () => ({ rows })) };
}

describe("goat credits", () => {
  it("rounds USD micros to cents", () => {
    expect(goatUsdMicrosToCents(10_000)).toBe(1);
    expect(goatUsdMicrosToCents(14_999)).toBe(1);
    expect(goatUsdMicrosToCents(15_000)).toBe(2);
    expect(goatUsdMicrosToCents(0)).toBe(0);
  });

  it("reads a zero balance for workspaces without a balance row", async () => {
    const db = fakeDb([]);
    await expect(getGoatCreditBalanceUsdMicros("goat_ws_1", db)).resolves.toBe(0);
    await expect(hasPositiveGoatCreditBalance("goat_ws_1", db)).resolves.toBe(false);
  });

  it("treats a positive balance as spendable", async () => {
    const db = fakeDb([{ balanceUsdMicros: "5000000" }]);
    await expect(hasPositiveGoatCreditBalance("goat_ws_1", db)).resolves.toBe(true);
  });

  it("short-circuits zero-cost debits without touching the database", async () => {
    const db = fakeDb([]);
    const result = await recordGoatCreditDebit({
      workspaceId: "goat_ws_1",
      source: "chat_model_usage",
      idempotencyKey: "chat:msg_1",
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      costBasis: {},
      db,
    });
    expect(result).toEqual({ ok: false, reason: "zero_cost" });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("reports duplicates when the idempotency key already exists", async () => {
    // The ledger INSERT ... ON CONFLICT DO NOTHING returns no rows on replay,
    // so the whole CTE chain yields an empty result set.
    const db = fakeDb([]);
    const result = await recordGoatCreditDebit({
      workspaceId: "goat_ws_1",
      source: "frontier_ingest",
      idempotencyKey: "frontier:job_1:1",
      providerCostUsdMicros: 100_000,
      platformFeeUsdMicros: 10_000,
      totalCostUsdMicros: 110_000,
      costBasis: { kind: "frontier_ingest" },
      db,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("returns the ledger id and new balance for an applied debit", async () => {
    const db = fakeDb([{ ledgerId: 7, balanceUsdMicros: "4890000" }]);
    const result = await recordGoatCreditDebit({
      workspaceId: "goat_ws_1",
      source: "chat_model_usage",
      idempotencyKey: "chat:msg_2",
      providerCostUsdMicros: 100_000,
      platformFeeUsdMicros: 10_000,
      totalCostUsdMicros: 110_000,
      costBasis: { kind: "model_usage" },
      db,
    });
    expect(result).toEqual({ ok: true, ledgerId: 7, balanceUsdMicros: 4_890_000 });
  });

  it("reports an already-granted starter credit as a no-op", async () => {
    const db = fakeDb([]);
    const result = await grantGoatStarterCredit({
      workspaceId: "goat_ws_1",
      amountCents: 500,
      db,
    });
    expect(result).toEqual({ ok: false, reason: "already_granted" });
  });

  it("rejects top-up fulfillment for unpaid or malformed sessions", async () => {
    await expect(
      fulfillGoatTopUpCheckoutSession({ id: "cs_1", payment_status: "unpaid", metadata: {} }),
    ).resolves.toEqual({ ok: false, reason: "not_paid" });
    await expect(
      fulfillGoatTopUpCheckoutSession({ id: "cs_1", payment_status: "paid", metadata: {} }),
    ).resolves.toEqual({ ok: false, reason: "missing_metadata" });
  });
});

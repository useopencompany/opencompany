import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  fulfillTopUpCheckoutSession,
  getCreditBalanceUsdMicros,
  grantMonthlyIncludedUsage,
  hasPositiveCreditBalance,
  loadSpendBreakdown,
  recordAutoRefillCredit,
  recordCreditDebit,
  usdMicrosToCents,
} from "./credits";

function fakeDb(rows: unknown[]) {
  return { execute: vi.fn(async (_query: unknown) => ({ rows })) };
}

describe("opencompany credits", () => {
  it("rounds USD micros to cents", () => {
    expect(usdMicrosToCents(10_000)).toBe(1);
    expect(usdMicrosToCents(14_999)).toBe(1);
    expect(usdMicrosToCents(15_000)).toBe(2);
    expect(usdMicrosToCents(0)).toBe(0);
  });

  it("reads a zero balance for workspaces without a balance row", async () => {
    const db = fakeDb([]);
    await expect(getCreditBalanceUsdMicros("goat_ws_1", db)).resolves.toBe(0);
    await expect(hasPositiveCreditBalance("goat_ws_1", db)).resolves.toBe(false);
  });

  it("treats a positive balance as spendable", async () => {
    const db = fakeDb([{ balanceUsdMicros: "5000000" }]);
    await expect(hasPositiveCreditBalance("goat_ws_1", db)).resolves.toBe(true);
  });

  it("short-circuits zero-cost debits without touching the database", async () => {
    const db = fakeDb([]);
    const result = await recordCreditDebit({
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
    const result = await recordCreditDebit({
      workspaceId: "goat_ws_1",
      source: "ingest_model_usage",
      idempotencyKey: "ingest_model:job_1:1",
      providerCostUsdMicros: 100_000,
      platformFeeUsdMicros: 20_000,
      totalCostUsdMicros: 120_000,
      costBasis: { kind: "ingest_model_usage" },
      db,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("accepts idempotent paid-capability debits", async () => {
    const db = fakeDb([{ ledgerId: 9, balanceUsdMicros: "4640000" }]);
    await expect(
      recordCreditDebit({
        workspaceId: "goat_ws_1",
        userWorkosId: "user_1",
        source: "capability_usage",
        idempotencyKey: "capability:monid_run_1",
        providerCostUsdMicros: 300_000,
        platformFeeUsdMicros: 60_000,
        totalCostUsdMicros: 360_000,
        costBasis: { kind: "paid_capability" },
        db,
      }),
    ).resolves.toEqual({ ok: true, ledgerId: 9, balanceUsdMicros: 4_640_000 });
  });

  it("returns the ledger id and new balance for an applied debit", async () => {
    const db = fakeDb([{ ledgerId: 7, balanceUsdMicros: "4890000" }]);
    const result = await recordCreditDebit({
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

  it("reports a monthly included-usage grant and resulting allowance", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            grants: "1",
            expirations: "1",
            balanceUsdMicros: "5000000",
            allowanceCents: "500",
          },
        ],
      });
    const db = { execute };
    await expect(
      grantMonthlyIncludedUsage({
        workspaceId: "goat_ws_1",
        plan: "hobby",
        seatQuantity: 1,
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-01T00:00:00.000Z"),
        db,
      }),
    ).resolves.toEqual({
      ok: true,
      grants: 1,
      expirations: 1,
      balanceUsdMicros: 5_000_000,
      allowanceCents: 500,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    const dialect = new PgDialect();
    const ensureQuery = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    const grantQuery = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL);
    const normalizedEnsureSql = ensureQuery.sql.toLowerCase().replace(/\s+/g, " ");
    const normalizedGrantSql = grantQuery.sql.toLowerCase().replace(/\s+/g, " ");
    expect(normalizedEnsureSql).toContain("insert into goat.workspace_billing");
    expect(normalizedEnsureSql).toContain("on conflict (workspace_id) do nothing");
    expect(normalizedGrantSql).toContain("from goat.workspace_billing");
    expect(normalizedGrantSql).toContain("for update");
    expect(normalizedGrantSql.match(/update goat\.workspace_billing/g)).toHaveLength(1);
    expect(normalizedGrantSql).not.toContain("jsonb_build_object");
    expect(normalizedGrantSql.match(/::jsonb/g)).toHaveLength(2);
    const metadata = grantQuery.params
      .filter((value): value is string => typeof value === "string" && value.startsWith("{"))
      .map((value) => JSON.parse(value));
    expect(metadata).toEqual([
      {
        reason: "included_usage_no_rollover",
        newPeriodStart: "2026-08-01T00:00:00.000Z",
        stripeEventId: null,
      },
      {
        reason: "monthly_included_usage",
        plan: "hobby",
        seatQuantity: 1,
        allowanceCents: 500,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        stripeEventId: null,
      },
    ]);
  });

  it("rejects top-up fulfillment for unpaid or malformed sessions", async () => {
    const db = fakeDb([]);
    await expect(
      fulfillTopUpCheckoutSession({ id: "cs_1", payment_status: "unpaid", metadata: {} }),
    ).resolves.toEqual({ ok: false, reason: "not_paid" });
    await expect(
      fulfillTopUpCheckoutSession(
        {
          id: "cs_1",
          payment_status: "no_payment_required",
          status: "complete",
          amount_total: 1,
          metadata: {},
        },
        { db },
      ),
    ).resolves.toEqual({ ok: false, reason: "not_paid" });
    expect(db.execute).not.toHaveBeenCalled();
    await expect(
      fulfillTopUpCheckoutSession({ id: "cs_1", payment_status: "paid", metadata: {} }),
    ).resolves.toEqual({ ok: false, reason: "missing_metadata" });
  });

  it("fulfills a completed top-up discounted to zero", async () => {
    const db = fakeDb([
      { checkoutRecordId: "goat_chk_1", amountCents: 1_000, balanceCents: 1_500 },
    ]);

    await expect(
      fulfillTopUpCheckoutSession(
        {
          id: "cs_free_1",
          payment_status: "no_payment_required",
          status: "complete",
          amount_total: 0,
          metadata: {
            checkoutRecordId: "goat_chk_1",
            workspaceId: "goat_ws_1",
            userWorkosId: "user_1",
            amountCents: "1000",
          },
        },
        { eventId: "evt_free_1", db },
      ),
    ).resolves.toEqual({
      ok: true,
      checkoutRecordId: "goat_chk_1",
      amountCents: 1_000,
      balanceCents: 1_500,
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("reports a replayed auto-refill PaymentIntent as a duplicate", async () => {
    // Both the synchronous confirm path and the payment_intent.succeeded
    // webhook credit with the same pi:{id} idempotency key; the second call
    // must be a no-op.
    const db = fakeDb([]);
    const result = await recordAutoRefillCredit({
      workspaceId: "goat_ws_1",
      amountCents: 2_000,
      paymentIntentId: "pi_123",
      db,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("credits an auto-refill charge and returns the new balance", async () => {
    const db = fakeDb([{ ledgerId: 42, balanceUsdMicros: "21000000" }]);
    const result = await recordAutoRefillCredit({
      workspaceId: "goat_ws_1",
      amountCents: 2_000,
      paymentIntentId: "pi_456",
      db,
    });
    expect(result).toEqual({ ok: true, ledgerId: 42, balanceUsdMicros: 21_000_000 });
  });

  it("coerces spend-breakdown aggregates to numbers", async () => {
    const db = fakeDb([
      {
        day: "2026-07-19",
        category: "ingestion",
        spendUsdMicros: "124000",
        providerCostUsdMicros: "100000",
        platformFeeUsdMicros: "24000",
      },
    ]);
    await expect(loadSpendBreakdown("goat_ws_1", { db })).resolves.toEqual([
      {
        day: "2026-07-19",
        category: "ingestion",
        spendUsdMicros: 124_000,
        providerCostUsdMicros: 100_000,
        platformFeeUsdMicros: 24_000,
      },
    ]);
  });

  it("queries an inclusive 30-day UTC reporting window", async () => {
    const db = fakeDb([]);
    await loadSpendBreakdown("workspace_1", {
      db,
      days: 30,
      now: new Date("2026-09-03T18:00:00.000Z"),
    });

    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(db.execute.mock.calls[0]![0] as SQL);
    expect(query.params).toContain("2026-08-05T00:00:00.000Z");
  });

  it("keeps paid capability spend in its own usage category", async () => {
    const db = fakeDb([
      {
        day: "2026-07-23",
        category: "capabilities",
        spendUsdMicros: "360000",
        providerCostUsdMicros: "300000",
        platformFeeUsdMicros: "60000",
      },
    ]);
    await expect(loadSpendBreakdown("goat_ws_1", { db })).resolves.toEqual([
      {
        day: "2026-07-23",
        category: "capabilities",
        spendUsdMicros: 360_000,
        providerCostUsdMicros: 300_000,
        platformFeeUsdMicros: 60_000,
      },
    ]);
  });
});

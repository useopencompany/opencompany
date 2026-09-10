import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCreditOverview, loadSpendBreakdown, recordCreditDebit } from "./credits";

describe("workspace usage spend", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    database = new PGlite();
    db = drizzle(database);
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.credit_ledger (
        id serial PRIMARY KEY, workspace_id text NOT NULL, user_workos_id text,
        amount_cents integer NOT NULL, amount_usd_micros bigint NOT NULL,
        source text NOT NULL, idempotency_key text UNIQUE NOT NULL,
        chat_session_id text, ingest_job_id text, reservation_id text,
        provider_cost_usd_micros bigint NOT NULL DEFAULT 0,
        platform_fee_usd_micros bigint NOT NULL DEFAULT 0,
        cost_basis jsonb NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE goat.credit_balances (
        workspace_id text PRIMARY KEY, balance_cents integer NOT NULL,
        balance_usd_micros bigint NOT NULL, included_balance_usd_micros bigint NOT NULL,
        top_up_balance_usd_micros bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO goat.credit_balances VALUES ('workspace', 500, 5000000, 5000000, 0, now());
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it("attributes a sandbox debit once and exposes it in both spend views", async () => {
    const input = {
      workspaceId: "workspace",
      userWorkosId: "user",
      source: "sandbox_usage" as const,
      idempotencyKey: "sandbox:interval",
      providerCostUsdMicros: 100_000,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 100_000,
      costBasis: { kind: "sandbox_usage" },
      db,
    };
    expect(await recordCreditDebit(input)).toMatchObject({ ok: true, balanceUsdMicros: 4_900_000 });
    expect(await recordCreditDebit(input)).toEqual({ ok: false, reason: "duplicate" });
    expect(await loadSpendBreakdown("workspace", { db })).toEqual([
      expect.objectContaining({ category: "sandbox", spendUsdMicros: 100_000 }),
    ]);
    expect(await loadCreditOverview("workspace", { db })).toMatchObject({
      balanceUsdMicros: 4_900_000,
      spendThisMonthUsdMicros: 100_000,
      spendThisMonthByCategory: { chat: 0, ingestion: 0, capabilities: 0, sandbox: 100_000 },
    });
    expect(await loadSpendBreakdown("other-workspace", { db })).toEqual([]);
    expect((await database.query("SELECT user_workos_id FROM goat.credit_ledger")).rows).toEqual([
      { user_workos_id: "user" },
    ]);
  });

  it("counts usage sources while keeping expirations and adjustments out of spend", async () => {
    const sources = [
      "chat_model_usage",
      "capability_usage",
      "sandbox_usage",
      "ingest_model_usage",
      "ingest_fee",
      "frontier_ingest",
      "ingest_overage",
      "included_usage_expiration",
      "seat_included_expiration",
      "adjustment",
    ];
    for (const source of sources) {
      await database.query(
        `
        INSERT INTO goat.credit_ledger
          (workspace_id, amount_cents, amount_usd_micros, source, idempotency_key)
        VALUES ('workspace', -10, -100000, $1, $1)
      `,
        [source],
      );
    }
    const breakdown = await loadSpendBreakdown("workspace", { db });
    expect(breakdown.map(({ category, spendUsdMicros }) => ({ category, spendUsdMicros }))).toEqual(
      [
        { category: "capabilities", spendUsdMicros: 100_000 },
        { category: "chat", spendUsdMicros: 100_000 },
        { category: "ingestion", spendUsdMicros: 400_000 },
        { category: "sandbox", spendUsdMicros: 100_000 },
      ],
    );
    const overview = await loadCreditOverview("workspace", { db });
    expect(overview.spendThisMonthUsdMicros).toBe(700_000);
    expect(overview.recentEntries).toHaveLength(sources.length);
  });
});

import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { calculateSandboxUsageCost } from "@opencompany/billing";
import { loadCreditOverview, loadSpendBreakdown } from "@opencompany/db/credits";
import { drizzle } from "drizzle-orm/pglite";
import { SandboxNotFoundError } from "e2b";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSandboxBilling,
  type SandboxBillingDb,
  type SandboxBillingSnapshot,
  settleSandboxBilling,
} from "./sandbox-billing";
import { billRegisteredSandbox, pollSandboxBilling } from "./sandbox-billing-worker";

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const start = new Date("2026-09-10T12:00:00Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
const owner = { namespace: "test", workspaceId: "workspace_1", userWorkosId: "user_1" };
const snapshot = (overrides: Partial<SandboxBillingSnapshot> = {}): SandboxBillingSnapshot => ({
  sandboxId: "sandbox_1",
  templateId: "custom-template",
  startedAt: start,
  endAt: at(3600),
  state: "running",
  cpuCount: 2,
  memoryMB: 16_384,
  ...overrides,
});
const price = (activeMs: number, vcpu = 2, ramMiB = 16_384) =>
  calculateSandboxUsageCost({ vcpu, ramMiB, activeMs }).totalCostUsdMicros;

describe("E2B workspace billing", () => {
  let database: PGlite;
  let db: SandboxBillingDb;

  beforeEach(async () => {
    database = new PGlite();
    db = drizzle(database) as unknown as SandboxBillingDb;
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      INSERT INTO goat.users VALUES ('user_1'), ('user_2');
      INSERT INTO goat.workspaces VALUES ('workspace_1'), ('workspace_2');
      CREATE TABLE goat.credit_ledger (
        id serial PRIMARY KEY, workspace_id text NOT NULL, user_workos_id text,
        amount_cents integer NOT NULL, amount_usd_micros bigint NOT NULL,
        source text NOT NULL, idempotency_key text UNIQUE NOT NULL,
        chat_session_id text, ingest_job_id text, reservation_id text,
        provider_cost_usd_micros bigint NOT NULL DEFAULT 0,
        platform_fee_usd_micros bigint NOT NULL DEFAULT 0,
        cost_basis jsonb NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT '2026-09-10T12:00:00Z'
      );
      CREATE TABLE goat.credit_balances (
        workspace_id text PRIMARY KEY, balance_cents integer NOT NULL,
        balance_usd_micros bigint NOT NULL, included_balance_usd_micros bigint NOT NULL,
        top_up_balance_usd_micros bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO goat.credit_balances VALUES ('workspace_1', 500, 5000000, 5000000, 0, now());
    `);
    await database.exec(
      await readFile(
        new URL("../../../drizzle/0265_sandbox_billing_cursors.sql", import.meta.url),
        "utf8",
      ),
    );
    await registerSandboxBilling({ ...owner, sandboxId: "sandbox_1", billableFrom: start, db });
  });

  afterEach(async () => {
    await database.close();
  });

  const settle = (seconds: number, overrides: Partial<SandboxBillingSnapshot> = {}) =>
    settleSandboxBilling({ snapshot: snapshot(overrides), observedAt: at(seconds), db });

  it("charges allocated compute once to the workspace and user without a chat session", async () => {
    expect(await settle(60)).toBe(price(60_000));
    expect(await settle(60)).toBe(0);
    expect(await settle(30)).toBe(0);
    expect(await settle(120)).toBe(price(120_000) - price(60_000));
    const overview = await loadCreditOverview(owner.workspaceId, { db, now: at(120) });
    expect(overview.balanceUsdMicros).toBe(5_000_000 - price(120_000));
    expect(overview.spendThisMonthByCategory.sandbox).toBe(price(120_000));
    expect(await loadSpendBreakdown("workspace_2", { db, now: at(120) })).toEqual([]);
    const ledger = await database.query(
      "SELECT user_workos_id, chat_session_id, metadata, cost_basis FROM goat.credit_ledger",
    );
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]).toMatchObject({
      user_workos_id: "user_1",
      chat_session_id: null,
      metadata: { provider: "e2b", sandboxId: "sandbox_1" },
      cost_basis: { vcpu: 2, ramMiB: 16_384, activeMs: 60_000 },
    });
  });

  it("settles the pause endpoint and excludes paused time after resuming", async () => {
    await settle(30);
    await settle(120, { state: "paused", endAt: at(45) });
    expect(await settle(300, { state: "paused", endAt: at(45) })).toBe(0);
    expect(await settle(660, { startedAt: at(600), cpuCount: 4, memoryMB: 4096 })).toBe(
      price(60_000, 4, 4096),
    );
    // A late response from the previous interval cannot reset the resume cursor.
    expect(await settle(700, { state: "paused", endAt: at(45) })).toBe(0);
    const overview = await loadCreditOverview(owner.workspaceId, { db, now: at(700) });
    expect(overview.spendThisMonthUsdMicros).toBe(price(45_000) + price(60_000, 4, 4096));
  });

  it("serializes competing settlement attempts without duplicate debits", async () => {
    const charges = await Promise.all([settle(60), settle(60), settle(120), settle(120)]);
    expect(charges.reduce((sum, amount) => sum + amount, 0)).toBe(price(120_000));
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(120) })).spendThisMonthUsdMicros,
    ).toBe(price(120_000));
  });

  it("does not backbill an existing sandbox when billing starts or ownership is registered again", async () => {
    await settle(60, { startedAt: at(-3600) });
    await registerSandboxBilling({ ...owner, sandboxId: "sandbox_1", billableFrom: at(60), db });
    await settle(120, { startedAt: at(-3600) });
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(120) })).spendThisMonthUsdMicros,
    ).toBe(price(120_000));
    await expect(
      registerSandboxBilling({
        ...owner,
        workspaceId: "workspace_2",
        sandboxId: "sandbox_1",
        billableFrom: start,
        db,
      }),
    ).rejects.toThrow("registered owner");
  });

  it("rolls the debit and cursor back together and can retry after a database failure", async () => {
    await database.exec(`
      CREATE FUNCTION fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'cursor update unavailable'; END; $$;
      CREATE TRIGGER fail_cursor BEFORE UPDATE OF settled_through ON goat.sandbox_billing_cursors
      FOR EACH ROW EXECUTE FUNCTION fail_cursor();
    `);
    await expect(settle(60)).rejects.toThrow();
    expect(
      (await database.query("SELECT count(*)::int AS count FROM goat.credit_ledger")).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(60) })).balanceUsdMicros,
    ).toBe(5_000_000);
    await database.exec("DROP TRIGGER fail_cursor ON goat.sandbox_billing_cursors");
    expect(await settle(60)).toBe(price(60_000));
  });

  it("preserves rounding across repeated sub-second polls", async () => {
    for (let i = 1; i <= 20; i++) await settle(i / 100);
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(1) })).spendThisMonthUsdMicros,
    ).toBe(price(200));
  });

  it("attributes separate users' sandboxes to their shared workspace balance", async () => {
    await registerSandboxBilling({
      ...owner,
      userWorkosId: "user_2",
      sandboxId: "sandbox_2",
      billableFrom: start,
      db,
    });
    await settle(60);
    await settle(60, { sandboxId: "sandbox_2" });
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(60) })).balanceUsdMicros,
    ).toBe(5_000_000 - 2 * price(60_000));
    expect(
      (await database.query("SELECT user_workos_id FROM goat.credit_ledger ORDER BY id")).rows,
    ).toEqual([{ user_workos_id: "user_1" }, { user_workos_id: "user_2" }]);
  });

  it("waits for a completed pause snapshot and rejects invalid provider allocations", async () => {
    expect(await settle(60, { state: "paused" })).toBe(0);
    await expect(settle(60, { memoryMB: 0 })).rejects.toThrow("Invalid E2B");
    await expect(settle(60, { cpuCount: Number.NaN })).rejects.toThrow("Invalid E2B");
    await expect(settle(60, { startedAt: new Date("invalid") })).rejects.toThrow("timestamp");
    expect(await settle(7200)).toBe(price(3_600_000));
  });

  it("claims only due sandboxes in this namespace and keeps failed polls retryable", async () => {
    await registerSandboxBilling({
      ...owner,
      namespace: "other",
      sandboxId: "sandbox_other",
      billableFrom: start,
      db,
    });
    await database.exec(
      "UPDATE goat.sandbox_billing_cursors SET next_poll_at = '2026-09-10T12:00:00Z'",
    );
    const getInfo = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const input = { namespace: "test", signal: new AbortController().signal, db, getInfo };
    await pollSandboxBilling({ ...input, now: at(0) });
    await pollSandboxBilling({ ...input, now: at(30) });
    expect(getInfo).toHaveBeenCalledTimes(1);
    expect(getInfo).toHaveBeenCalledWith("sandbox_1", input.signal);
    await pollSandboxBilling({ ...input, now: at(60) });
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(
      (
        await database.query(
          "SELECT settled_through FROM goat.sandbox_billing_cursors WHERE sandbox_id = 'sandbox_1'",
        )
      ).rows,
    ).toEqual([{ settled_through: null }]);
    await pollSandboxBilling({
      ...input,
      now: at(120),
      getInfo: async () => snapshot({ state: "paused", endAt: at(45) }),
    });
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(120) })).spendThisMonthUsdMicros,
    ).toBe(price(45_000));
  });

  it("does not guess charges for deleted sandboxes and reactivates registration on reuse", async () => {
    await settle(30);
    await billRegisteredSandbox("sandbox_1", {
      db,
      observedAt: at(60),
      getInfo: async () => {
        throw new SandboxNotFoundError("gone");
      },
    });
    const getInfo = vi.fn(async () => snapshot());
    await pollSandboxBilling({
      db,
      namespace: "test",
      signal: new AbortController().signal,
      now: at(3600),
      getInfo,
    });
    expect(getInfo).not.toHaveBeenCalled();
    expect(
      (await loadCreditOverview(owner.workspaceId, { db, now: at(3600) })).spendThisMonthUsdMicros,
    ).toBe(price(30_000));
    await registerSandboxBilling({ ...owner, sandboxId: "sandbox_1", billableFrom: at(3600), db });
    expect(
      (await database.query("SELECT missing_at FROM goat.sandbox_billing_cursors")).rows,
    ).toEqual([{ missing_at: null }]);
  });
});

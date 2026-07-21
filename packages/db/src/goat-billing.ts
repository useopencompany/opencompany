import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { getDb } from "./client";
import {
  type GoatBrainSourceProvider,
  goatBrainIngestJobs,
  goatCreditBalances,
  goatWorkspaceBilling,
  goatWorkspaceIngestionReservations,
  goatWorkspaceMembers,
} from "./goat-schema";

type DbLike = any;

export {
  GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS,
  GOAT_INGEST_ITEM_FEE_USD_MICROS,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  GOAT_MAX_MEMBERS,
  goatIngestItemFeeUsdMicros,
} from "./goat-billing-constants";

import {
  GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS,
  GOAT_INGEST_ITEM_FEE_USD_MICROS,
  goatIngestItemFeeUsdMicros,
} from "./goat-billing-constants";
import { GOAT_USD_MICROS_PER_CENT, getGoatCreditBalanceUsdMicros } from "./goat-credits";

// The default web-app client (`./client`) is neon-http, which has no interactive
// transactions (one HTTPS request per query) and throws on db.transaction().
// Run the mutation steps sequentially there; pooled callers (the runner) keep a
// real transaction. Mirrors runAtomically() in ./goat-brain-files.
function runAtomically<T>(db: DbLike, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (db instanceof NeonHttpDatabase) return fn(db);
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(fn);
}

// The chat 402 gate and the ingestion balance>0 admission gate stay dormant
// until this flag is on, so prod cannot hard-stop users before credit top-ups
// are purchasable (GOAT_STRIPE_CHECKOUT_ENABLED). Usage debits always record.
export function isGoatCreditsEnforcementEnabled() {
  return process.env.GOAT_CREDITS_ENFORCEMENT_ENABLED === "true";
}

export function goatCalendarMonthWindow(now: Date) {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const resetAt = new Date(start);
  resetAt.setUTCMonth(resetAt.getUTCMonth() + 1);
  return { start, resetAt };
}

async function ensureBillingRow(workspaceId: string, db: DbLike) {
  await db
    .insert(goatWorkspaceBilling)
    .values({ workspaceId })
    .onConflictDoNothing({ target: goatWorkspaceBilling.workspaceId });
  const [billing] = await db
    .select()
    .from(goatWorkspaceBilling)
    .where(eq(goatWorkspaceBilling.workspaceId, workspaceId))
    .limit(1);
  if (!billing) throw new Error(`Billing state is missing for Goat workspace ${workspaceId}.`);
  return billing;
}

async function lockWorkspace(workspaceId: string, db: DbLike) {
  await db.execute(sql`SELECT id FROM goat.workspaces WHERE id = ${workspaceId} FOR UPDATE`);
}

// Admit a pending reservation by charging the flat per-item ingestion fee.
// Ledger insert, balance update, and the pending → consumed flip run in ONE
// statement, so money only ever moves together with the admission — a crash
// can only leave the safe paused state. With enforcement on, admission
// requires a positive balance (locked so concurrent reservations re-check the
// latest value); with enforcement off everything is admitted but the fee still
// records, matching the chat debit path. The fee is charged once per
// reservation — never per retry — which is why it lives here and not in the
// per-attempt model-cost debit.
async function tryAdmitGoatIngestion(
  input: { reservationId: string; workspaceId: string; rawEventCount: number; now: Date },
  db: DbLike,
) {
  const feeUsdMicros = goatIngestItemFeeUsdMicros(input.rawEventCount);
  const feeCents = Math.round(feeUsdMicros / GOAT_USD_MICROS_PER_CENT);
  const requirePositiveBalance = isGoatCreditsEnforcementEnabled();
  const costBasis = {
    kind: "ingest_fee",
    rawEventCount: input.rawEventCount,
    usdMicrosPerRawEvent: GOAT_INGEST_ITEM_FEE_USD_MICROS,
  };
  const result = await db.execute(sql`
    WITH locked_balance AS MATERIALIZED (
      SELECT workspace_id, balance_usd_micros
      FROM goat.credit_balances
      WHERE workspace_id = ${input.workspaceId}
      FOR UPDATE
    ),
    flipped AS (
      UPDATE goat.workspace_ingestion_reservations AS reservation
      SET status = 'consumed',
          consumed_at = ${input.now.toISOString()},
          updated_at = ${input.now.toISOString()}
      WHERE reservation.id = ${input.reservationId}
        AND reservation.workspace_id = ${input.workspaceId}
        AND reservation.status = 'pending'
        AND (
          NOT ${requirePositiveBalance}
          OR EXISTS (SELECT 1 FROM locked_balance WHERE balance_usd_micros > 0)
        )
      RETURNING reservation.id, reservation.workspace_id
    ),
    debit AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        amount_cents,
        amount_usd_micros,
        source,
        idempotency_key,
        reservation_id,
        provider_cost_usd_micros,
        platform_fee_usd_micros,
        cost_basis
      )
      SELECT
        workspace_id,
        ${-feeCents},
        ${-feeUsdMicros},
        'ingest_fee',
        ${`ingest_fee:${input.reservationId}`},
        id,
        0,
        ${feeUsdMicros},
        ${JSON.stringify(costBasis)}::jsonb
      FROM flipped
      ON CONFLICT DO NOTHING
      RETURNING workspace_id, amount_usd_micros
    ),
    balance AS (
      INSERT INTO goat.credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT workspace_id, ${-feeCents}, amount_usd_micros, now()
      FROM debit
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          balance_cents = ROUND((goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros)::numeric / ${GOAT_USD_MICROS_PER_CENT})::integer,
          updated_at = now()
      RETURNING workspace_id
    )
    SELECT flipped.id AS "reservationId"
    FROM flipped
  `);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
  return rows.length > 0;
}

export async function reserveGoatWorkspaceIngestion(input: {
  workspaceId: string;
  sourceItemId: string;
  sourceProvider: GoatBrainSourceProvider;
  rawEventCount: number;
  now?: Date;
  db?: DbLike;
}) {
  if (
    !Number.isInteger(input.rawEventCount) ||
    input.rawEventCount < 1 ||
    input.rawEventCount > 200
  ) {
    throw new Error("Goat ingestion raw event count must be between 1 and 200.");
  }
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const run = async (tx: DbLike) => {
    await lockWorkspace(input.workspaceId, tx);
    const [pendingUsage] = await tx
      .select({
        total: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.rawEventCount}), 0)::integer`,
      })
      .from(goatWorkspaceIngestionReservations)
      .where(
        and(
          eq(goatWorkspaceIngestionReservations.workspaceId, input.workspaceId),
          eq(goatWorkspaceIngestionReservations.status, "pending"),
        ),
      );
    const pendingBefore = Number(pendingUsage?.total ?? 0);
    const [inserted] = await tx
      .insert(goatWorkspaceIngestionReservations)
      .values({
        id: `gir_${randomUUID().replace(/-/g, "")}`,
        workspaceId: input.workspaceId,
        sourceItemId: input.sourceItemId,
        sourceProvider: input.sourceProvider,
        rawEventCount: input.rawEventCount,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      // Once a workspace has a backlog, newer work must remain behind it (FIFO)
      // even if the balance could cover it; the paused backlog is drained by
      // releasePendingForWorkspace instead.
      const admitted =
        pendingBefore === 0 &&
        (await tryAdmitGoatIngestion(
          {
            reservationId: inserted.id,
            workspaceId: input.workspaceId,
            rawEventCount: input.rawEventCount,
            now,
          },
          tx,
        ));
      return {
        reservation: admitted
          ? { ...inserted, status: "consumed" as const, consumedAt: now }
          : inserted,
        pendingUnits: pendingBefore + (admitted ? 0 : input.rawEventCount),
        paused: !admitted,
        created: true as const,
      };
    }
    const [existing] = await tx
      .select()
      .from(goatWorkspaceIngestionReservations)
      .where(
        and(
          eq(goatWorkspaceIngestionReservations.workspaceId, input.workspaceId),
          eq(goatWorkspaceIngestionReservations.sourceItemId, input.sourceItemId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Could not load the Goat ingestion reservation.");
    return {
      reservation: existing,
      pendingUnits: pendingBefore,
      paused: existing.status === "pending",
      created: false as const,
    };
  };
  return input.db ? run(db) : runAtomically(db, run);
}

// Drain the paused FIFO backlog while the balance admits it (with enforcement
// off, everything drains). Called by the hourly reconcile cron and directly
// after a top-up / auto-refill so resume is immediate. Stops at the first
// reservation that cannot be admitted — releasing anything behind it would
// jump the queue.
export async function releasePendingForWorkspace(
  workspaceId: string,
  now: Date = new Date(),
  db: DbLike = getDb(),
) {
  return runAtomically(db, async (tx: DbLike) => {
    await lockWorkspace(workspaceId, tx);
    const pending = await tx
      .select()
      .from(goatWorkspaceIngestionReservations)
      .where(
        and(
          eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
          eq(goatWorkspaceIngestionReservations.status, "pending"),
        ),
      )
      .orderBy(
        asc(goatWorkspaceIngestionReservations.createdAt),
        asc(goatWorkspaceIngestionReservations.id),
      );
    const released: typeof pending = [];
    for (const reservation of pending) {
      const admitted = await tryAdmitGoatIngestion(
        {
          reservationId: reservation.id,
          workspaceId,
          rawEventCount: reservation.rawEventCount,
          now,
        },
        tx,
      );
      if (!admitted) break;
      released.push(reservation);
    }
    if (released.length === 0) return 0;
    await tx
      .update(goatBrainIngestJobs)
      .set({ planPaused: false, updatedAt: now })
      .where(
        and(
          eq(goatBrainIngestJobs.workspaceId, workspaceId),
          inArray(
            goatBrainIngestJobs.sourceItemId,
            released.map((reservation: { sourceItemId: string }) => reservation.sourceItemId),
          ),
          eq(goatBrainIngestJobs.planPaused, true),
        ),
      );
    return released.length;
  });
}

export async function releasePendingGoatIngestionReservations(
  input: { now?: Date; maxWorkspaces?: number; db?: DbLike } = {},
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const oldestPendingAt = sql<Date>`min(${goatWorkspaceIngestionReservations.createdAt})`;
  // Oldest backlog first, so a sweep capped by maxWorkspaces cannot starve the
  // same workspaces every run when more than one page of backlogs exists.
  const rows = await db
    .select({ workspaceId: goatWorkspaceIngestionReservations.workspaceId })
    .from(goatWorkspaceIngestionReservations)
    .where(eq(goatWorkspaceIngestionReservations.status, "pending"))
    .groupBy(goatWorkspaceIngestionReservations.workspaceId)
    .orderBy(oldestPendingAt)
    .limit(input.maxWorkspaces ?? 50);
  let released = 0;
  let failed = 0;
  for (const row of rows) {
    // One workspace's failure (lock timeout, transient DB error) must not
    // abort the sweep for every other paused workspace.
    try {
      released += await releasePendingForWorkspace(row.workspaceId, now, db);
    } catch (error) {
      failed += 1;
      console.error(
        `Failed to release the paused Goat ingestion backlog for workspace ${row.workspaceId}.`,
        error,
      );
    }
  }
  return { released, failed };
}

export async function loadGoatBillingOverview(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const now = new Date();
  const billing = await ensureBillingRow(workspaceId, db);
  const { start: monthStart } = goatCalendarMonthWindow(now);
  const [usage, pending, providerRows, recentRows, memberCountRows, creditBalance] =
    await Promise.all([
      db
        .select({
          total: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.rawEventCount}), 0)::integer`,
        })
        .from(goatWorkspaceIngestionReservations)
        .where(
          and(
            eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
            eq(goatWorkspaceIngestionReservations.status, "consumed"),
            gte(goatWorkspaceIngestionReservations.consumedAt, monthStart),
          ),
        ),
      db
        .select({
          total: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.rawEventCount}), 0)::integer`,
        })
        .from(goatWorkspaceIngestionReservations)
        .where(
          and(
            eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
            eq(goatWorkspaceIngestionReservations.status, "pending"),
          ),
        ),
      db
        .select({
          provider: goatWorkspaceIngestionReservations.sourceProvider,
          total: sql<number>`sum(${goatWorkspaceIngestionReservations.rawEventCount})::integer`,
        })
        .from(goatWorkspaceIngestionReservations)
        .where(
          and(
            eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
            eq(goatWorkspaceIngestionReservations.status, "consumed"),
            gte(goatWorkspaceIngestionReservations.consumedAt, monthStart),
          ),
        )
        .groupBy(goatWorkspaceIngestionReservations.sourceProvider),
      db
        .select({
          id: goatWorkspaceIngestionReservations.id,
          provider: goatWorkspaceIngestionReservations.sourceProvider,
          rawEventCount: goatWorkspaceIngestionReservations.rawEventCount,
          status: goatWorkspaceIngestionReservations.status,
          createdAt: goatWorkspaceIngestionReservations.createdAt,
          consumedAt: goatWorkspaceIngestionReservations.consumedAt,
        })
        .from(goatWorkspaceIngestionReservations)
        .where(eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId))
        .orderBy(desc(goatWorkspaceIngestionReservations.createdAt))
        .limit(20),
      db
        .select({ total: sql<number>`count(*)::integer` })
        .from(goatWorkspaceMembers)
        .where(eq(goatWorkspaceMembers.workspaceId, workspaceId)),
      getGoatCreditBalanceUsdMicros(workspaceId, db),
    ]);
  return {
    billing,
    memberCount: Number(memberCountRows[0]?.total ?? 0),
    creditBalanceUsdMicros: creditBalance,
    ingestedThisMonth: Number(usage[0]?.total ?? 0),
    pending: Number(pending[0]?.total ?? 0),
    providers: providerRows.map((row: { provider: GoatBrainSourceProvider; total: number }) => ({
      provider: row.provider,
      count: Number(row.total),
    })),
    recent: recentRows,
    autoRefill: {
      enabled: billing.autoRefillEnabled,
      amountCents: billing.autoRefillAmountCents,
      hasPaymentMethod: Boolean(billing.autoRefillPaymentMethodId),
      lastError: billing.autoRefillLastError,
    },
  };
}

export async function setGoatStripeCustomerId(
  input: { workspaceId: string; stripeCustomerId: string },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await ensureBillingRow(input.workspaceId, db);
  const [updated] = await db
    .update(goatWorkspaceBilling)
    .set({ stripeCustomerId: input.stripeCustomerId, updatedAt: new Date() })
    .where(
      and(
        eq(goatWorkspaceBilling.workspaceId, input.workspaceId),
        sql`${goatWorkspaceBilling.stripeCustomerId} IS NULL`,
      ),
    )
    .returning({ stripeCustomerId: goatWorkspaceBilling.stripeCustomerId });
  if (updated?.stripeCustomerId) return updated.stripeCustomerId;
  const [current] = await db
    .select({ stripeCustomerId: goatWorkspaceBilling.stripeCustomerId })
    .from(goatWorkspaceBilling)
    .where(eq(goatWorkspaceBilling.workspaceId, input.workspaceId))
    .limit(1);
  return current?.stripeCustomerId ?? null;
}

export async function getGoatStripeCustomerId(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const [row] = await db
    .select({ stripeCustomerId: goatWorkspaceBilling.stripeCustomerId })
    .from(goatWorkspaceBilling)
    .where(eq(goatWorkspaceBilling.workspaceId, workspaceId))
    .limit(1);
  return row?.stripeCustomerId ?? null;
}

// ---------------------------------------------------------------------------
// Auto-refill: a card saved during top-up Checkout is charged off-session when
// the balance drops below GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS. The lease
// (auto_refill_in_flight_at) makes concurrent triggers charge at most once;
// last_attempt_at paces retries so a transient Stripe failure cannot loop.

const GOAT_AUTO_REFILL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export async function setGoatAutoRefillPaymentMethod(
  input: { workspaceId: string; paymentMethodId: string },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await ensureBillingRow(input.workspaceId, db);
  await db
    .update(goatWorkspaceBilling)
    .set({
      autoRefillPaymentMethodId: input.paymentMethodId,
      autoRefillLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(goatWorkspaceBilling.workspaceId, input.workspaceId));
}

// Enabling requires a saved card; returns null when there is none yet.
export async function setGoatAutoRefillConfig(
  input: { workspaceId: string; enabled: boolean; amountCents: number },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await ensureBillingRow(input.workspaceId, db);
  const [updated] = await db
    .update(goatWorkspaceBilling)
    .set({
      autoRefillEnabled: input.enabled,
      autoRefillAmountCents: input.amountCents,
      ...(input.enabled ? { autoRefillLastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(goatWorkspaceBilling.workspaceId, input.workspaceId),
        ...(input.enabled ? [isNotNull(goatWorkspaceBilling.autoRefillPaymentMethodId)] : []),
      ),
    )
    .returning({
      enabled: goatWorkspaceBilling.autoRefillEnabled,
      amountCents: goatWorkspaceBilling.autoRefillAmountCents,
    });
  return updated ?? null;
}

// Single-statement lease claim: returns the charge config exactly once per
// cooldown window, or null when auto-refill is off, unconfigured, already in
// flight, or attempted too recently.
export async function claimGoatAutoRefill(
  workspaceId: string,
  options: { now?: Date; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const retryBefore = new Date(now.getTime() - GOAT_AUTO_REFILL_RETRY_COOLDOWN_MS);
  const [claimed] = await db
    .update(goatWorkspaceBilling)
    .set({ autoRefillInFlightAt: now, autoRefillLastAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(goatWorkspaceBilling.workspaceId, workspaceId),
        eq(goatWorkspaceBilling.autoRefillEnabled, true),
        isNotNull(goatWorkspaceBilling.autoRefillPaymentMethodId),
        isNotNull(goatWorkspaceBilling.stripeCustomerId),
        or(
          isNull(goatWorkspaceBilling.autoRefillInFlightAt),
          lt(goatWorkspaceBilling.autoRefillInFlightAt, retryBefore),
        ),
        or(
          isNull(goatWorkspaceBilling.autoRefillLastAttemptAt),
          lt(goatWorkspaceBilling.autoRefillLastAttemptAt, retryBefore),
        ),
      ),
    )
    .returning({
      amountCents: goatWorkspaceBilling.autoRefillAmountCents,
      paymentMethodId: goatWorkspaceBilling.autoRefillPaymentMethodId,
      stripeCustomerId: goatWorkspaceBilling.stripeCustomerId,
    });
  if (!claimed?.paymentMethodId || !claimed.stripeCustomerId) return null;
  return {
    amountCents: Number(claimed.amountCents),
    paymentMethodId: claimed.paymentMethodId,
    stripeCustomerId: claimed.stripeCustomerId,
  };
}

// Release the lease after a charge attempt. A hard decline disables
// auto-refill (never loop on a failing card); the recorded error surfaces in
// the billing UI until the user re-enables.
export async function settleGoatAutoRefill(
  input: { workspaceId: string; error?: string | null; disable?: boolean },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await db
    .update(goatWorkspaceBilling)
    .set({
      autoRefillInFlightAt: null,
      autoRefillLastError: input.error ?? null,
      ...(input.disable ? { autoRefillEnabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(goatWorkspaceBilling.workspaceId, input.workspaceId));
}

// Workspaces due for an auto-refill charge — the reconcile-cron sweep that
// covers debits recorded outside apps/goat (the runner's ingestion debits).
export async function listGoatAutoRefillCandidates(
  options: { now?: Date; limit?: number; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const retryBefore = new Date(now.getTime() - GOAT_AUTO_REFILL_RETRY_COOLDOWN_MS);
  const rows = await db
    .select({ workspaceId: goatWorkspaceBilling.workspaceId })
    .from(goatWorkspaceBilling)
    .innerJoin(
      goatCreditBalances,
      eq(goatCreditBalances.workspaceId, goatWorkspaceBilling.workspaceId),
    )
    .where(
      and(
        eq(goatWorkspaceBilling.autoRefillEnabled, true),
        isNotNull(goatWorkspaceBilling.autoRefillPaymentMethodId),
        isNotNull(goatWorkspaceBilling.stripeCustomerId),
        lt(goatCreditBalances.balanceUsdMicros, GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS),
        or(
          isNull(goatWorkspaceBilling.autoRefillInFlightAt),
          lt(goatWorkspaceBilling.autoRefillInFlightAt, retryBefore),
        ),
        or(
          isNull(goatWorkspaceBilling.autoRefillLastAttemptAt),
          lt(goatWorkspaceBilling.autoRefillLastAttemptAt, retryBefore),
        ),
      ),
    )
    .limit(options.limit ?? 50);
  return rows.map((row: { workspaceId: string }) => row.workspaceId);
}

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { getDb } from "./client";
import {
  type BrainSourceProvider,
  brainIngestJobs,
  creditBalances,
  creditLedger,
  type StripeSubscriptionStatus,
  stripeWebhookEvents,
  type WorkspacePlan,
  workspaceBilling,
  workspaceIngestionReservations,
  workspaceMembers,
} from "./product-schema";

type DbLike = any;

export {
  AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
  AUTO_REFILL_THRESHOLD_USD_MICROS,
  calendarMonthWindow,
  HOBBY_INCLUDED_USAGE_USD_CENTS,
  HOBBY_MAX_MEMBERS,
  INCLUDED_USAGE_PER_SEAT_USD_CENTS,
  INGEST_ITEM_FEE_USD_MICROS,
  includedUsageAllowanceCents,
  ingestItemFeeUsdMicros,
  LOW_BALANCE_WARN_USD_MICROS,
  PRO_MAX_MEMBERS,
  PRO_MONTHLY_PRICE_USD_CENTS,
  PRO_STRIPE_PRODUCT_KEY,
  workspaceMemberCap,
} from "./billing-constants";

import {
  AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
  AUTO_REFILL_THRESHOLD_USD_MICROS,
  calendarMonthWindow,
  INGEST_ITEM_FEE_USD_MICROS,
  includedUsageAllowanceCents,
  ingestItemFeeUsdMicros,
  PRO_STRIPE_PRODUCT_KEY,
} from "./billing-constants";
import { getCreditPoolsUsdMicros, grantMonthlyIncludedUsage, USD_MICROS_PER_CENT } from "./credits";

// The default web-app client (`./client`) is neon-http, which has no interactive
// transactions (one HTTPS request per query) and throws on db.transaction().
// Run the mutation steps sequentially there; pooled callers (the runner) keep a
// real transaction. Mirrors runAtomically() in ./brain-files.
function runAtomically<T>(db: DbLike, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (db instanceof NeonHttpDatabase) return fn(db);
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(fn);
}

// Every workspace receives a monthly included allowance, so credit enforcement
// is part of the billing contract rather than a rollout flag. Keep this helper
// for API responses and call sites that present the state to clients.
export function isCreditsEnforcementEnabled() {
  return true;
}

const PRO_SUBSCRIPTION_STATUSES = new Set<StripeSubscriptionStatus>([
  "active",
  "trialing",
  "past_due",
]);

export function planForSubscriptionStatus(status: StripeSubscriptionStatus | null): WorkspacePlan {
  return status && PRO_SUBSCRIPTION_STATUSES.has(status) ? "pro" : "hobby";
}

async function ensureBillingRow(workspaceId: string, db: DbLike) {
  await db
    .insert(workspaceBilling)
    .values({ workspaceId })
    .onConflictDoNothing({ target: workspaceBilling.workspaceId });
  const [billing] = await db
    .select()
    .from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, workspaceId))
    .limit(1);
  if (!billing)
    throw new Error(`Billing state is missing for opencompany workspace ${workspaceId}.`);
  return billing;
}

export async function ensureMonthlyIncludedUsage(
  workspaceId: string,
  options: { now?: Date; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const billing = await ensureBillingRow(workspaceId, db);
  const plan: WorkspacePlan =
    billing.stripeProductKey === PRO_STRIPE_PRODUCT_KEY && billing.plan === "pro" ? "pro" : "hobby";
  const seatQuantity = plan === "pro" ? Math.max(1, Number(billing.seatQuantity)) : 1;
  const targetAllowanceCents = includedUsageAllowanceCents(plan, seatQuantity);
  const { start, resetAt } = calendarMonthWindow(now);
  const storedStart = billing.includedUsagePeriodStart
    ? new Date(billing.includedUsagePeriodStart)
    : null;
  if (
    storedStart?.getTime() === start.getTime() &&
    Number(billing.includedUsageAllowanceCents) >= targetAllowanceCents
  ) {
    return { ok: false as const, reason: "current" as const, plan, seatQuantity };
  }
  const result = await grantMonthlyIncludedUsage({
    workspaceId,
    plan,
    seatQuantity,
    periodStart: start,
    periodEnd: resetAt,
    db,
  });
  return { ...result, plan, seatQuantity };
}

export async function refreshMonthlyIncludedUsage(
  options: { now?: Date; limit?: number; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const { start } = calendarMonthWindow(now);
  const rows = await db
    .select({ workspaceId: workspaceBilling.workspaceId })
    .from(workspaceBilling)
    .where(
      or(
        isNull(workspaceBilling.includedUsagePeriodStart),
        lt(workspaceBilling.includedUsagePeriodStart, start),
      ),
    )
    .orderBy(sql`${workspaceBilling.includedUsagePeriodStart} ASC NULLS FIRST`)
    .limit(options.limit ?? 500);
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await ensureMonthlyIncludedUsage(row.workspaceId, {
        now,
        db,
      });
      if (result.ok) refreshed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `Failed to refresh monthly usage for opencompany workspace ${row.workspaceId}.`,
        error,
      );
    }
  }
  return { candidates: rows.length, refreshed, failed };
}

async function lockWorkspace(workspaceId: string, db: DbLike) {
  await db.execute(sql`SELECT id FROM goat.workspaces WHERE id = ${workspaceId} FOR UPDATE`);
}

// Admit a pending reservation by charging the flat per-item ingestion fee.
// Ledger insert, balance update, and the pending → consumed flip run in ONE
// statement, so money only ever moves together with the admission — a crash
// can only leave the safe paused state. With enforcement on, admission
// requires a positive balance (locked so concurrent reservations re-check the
// latest value). The fee is charged once per
// reservation — never per retry — which is why it lives here and not in the
// per-attempt model-cost debit.
async function tryAdmitIngestion(
  input: { reservationId: string; workspaceId: string; rawEventCount: number; now: Date },
  db: DbLike,
) {
  const feeUsdMicros = ingestItemFeeUsdMicros(input.rawEventCount);
  if (feeUsdMicros === 0) {
    const result = await db.execute(sql`
      WITH locked_balance AS MATERIALIZED (
        SELECT workspace_id, balance_usd_micros
        FROM goat.credit_balances
        WHERE workspace_id = ${input.workspaceId}
        FOR UPDATE
      )
      UPDATE goat.workspace_ingestion_reservations AS reservation
      SET status = 'consumed',
          consumed_at = ${input.now.toISOString()},
          updated_at = ${input.now.toISOString()}
      WHERE reservation.id = ${input.reservationId}
        AND reservation.workspace_id = ${input.workspaceId}
        AND reservation.status = 'pending'
        AND (
          NOT ${isCreditsEnforcementEnabled()}
          OR EXISTS (SELECT 1 FROM locked_balance WHERE balance_usd_micros > 0)
        )
      RETURNING reservation.id AS "reservationId"
    `);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
    return rows.length > 0;
  }
  const feeCents = Math.round(feeUsdMicros / USD_MICROS_PER_CENT);
  const requirePositiveBalance = isCreditsEnforcementEnabled();
  const costBasis = {
    kind: "ingest_fee",
    rawEventCount: input.rawEventCount,
    usdMicrosPerRawEvent: INGEST_ITEM_FEE_USD_MICROS,
  };
  const result = await db.execute(sql`
    WITH locked_balance AS MATERIALIZED (
      SELECT
        workspace_id,
        balance_usd_micros,
        greatest(included_balance_usd_micros, 0) AS included_balance_usd_micros
      FROM goat.credit_balances
      WHERE workspace_id = ${input.workspaceId}
      FOR UPDATE
    ),
    debit_split AS (
      SELECT
        LEAST(
          ${feeUsdMicros}::bigint,
          COALESCE((SELECT included_balance_usd_micros FROM locked_balance), 0)
        ) AS included_debit,
        ${feeUsdMicros}::bigint - LEAST(
          ${feeUsdMicros}::bigint,
          COALESCE((SELECT included_balance_usd_micros FROM locked_balance), 0)
        ) AS top_up_debit
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
      INSERT INTO goat.credit_balances (
        workspace_id,
        balance_cents,
        balance_usd_micros,
        included_balance_usd_micros,
        top_up_balance_usd_micros,
        updated_at
      )
      SELECT workspace_id, ${-feeCents}, amount_usd_micros, 0, amount_usd_micros, now()
      FROM debit
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          balance_cents = ROUND((goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros)::numeric / ${USD_MICROS_PER_CENT})::integer,
          included_balance_usd_micros = goat.credit_balances.included_balance_usd_micros - (SELECT included_debit FROM debit_split),
          top_up_balance_usd_micros = goat.credit_balances.top_up_balance_usd_micros - (SELECT top_up_debit FROM debit_split),
          updated_at = now()
      RETURNING workspace_id
    )
    SELECT flipped.id AS "reservationId"
    FROM flipped
  `);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
  return rows.length > 0;
}

export async function reserveWorkspaceIngestion(input: {
  workspaceId: string;
  sourceItemId: string;
  sourceProvider: BrainSourceProvider;
  rawEventCount: number;
  now?: Date;
  db?: DbLike;
}) {
  if (
    !Number.isInteger(input.rawEventCount) ||
    input.rawEventCount < 1 ||
    input.rawEventCount > 200
  ) {
    throw new Error("opencompany ingestion raw event count must be between 1 and 200.");
  }
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  await ensureMonthlyIncludedUsage(input.workspaceId, { now, db });
  const run = async (tx: DbLike) => {
    await lockWorkspace(input.workspaceId, tx);
    const [pendingUsage] = await tx
      .select({
        total: sql<number>`coalesce(sum(${workspaceIngestionReservations.rawEventCount}), 0)::integer`,
      })
      .from(workspaceIngestionReservations)
      .where(
        and(
          eq(workspaceIngestionReservations.workspaceId, input.workspaceId),
          eq(workspaceIngestionReservations.status, "pending"),
        ),
      );
    const pendingBefore = Number(pendingUsage?.total ?? 0);
    const [inserted] = await tx
      .insert(workspaceIngestionReservations)
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
        (await tryAdmitIngestion(
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
      .from(workspaceIngestionReservations)
      .where(
        and(
          eq(workspaceIngestionReservations.workspaceId, input.workspaceId),
          eq(workspaceIngestionReservations.sourceItemId, input.sourceItemId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Could not load the opencompany ingestion reservation.");
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
      .from(workspaceIngestionReservations)
      .where(
        and(
          eq(workspaceIngestionReservations.workspaceId, workspaceId),
          eq(workspaceIngestionReservations.status, "pending"),
        ),
      )
      .orderBy(
        asc(workspaceIngestionReservations.createdAt),
        asc(workspaceIngestionReservations.id),
      );
    const released: typeof pending = [];
    for (const reservation of pending) {
      const admitted = await tryAdmitIngestion(
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
      .update(brainIngestJobs)
      .set({ planPaused: false, updatedAt: now })
      .where(
        and(
          eq(brainIngestJobs.workspaceId, workspaceId),
          inArray(
            brainIngestJobs.sourceItemId,
            released.map((reservation: { sourceItemId: string }) => reservation.sourceItemId),
          ),
          eq(brainIngestJobs.planPaused, true),
        ),
      );
    return released.length;
  });
}

export async function releasePendingIngestionReservations(
  input: { now?: Date; maxWorkspaces?: number; db?: DbLike } = {},
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const oldestPendingAt = sql<Date>`min(${workspaceIngestionReservations.createdAt})`;
  // Oldest backlog first, so a sweep capped by maxWorkspaces cannot starve the
  // same workspaces every run when more than one page of backlogs exists.
  const rows = await db
    .select({ workspaceId: workspaceIngestionReservations.workspaceId })
    .from(workspaceIngestionReservations)
    .where(eq(workspaceIngestionReservations.status, "pending"))
    .groupBy(workspaceIngestionReservations.workspaceId)
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
        `Failed to release the paused opencompany ingestion backlog for workspace ${row.workspaceId}.`,
        error,
      );
    }
  }
  return { released, failed };
}

export async function loadBillingOverview(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const now = new Date();
  await ensureMonthlyIncludedUsage(workspaceId, { now, db });
  const billing = await ensureBillingRow(workspaceId, db);
  const { start: monthStart } = calendarMonthWindow(now);
  const [usage, pending, providerRows, recentRows, memberCountRows, creditBalance] =
    await Promise.all([
      db
        .select({
          total: sql<number>`coalesce(sum(${workspaceIngestionReservations.rawEventCount}), 0)::integer`,
        })
        .from(workspaceIngestionReservations)
        .where(
          and(
            eq(workspaceIngestionReservations.workspaceId, workspaceId),
            eq(workspaceIngestionReservations.status, "consumed"),
            gte(workspaceIngestionReservations.consumedAt, monthStart),
          ),
        ),
      db
        .select({
          total: sql<number>`coalesce(sum(${workspaceIngestionReservations.rawEventCount}), 0)::integer`,
        })
        .from(workspaceIngestionReservations)
        .where(
          and(
            eq(workspaceIngestionReservations.workspaceId, workspaceId),
            eq(workspaceIngestionReservations.status, "pending"),
          ),
        ),
      db
        .select({
          provider: workspaceIngestionReservations.sourceProvider,
          total: sql<number>`sum(${workspaceIngestionReservations.rawEventCount})::integer`,
        })
        .from(workspaceIngestionReservations)
        .where(
          and(
            eq(workspaceIngestionReservations.workspaceId, workspaceId),
            eq(workspaceIngestionReservations.status, "consumed"),
            gte(workspaceIngestionReservations.consumedAt, monthStart),
          ),
        )
        .groupBy(workspaceIngestionReservations.sourceProvider),
      db
        .select({
          id: workspaceIngestionReservations.id,
          provider: workspaceIngestionReservations.sourceProvider,
          rawEventCount: workspaceIngestionReservations.rawEventCount,
          status: workspaceIngestionReservations.status,
          createdAt: workspaceIngestionReservations.createdAt,
          consumedAt: workspaceIngestionReservations.consumedAt,
        })
        .from(workspaceIngestionReservations)
        .where(eq(workspaceIngestionReservations.workspaceId, workspaceId))
        .orderBy(desc(workspaceIngestionReservations.createdAt))
        .limit(20),
      db
        .select({ total: sql<number>`count(*)::integer` })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId)),
      getCreditPoolsUsdMicros(workspaceId, db),
    ]);
  return {
    billing: {
      ...billing,
      // v3 Pro rows were intentionally retained when billing v4 retired
      // plans. Only the new product key can confer the new entitlement.
      plan: billing.stripeProductKey === PRO_STRIPE_PRODUCT_KEY ? billing.plan : "hobby",
    },
    memberCount: Number(memberCountRows[0]?.total ?? 0),
    creditBalanceUsdMicros: creditBalance.balanceUsdMicros,
    includedBalanceUsdMicros: creditBalance.includedBalanceUsdMicros,
    topUpBalanceUsdMicros: creditBalance.topUpBalanceUsdMicros,
    ingestedThisMonth: Number(usage[0]?.total ?? 0),
    pending: Number(pending[0]?.total ?? 0),
    providers: providerRows.map((row: { provider: BrainSourceProvider; total: number }) => ({
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

export async function setStripeCustomerId(
  input: { workspaceId: string; stripeCustomerId: string },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await ensureBillingRow(input.workspaceId, db);
  const [updated] = await db
    .update(workspaceBilling)
    .set({ stripeCustomerId: input.stripeCustomerId, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceBilling.workspaceId, input.workspaceId),
        sql`${workspaceBilling.stripeCustomerId} IS NULL`,
      ),
    )
    .returning({ stripeCustomerId: workspaceBilling.stripeCustomerId });
  if (updated?.stripeCustomerId) return updated.stripeCustomerId;
  const [current] = await db
    .select({ stripeCustomerId: workspaceBilling.stripeCustomerId })
    .from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, input.workspaceId))
    .limit(1);
  return current?.stripeCustomerId ?? null;
}

export async function getWorkspacePlan(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const billing = await ensureBillingRow(workspaceId, db);
  return billing.stripeProductKey === PRO_STRIPE_PRODUCT_KEY
    ? (billing.plan as WorkspacePlan)
    : "hobby";
}

// Called only after Stripe has confirmed the subscription-item quantity. This
// repairs missed webhooks and grants the full monthly allowance for newly
// billed seats without making local membership state the billing authority.
export async function reconcileStripeSeatQuantity(
  input: { workspaceId: string; seatQuantity: number },
  options: { now?: Date; db?: DbLike } = {},
) {
  if (!Number.isSafeInteger(input.seatQuantity) || input.seatQuantity < 1) {
    throw new Error("Stripe seat reconciliation requires at least one seat.");
  }
  const db = options.db ?? getDb();
  const billing = await ensureBillingRow(input.workspaceId, db);
  if (
    billing.plan !== "pro" ||
    billing.stripeProductKey !== PRO_STRIPE_PRODUCT_KEY ||
    !billing.subscriptionStatus ||
    !PRO_SUBSCRIPTION_STATUSES.has(billing.subscriptionStatus)
  ) {
    return { ok: false as const, reason: "no_active_subscription" as const };
  }
  await db
    .update(workspaceBilling)
    .set({ seatQuantity: input.seatQuantity, updatedAt: new Date() })
    .where(eq(workspaceBilling.workspaceId, input.workspaceId));
  const { start, resetAt } = calendarMonthWindow(options.now ?? new Date());
  const grant = await grantMonthlyIncludedUsage({
    workspaceId: input.workspaceId,
    plan: "pro",
    seatQuantity: input.seatQuantity,
    periodStart: start,
    periodEnd: resetAt,
    db,
  });
  return { ok: true as const, seatQuantity: input.seatQuantity, grant };
}

export async function listStripeSeatReconciliationCandidates(
  options: { limit?: number; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const rows = await db
    .select({ workspaceId: workspaceBilling.workspaceId })
    .from(workspaceBilling)
    .where(
      and(
        eq(workspaceBilling.plan, "pro"),
        eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
        inArray(workspaceBilling.subscriptionStatus, ["active", "trialing", "past_due"]),
        isNotNull(workspaceBilling.stripeSubscriptionItemId),
      ),
    )
    .orderBy(asc(workspaceBilling.updatedAt))
    .limit(options.limit ?? 100);
  return rows.map((row: { workspaceId: string }) => row.workspaceId);
}

export type StripeSubscriptionProjection = {
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  workspaceId: string;
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string | null;
  priceId: string | null;
  productKey: string;
  status: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  currentPeriodStart: Date | null;
  seatQuantity: number;
};

// Stripe webhooks are the only authority that grants paid seats. Event ids make
// retries harmless, and event creation time prevents delayed events from
// rolling a workspace back to stale subscription state.
export async function applyStripeSubscriptionProjection(
  input: StripeSubscriptionProjection,
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const [recorded] = await tx
      .insert(stripeWebhookEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
        eventCreatedAt: input.eventCreatedAt,
      })
      .onConflictDoNothing()
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (!recorded) return { applied: false as const, reason: "duplicate" as const };

    await lockWorkspace(input.workspaceId, tx);
    const current = await ensureBillingRow(input.workspaceId, tx);
    if (current.lastStripeEventCreated && current.lastStripeEventCreated > input.eventCreatedAt) {
      return { applied: false as const, reason: "stale" as const };
    }

    const isSeatSubscription = input.productKey === PRO_STRIPE_PRODUCT_KEY;
    const plan = isSeatSubscription ? planForSubscriptionStatus(input.status) : "hobby";
    const planChanged = plan !== current.plan;
    const cancellationScheduled = !current.cancelAtPeriodEnd && input.cancelAtPeriodEnd;
    const seatQuantity = Math.max(1, Math.floor(input.seatQuantity));
    await tx
      .update(workspaceBilling)
      .set({
        plan,
        ...(planChanged ? { planStartedAt: input.eventCreatedAt } : {}),
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        stripeSubscriptionItemId: input.subscriptionItemId,
        stripePriceId: input.priceId,
        stripeProductKey: input.productKey,
        seatQuantity,
        subscriptionStatus: input.status,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        currentPeriodEnd: input.currentPeriodEnd,
        paymentNeedsAttention: input.status === "past_due" || input.status === "unpaid",
        ...(plan === "hobby" ? { autoRefillEnabled: false } : {}),
        lastStripeEventCreated: input.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBilling.workspaceId, input.workspaceId));
    let includedUsageGranted = false;
    if (isSeatSubscription && plan === "pro") {
      const { start, resetAt } = calendarMonthWindow(input.eventCreatedAt);
      const grant = await grantMonthlyIncludedUsage({
        workspaceId: input.workspaceId,
        plan,
        seatQuantity,
        periodStart: start,
        periodEnd: resetAt,
        eventId: input.eventId,
        db: tx,
      });
      includedUsageGranted = grant.ok;
    }
    return {
      applied: true as const,
      planChanged,
      plan,
      cancellationScheduled,
      seatQuantity,
      includedUsageGranted,
    };
  });
}

export async function findWorkspaceIdForStripeSubscription(
  subscriptionId: string,
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const [row] = await db
    .select({ workspaceId: workspaceBilling.workspaceId })
    .from(workspaceBilling)
    .where(
      and(
        eq(workspaceBilling.stripeSubscriptionId, subscriptionId),
        eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
      ),
    )
    .limit(1);
  return row?.workspaceId ?? null;
}

export async function applyStripeInvoicePaymentState(
  input: {
    eventId: string;
    eventType: string;
    eventCreatedAt: Date;
    subscriptionId: string;
    needsAttention: boolean;
  },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const [recorded] = await tx
      .insert(stripeWebhookEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
        eventCreatedAt: input.eventCreatedAt,
      })
      .onConflictDoNothing()
      .returning({ eventId: stripeWebhookEvents.eventId });
    if (!recorded) return false;

    const [billing] = await tx
      .select({ workspaceId: workspaceBilling.workspaceId })
      .from(workspaceBilling)
      .where(eq(workspaceBilling.stripeSubscriptionId, input.subscriptionId))
      .limit(1);
    if (!billing) return false;

    await lockWorkspace(billing.workspaceId, tx);
    const current = await ensureBillingRow(billing.workspaceId, tx);
    if (
      current.lastStripeInvoiceEventCreated &&
      current.lastStripeInvoiceEventCreated > input.eventCreatedAt
    ) {
      return false;
    }
    await tx
      .update(workspaceBilling)
      .set({
        paymentNeedsAttention: input.needsAttention,
        lastStripeInvoiceEventCreated: input.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBilling.stripeSubscriptionId, input.subscriptionId));
    return true;
  });
}

export async function getStripeCustomerId(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const [row] = await db
    .select({ stripeCustomerId: workspaceBilling.stripeCustomerId })
    .from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, workspaceId))
    .limit(1);
  return row?.stripeCustomerId ?? null;
}

// ---------------------------------------------------------------------------
// Auto-refill: a card saved during top-up Checkout is charged off-session when
// the balance drops below AUTO_REFILL_THRESHOLD_USD_MICROS. The lease
// (auto_refill_in_flight_at) makes concurrent triggers charge at most once;
// last_attempt_at paces retries so a transient Stripe failure cannot loop.

const AUTO_REFILL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export async function setAutoRefillPaymentMethod(
  input: { workspaceId: string; paymentMethodId: string },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await ensureBillingRow(input.workspaceId, db);
  await db
    .update(workspaceBilling)
    .set({
      autoRefillPaymentMethodId: input.paymentMethodId,
      autoRefillLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaceBilling.workspaceId, input.workspaceId));
}

// Enabling requires a saved card; returns null when there is none yet.
export async function setAutoRefillConfig(
  input: { workspaceId: string; enabled: boolean; amountCents: number },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await ensureBillingRow(input.workspaceId, db);
  const [updated] = await db
    .update(workspaceBilling)
    .set({
      autoRefillEnabled: input.enabled,
      autoRefillAmountCents: input.amountCents,
      ...(input.enabled ? { autoRefillLastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceBilling.workspaceId, input.workspaceId),
        ...(input.enabled ? [isNotNull(workspaceBilling.autoRefillPaymentMethodId)] : []),
        eq(workspaceBilling.plan, "pro"),
        eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
      ),
    )
    .returning({
      enabled: workspaceBilling.autoRefillEnabled,
      amountCents: workspaceBilling.autoRefillAmountCents,
    });
  return updated ?? null;
}

// Single-statement lease claim: returns the charge config exactly once per
// cooldown window, or null when auto-refill is off, unconfigured, already in
// flight, or attempted too recently.
export async function claimAutoRefill(
  workspaceId: string,
  options: { now?: Date; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const retryBefore = new Date(now.getTime() - AUTO_REFILL_RETRY_COOLDOWN_MS);
  const [claimed] = await db
    .update(workspaceBilling)
    .set({ autoRefillInFlightAt: now, autoRefillLastAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(workspaceBilling.workspaceId, workspaceId),
        eq(workspaceBilling.autoRefillEnabled, true),
        eq(workspaceBilling.plan, "pro"),
        eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
        isNotNull(workspaceBilling.autoRefillPaymentMethodId),
        isNotNull(workspaceBilling.stripeCustomerId),
        or(
          isNull(workspaceBilling.autoRefillInFlightAt),
          lt(workspaceBilling.autoRefillInFlightAt, retryBefore),
        ),
        or(
          isNull(workspaceBilling.autoRefillLastAttemptAt),
          lt(workspaceBilling.autoRefillLastAttemptAt, retryBefore),
        ),
        sql`(
          SELECT COALESCE(SUM(${creditLedger.amountCents}), 0)
          FROM ${creditLedger}
          WHERE ${creditLedger.workspaceId} = ${workspaceId}
            AND ${creditLedger.source} = 'stripe_topup'
            AND ${creditLedger.metadata}->>'kind' = 'auto_refill'
            AND ${creditLedger.createdAt} >= date_trunc('month', ${now.toISOString()}::timestamptz, 'UTC')
        ) + ${workspaceBilling.autoRefillAmountCents} <= ${AUTO_REFILL_MONTHLY_MAX_USD_CENTS}`,
      ),
    )
    .returning({
      amountCents: workspaceBilling.autoRefillAmountCents,
      paymentMethodId: workspaceBilling.autoRefillPaymentMethodId,
      stripeCustomerId: workspaceBilling.stripeCustomerId,
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
export async function settleAutoRefill(
  input: { workspaceId: string; error?: string | null; disable?: boolean },
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  await db
    .update(workspaceBilling)
    .set({
      autoRefillInFlightAt: null,
      autoRefillLastError: input.error ?? null,
      ...(input.disable ? { autoRefillEnabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaceBilling.workspaceId, input.workspaceId));
}

// Workspaces due for an auto-refill charge — the reconcile-cron sweep that
// covers debits recorded outside apps/web (the runner's ingestion debits).
export async function listAutoRefillCandidates(
  options: { now?: Date; limit?: number; db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const retryBefore = new Date(now.getTime() - AUTO_REFILL_RETRY_COOLDOWN_MS);
  const rows = await db
    .select({ workspaceId: workspaceBilling.workspaceId })
    .from(workspaceBilling)
    .innerJoin(creditBalances, eq(creditBalances.workspaceId, workspaceBilling.workspaceId))
    .where(
      and(
        eq(workspaceBilling.autoRefillEnabled, true),
        eq(workspaceBilling.plan, "pro"),
        eq(workspaceBilling.stripeProductKey, PRO_STRIPE_PRODUCT_KEY),
        isNotNull(workspaceBilling.autoRefillPaymentMethodId),
        isNotNull(workspaceBilling.stripeCustomerId),
        lt(creditBalances.balanceUsdMicros, AUTO_REFILL_THRESHOLD_USD_MICROS),
        or(
          isNull(workspaceBilling.autoRefillInFlightAt),
          lt(workspaceBilling.autoRefillInFlightAt, retryBefore),
        ),
        or(
          isNull(workspaceBilling.autoRefillLastAttemptAt),
          lt(workspaceBilling.autoRefillLastAttemptAt, retryBefore),
        ),
        sql`(
          SELECT COALESCE(SUM(${creditLedger.amountCents}), 0)
          FROM ${creditLedger}
          WHERE ${creditLedger.workspaceId} = ${workspaceBilling.workspaceId}
            AND ${creditLedger.source} = 'stripe_topup'
            AND ${creditLedger.metadata}->>'kind' = 'auto_refill'
            AND ${creditLedger.createdAt} >= date_trunc('month', ${now.toISOString()}::timestamptz, 'UTC')
        ) + ${workspaceBilling.autoRefillAmountCents} <= ${AUTO_REFILL_MONTHLY_MAX_USD_CENTS}`,
      ),
    )
    .limit(options.limit ?? 50);
  return rows.map((row: { workspaceId: string }) => row.workspaceId);
}

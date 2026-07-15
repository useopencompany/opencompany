import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { getDb } from "./client";
import {
  type GoatBrainSourceProvider,
  type GoatStripeSubscriptionStatus,
  type GoatWorkspacePlan,
  goatBrainIngestJobs,
  goatStripeWebhookEvents,
  goatWorkspaceBilling,
  goatWorkspaceIngestionReservations,
  goatWorkspaceMembers,
} from "./goat-schema";

type DbLike = any;

export {
  GOAT_FREE_MAX_MEMBERS,
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_INGESTION_OVERAGE_USD_MICROS_PER_RAW_EVENT,
  GOAT_PRO_MAX_MEMBERS,
  GOAT_PRO_MONTHLY_INGESTIONS_PER_SEAT,
  GOAT_PRO_SEAT_MONTHLY_PRICE_USD_CENTS,
  goatIngestionOverageRawEventCount,
  goatIngestionOverageUsdMicros,
  goatMonthlyIngestionLimit,
} from "./goat-billing-constants";

import {
  GOAT_INGESTION_OVERAGE_USD_MICROS_PER_RAW_EVENT,
  goatIngestionOverageRawEventCount,
  goatIngestionOverageUsdMicros,
  goatMonthlyIngestionLimit,
} from "./goat-billing-constants";
import { GOAT_USD_MICROS_PER_CENT, getGoatCreditBalanceUsdMicros } from "./goat-credits";

const PRO_STATUSES = new Set<GoatStripeSubscriptionStatus>(["active", "trialing", "past_due"]);

// The default web-app client (`./client`) is neon-http, which has no interactive
// transactions (one HTTPS request per query) and throws on db.transaction().
// Run the mutation steps sequentially there; pooled callers (the runner) keep a
// real transaction. Mirrors runAtomically() in ./goat-brain-files.
function runAtomically<T>(db: DbLike, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (db instanceof NeonHttpDatabase) return fn(db);
  if (typeof db.transaction !== "function") return fn(db);
  return db.transaction(fn);
}

export type GoatIngestionWindow = {
  plan: GoatWorkspacePlan;
  limit: number;
  seatQuantity: number;
  start: Date;
  resetAt: Date;
};

// The chat 402 gate and the Pro ingestion-overage debit stay dormant until
// this flag is on, so prod cannot hard-stop users before credit top-ups are
// purchasable (GOAT_STRIPE_CHECKOUT_ENABLED). Usage debits always record.
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

export function goatPlanForSubscriptionStatus(
  status: GoatStripeSubscriptionStatus | null,
): GoatWorkspacePlan {
  return status && PRO_STATUSES.has(status) ? "pro" : "free";
}

// Both plans share a single pooled UTC-calendar-month allowance. The window
// start is clamped to plan_started_at so a mid-month plan change starts a
// fresh allowance instead of retroactively re-counting the old plan's usage.
export function goatIngestionWindow(input: {
  plan: GoatWorkspacePlan;
  planStartedAt: Date;
  now: Date;
  seatQuantity?: number;
}): GoatIngestionWindow {
  const { start: calendarStart, resetAt } = goatCalendarMonthWindow(input.now);
  const seatQuantity = Math.max(1, input.seatQuantity ?? 1);
  return {
    plan: input.plan,
    limit: goatMonthlyIngestionLimit(input.plan, seatQuantity),
    seatQuantity,
    start: input.planStartedAt > calendarStart ? input.planStartedAt : calendarStart,
    resetAt,
  };
}

export function goatReservationFitsAllowance(input: {
  consumedUnits: number;
  pendingUnits: number;
  rawEventCount: number;
  limit: number;
}) {
  if (input.pendingUnits > 0) return false;
  // A batch can be larger than the entire allowance (flush batches go up to
  // 200 raw events; the Free base is 150). Admit it while the window is
  // untouched — otherwise it could never run and would wedge the FIFO backlog
  // behind it forever, surviving every monthly reset.
  if (input.consumedUnits === 0) return true;
  return input.consumedUnits + input.rawEventCount <= input.limit;
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

// Pro overage: admit a pending reservation by debiting credits ($0.02 per raw
// event). Ledger insert, balance update, and the pending → consumed flip run
// in ONE statement, so money only ever moves together with the admission —
// a crash can only leave the safe paused state. Locking the balance row makes
// concurrent reservations re-check the latest balance before admission; a
// missing or insufficient balance admits nothing.
async function tryConsumeGoatIngestionOverage(
  input: {
    reservationId: string;
    workspaceId: string;
    rawEventCount: number;
    overageRawEventCount: number;
    now: Date;
  },
  db: DbLike,
) {
  const costUsdMicros = goatIngestionOverageUsdMicros(input.overageRawEventCount);
  if (costUsdMicros <= 0) return false;
  const costCents = Math.round(costUsdMicros / GOAT_USD_MICROS_PER_CENT);
  const costBasis = {
    kind: "ingest_overage",
    reservationRawEventCount: input.rawEventCount,
    overageRawEventCount: input.overageRawEventCount,
    usdMicrosPerRawEvent: GOAT_INGESTION_OVERAGE_USD_MICROS_PER_RAW_EVENT,
  };
  const result = await db.execute(sql`
    WITH locked_balance AS MATERIALIZED (
      SELECT workspace_id
      FROM goat.credit_balances
      WHERE workspace_id = ${input.workspaceId}
        AND balance_usd_micros >= ${costUsdMicros}
      FOR UPDATE
    ),
    flipped AS (
      UPDATE goat.workspace_ingestion_reservations AS reservation
      SET status = 'consumed',
          consumed_at = ${input.now.toISOString()},
          billed_overage_raw_event_count = ${input.overageRawEventCount},
          billed_overage_usd_micros = ${costUsdMicros},
          updated_at = ${input.now.toISOString()}
      FROM locked_balance
      WHERE reservation.id = ${input.reservationId}
        AND reservation.workspace_id = ${input.workspaceId}
        AND reservation.workspace_id = locked_balance.workspace_id
        AND reservation.status = 'pending'
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
        ${-costCents},
        ${-costUsdMicros},
        'ingest_overage',
        ${`overage:${input.reservationId}`},
        id,
        0,
        0,
        ${JSON.stringify(costBasis)}::jsonb
      FROM flipped
      RETURNING workspace_id, amount_usd_micros
    ),
    balance AS (
      UPDATE goat.credit_balances
      SET balance_usd_micros = goat.credit_balances.balance_usd_micros + debit.amount_usd_micros,
          balance_cents = ROUND((goat.credit_balances.balance_usd_micros + debit.amount_usd_micros)::numeric / ${GOAT_USD_MICROS_PER_CENT})::integer,
          updated_at = ${input.now.toISOString()}
      FROM debit
      WHERE goat.credit_balances.workspace_id = debit.workspace_id
      RETURNING goat.credit_balances.workspace_id
    )
    SELECT flipped.id AS "reservationId"
    FROM flipped
    JOIN balance ON balance.workspace_id = flipped.workspace_id
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
    const billing = await ensureBillingRow(input.workspaceId, tx);
    const window = goatIngestionWindow({
      plan: billing.plan,
      planStartedAt: billing.planStartedAt,
      now,
      seatQuantity: billing.seatQuantity,
    });
    const [usage] = await tx
      .select({
        total: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.rawEventCount}), 0)::integer`,
      })
      .from(goatWorkspaceIngestionReservations)
      .where(
        and(
          eq(goatWorkspaceIngestionReservations.workspaceId, input.workspaceId),
          eq(goatWorkspaceIngestionReservations.status, "consumed"),
          gte(goatWorkspaceIngestionReservations.consumedAt, window.start),
        ),
      );
    const consumed = Number(usage?.total ?? 0);
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
    // Once a workspace has a backlog, newer work must remain behind it even if
    // the newer batch happens to fit in the remaining allowance.
    const canConsume = goatReservationFitsAllowance({
      consumedUnits: consumed,
      pendingUnits: pendingBefore,
      rawEventCount: input.rawEventCount,
      limit: window.limit,
    });
    const [inserted] = await tx
      .insert(goatWorkspaceIngestionReservations)
      .values({
        id: `gir_${randomUUID().replace(/-/g, "")}`,
        workspaceId: input.workspaceId,
        sourceItemId: input.sourceItemId,
        sourceProvider: input.sourceProvider,
        rawEventCount: input.rawEventCount,
        status: canConsume ? "consumed" : "pending",
        consumedAt: canConsume ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      let admitted = canConsume;
      // Pro overage: an over-allowance reservation can still be admitted by
      // debiting credits — but never ahead of an existing backlog (FIFO); the
      // paused backlog is drained by releasePendingForWorkspace instead.
      if (
        !admitted &&
        billing.plan === "pro" &&
        pendingBefore === 0 &&
        isGoatCreditsEnforcementEnabled()
      ) {
        const overageRawEventCount = goatIngestionOverageRawEventCount({
          consumedUnits: consumed,
          rawEventCount: input.rawEventCount,
          limit: window.limit,
        });
        admitted = await tryConsumeGoatIngestionOverage(
          {
            reservationId: inserted.id,
            workspaceId: input.workspaceId,
            rawEventCount: input.rawEventCount,
            overageRawEventCount,
            now,
          },
          tx,
        );
      }
      return {
        reservation: inserted,
        window,
        consumedBefore: consumed,
        usedAfter: consumed + (admitted ? input.rawEventCount : 0),
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
      window,
      consumedBefore: consumed,
      usedAfter: consumed,
      pendingUnits: pendingBefore,
      paused: existing.status === "pending",
      created: false as const,
    };
  };
  return input.db ? run(db) : runAtomically(db, run);
}

async function releasePendingForWorkspace(workspaceId: string, now: Date, db: DbLike) {
  return runAtomically(db, async (tx: DbLike) => {
    await lockWorkspace(workspaceId, tx);
    const billing = await ensureBillingRow(workspaceId, tx);
    const window = goatIngestionWindow({
      plan: billing.plan,
      planStartedAt: billing.planStartedAt,
      now,
      seatQuantity: billing.seatQuantity,
    });
    const [usage] = await tx
      .select({
        total: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.rawEventCount}), 0)::integer`,
      })
      .from(goatWorkspaceIngestionReservations)
      .where(
        and(
          eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
          eq(goatWorkspaceIngestionReservations.status, "consumed"),
          gte(goatWorkspaceIngestionReservations.consumedAt, window.start),
        ),
      );
    let consumed = Number(usage?.total ?? 0);
    let available = window.limit - consumed;
    const canOverage = billing.plan === "pro" && isGoatCreditsEnforcementEnabled();
    if (available <= 0 && !canOverage) return 0;
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
    const releasable: typeof pending = [];
    let index = 0;
    for (; index < pending.length; index += 1) {
      const reservation = pending[index];
      if (available <= 0) break;
      // Same progress guarantee as goatReservationFitsAllowance: a batch
      // larger than the whole allowance is admitted while the window is
      // untouched, so it cannot wedge the FIFO backlog behind it forever.
      if (consumed > 0 && reservation.rawEventCount > available) break;
      releasable.push(reservation);
      consumed += reservation.rawEventCount;
      available -= reservation.rawEventCount;
    }
    // Pro overage: drain whatever the allowance could not cover, still in FIFO
    // order, debiting credits per reservation. Stop at the first reservation
    // the balance cannot cover — releasing anything behind it would jump the
    // queue.
    const overageReleased: typeof pending = [];
    if (canOverage) {
      for (; index < pending.length; index += 1) {
        const reservation = pending[index];
        const overageRawEventCount = goatIngestionOverageRawEventCount({
          consumedUnits: consumed,
          rawEventCount: reservation.rawEventCount,
          limit: window.limit,
        });
        const admitted = await tryConsumeGoatIngestionOverage(
          {
            reservationId: reservation.id,
            workspaceId,
            rawEventCount: reservation.rawEventCount,
            overageRawEventCount,
            now,
          },
          tx,
        );
        if (!admitted) break;
        overageReleased.push(reservation);
        consumed += reservation.rawEventCount;
      }
    }
    const released = [...releasable, ...overageReleased];
    if (released.length === 0) return 0;
    if (releasable.length > 0) {
      await tx
        .update(goatWorkspaceIngestionReservations)
        .set({ status: "consumed", consumedAt: now, updatedAt: now })
        .where(
          and(
            inArray(
              goatWorkspaceIngestionReservations.id,
              releasable.map((reservation: { id: string }) => reservation.id),
            ),
            eq(goatWorkspaceIngestionReservations.status, "pending"),
          ),
        );
    }
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
  const window = goatIngestionWindow({
    plan: billing.plan,
    planStartedAt: billing.planStartedAt,
    now,
    seatQuantity: billing.seatQuantity,
  });
  const [usage, pending, overage, providerRows, recentRows, memberCountRows, creditBalance] =
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
            gte(goatWorkspaceIngestionReservations.consumedAt, window.start),
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
          units: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.billedOverageRawEventCount}), 0)::integer`,
          usdMicros: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.billedOverageUsdMicros}), 0)::bigint`,
        })
        .from(goatWorkspaceIngestionReservations)
        .where(
          and(
            eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
            eq(goatWorkspaceIngestionReservations.status, "consumed"),
            gte(goatWorkspaceIngestionReservations.consumedAt, window.start),
            sql`${goatWorkspaceIngestionReservations.billedOverageUsdMicros} > 0`,
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
            gte(goatWorkspaceIngestionReservations.consumedAt, window.start),
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
    plan: billing.plan,
    window,
    used: Number(usage[0]?.total ?? 0),
    pending: Number(pending[0]?.total ?? 0),
    seatQuantity: billing.seatQuantity,
    memberCount: Number(memberCountRows[0]?.total ?? 0),
    creditBalanceUsdMicros: creditBalance,
    overageUnitsThisWindow: Number(overage[0]?.units ?? 0),
    overageUsdMicrosThisWindow: Number(overage[0]?.usdMicros ?? 0),
    providers: providerRows.map((row: { provider: GoatBrainSourceProvider; total: number }) => ({
      provider: row.provider,
      count: Number(row.total),
    })),
    recent: recentRows,
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

export type GoatStripeSubscriptionProjection = {
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  workspaceId: string;
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string | null;
  priceId: string | null;
  // Stripe subscription item quantity = paid seats. Null when the event does
  // not carry an item (projection keeps 1).
  seatQuantity: number | null;
  status: GoatStripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
};

export async function applyGoatStripeSubscriptionProjection(
  input: GoatStripeSubscriptionProjection,
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  return runAtomically(db, async (tx: DbLike) => {
    const [recorded] = await tx
      .insert(goatStripeWebhookEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
        eventCreatedAt: input.eventCreatedAt,
      })
      .onConflictDoNothing()
      .returning({ eventId: goatStripeWebhookEvents.eventId });
    if (!recorded) return { applied: false as const, reason: "duplicate" as const };
    await lockWorkspace(input.workspaceId, tx);
    const current = await ensureBillingRow(input.workspaceId, tx);
    if (current.lastStripeEventCreated && current.lastStripeEventCreated > input.eventCreatedAt) {
      return { applied: false as const, reason: "stale" as const };
    }
    const plan = goatPlanForSubscriptionStatus(input.status);
    const planChanged = plan !== current.plan;
    const cancellationScheduled = !current.cancelAtPeriodEnd && input.cancelAtPeriodEnd;
    await tx
      .update(goatWorkspaceBilling)
      .set({
        plan,
        ...(planChanged ? { planStartedAt: input.eventCreatedAt } : {}),
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        stripeSubscriptionItemId: input.subscriptionItemId,
        stripePriceId: input.priceId,
        seatQuantity: Math.max(1, input.seatQuantity ?? 1),
        subscriptionStatus: input.status,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        currentPeriodEnd: input.currentPeriodEnd,
        paymentNeedsAttention: input.status === "past_due" || input.status === "unpaid",
        lastStripeEventCreated: input.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(goatWorkspaceBilling.workspaceId, input.workspaceId));
    return { applied: true as const, planChanged, plan, cancellationScheduled };
  });
}

export async function findGoatWorkspaceIdForStripeSubscription(
  subscriptionId: string,
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  const [row] = await db
    .select({ workspaceId: goatWorkspaceBilling.workspaceId })
    .from(goatWorkspaceBilling)
    .where(eq(goatWorkspaceBilling.stripeSubscriptionId, subscriptionId))
    .limit(1);
  return row?.workspaceId ?? null;
}

// Pro workspaces whose projected seat quantity or Stripe price has drifted
// from the live billing terms. The hourly reconcile cron pushes both back to
// Stripe; the resulting subscription webhook re-projects the billing state.
export async function listGoatSeatSyncCandidates(options: {
  targetPriceId: string;
  limit?: number;
  db?: DbLike;
}) {
  const db = options.db ?? getDb();
  const memberCount = sql<number>`(
    SELECT count(*)::integer FROM goat.workspace_members m
    WHERE m.workspace_id = ${goatWorkspaceBilling.workspaceId}
  )`;
  const rows = await db
    .select({
      workspaceId: goatWorkspaceBilling.workspaceId,
      stripeSubscriptionItemId: goatWorkspaceBilling.stripeSubscriptionItemId,
      stripePriceId: goatWorkspaceBilling.stripePriceId,
      seatQuantity: goatWorkspaceBilling.seatQuantity,
      memberCount,
    })
    .from(goatWorkspaceBilling)
    .where(
      and(
        eq(goatWorkspaceBilling.plan, "pro"),
        sql`${goatWorkspaceBilling.stripeSubscriptionItemId} IS NOT NULL`,
        sql`(${goatWorkspaceBilling.seatQuantity} <> ${memberCount} OR ${goatWorkspaceBilling.stripePriceId} IS DISTINCT FROM ${options.targetPriceId})`,
      ),
    )
    .limit(options.limit ?? 50);
  return rows.map(
    (row: {
      workspaceId: string;
      stripeSubscriptionItemId: string | null;
      stripePriceId: string | null;
      seatQuantity: number;
      memberCount: number;
    }) => ({
      workspaceId: row.workspaceId,
      stripeSubscriptionItemId: row.stripeSubscriptionItemId as string,
      stripePriceId: row.stripePriceId,
      seatQuantity: Number(row.seatQuantity),
      memberCount: Math.max(1, Number(row.memberCount)),
    }),
  );
}

export async function applyGoatStripeInvoicePaymentState(
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
      .insert(goatStripeWebhookEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
        eventCreatedAt: input.eventCreatedAt,
      })
      .onConflictDoNothing()
      .returning({ eventId: goatStripeWebhookEvents.eventId });
    if (!recorded) return false;
    const [billing] = await tx
      .select({
        workspaceId: goatWorkspaceBilling.workspaceId,
        lastStripeEventCreated: goatWorkspaceBilling.lastStripeEventCreated,
      })
      .from(goatWorkspaceBilling)
      .where(eq(goatWorkspaceBilling.stripeSubscriptionId, input.subscriptionId))
      .limit(1);
    if (!billing) return false;
    await lockWorkspace(billing.workspaceId, tx);
    const [current] = await tx
      .select({ lastStripeEventCreated: goatWorkspaceBilling.lastStripeEventCreated })
      .from(goatWorkspaceBilling)
      .where(eq(goatWorkspaceBilling.workspaceId, billing.workspaceId))
      .limit(1);
    if (current?.lastStripeEventCreated && current.lastStripeEventCreated > input.eventCreatedAt) {
      return false;
    }
    await tx
      .update(goatWorkspaceBilling)
      .set({
        paymentNeedsAttention: input.needsAttention,
        lastStripeEventCreated: input.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(goatWorkspaceBilling.stripeSubscriptionId, input.subscriptionId));
    return true;
  });
}

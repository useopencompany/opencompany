import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { getDb } from "./client";
import {
  type GoatBrainSourceProvider,
  type GoatStripeSubscriptionStatus,
  type GoatWorkspacePlan,
  goatBrainIngestJobs,
  goatBrainSources,
  goatBrains,
  goatIntegrations,
  goatStripeWebhookEvents,
  goatWorkspaceBilling,
  goatWorkspaceIngestionReservations,
} from "./goat-schema";

type DbLike = any;

export {
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
  GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS,
  GOAT_SOURCE_BONUS_MONTHLY_ITEMS,
  goatSourceBonusItems,
} from "./goat-billing-constants";

import {
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_INGESTION_LIMIT,
  goatSourceBonusItems,
} from "./goat-billing-constants";

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
  baseLimit: number;
  sourceBonus: number;
  start: Date;
  resetAt: Date;
};

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
  connectedSourceCount?: number;
}): GoatIngestionWindow {
  const { start: calendarStart, resetAt } = goatCalendarMonthWindow(input.now);
  const baseLimit =
    input.plan === "pro" ? GOAT_PRO_MONTHLY_INGESTION_LIMIT : GOAT_FREE_MONTHLY_INGESTION_LIMIT;
  const sourceBonus = goatSourceBonusItems(input.connectedSourceCount ?? 0);
  return {
    plan: input.plan,
    limit: baseLimit + sourceBonus,
    baseLimit,
    sourceBonus,
    start: input.planStartedAt > calendarStart ? input.planStartedAt : calendarStart,
    resetAt,
  };
}

// A "connected source" is a distinct provider that feeds any of the
// workspace's brains through an integration that has not been disconnected.
// The bonus is recomputed from live rows on every allowance check, so
// disconnecting an integration (or disabling its brain sources) drops the
// bonus with it — connect → bonus → disconnect cannot bank allowance.
// Transient failures (needs_reauth, sync_failed) keep the bonus; only a
// deliberate disconnect or removal loses it.
export async function countGoatConnectedWorkspaceSources(workspaceId: string, db?: DbLike) {
  const [row] = await (db ?? getDb())
    .select({
      count: sql<number>`count(distinct ${goatBrainSources.provider})::integer`,
    })
    .from(goatBrainSources)
    .innerJoin(goatBrains, eq(goatBrainSources.brainId, goatBrains.id))
    .innerJoin(goatIntegrations, eq(goatBrainSources.integrationId, goatIntegrations.id))
    .where(
      and(
        eq(goatBrains.workspaceId, workspaceId),
        eq(goatBrainSources.enabled, true),
        ne(goatIntegrations.status, "disconnected"),
      ),
    );
  return Number(row?.count ?? 0);
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
    // The bonus is eventually consistent by design, so count sources before
    // taking the workspace row lock instead of lengthening the lock window.
    const connectedSourceCount = await countGoatConnectedWorkspaceSources(input.workspaceId, tx);
    await lockWorkspace(input.workspaceId, tx);
    const billing = await ensureBillingRow(input.workspaceId, tx);
    const window = goatIngestionWindow({
      plan: billing.plan,
      planStartedAt: billing.planStartedAt,
      now,
      connectedSourceCount,
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
      return {
        reservation: inserted,
        window,
        consumedBefore: consumed,
        usedAfter: consumed + (canConsume ? input.rawEventCount : 0),
        pendingUnits: pendingBefore + (canConsume ? 0 : input.rawEventCount),
        paused: !canConsume,
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
    const connectedSourceCount = await countGoatConnectedWorkspaceSources(workspaceId, tx);
    await lockWorkspace(workspaceId, tx);
    const billing = await ensureBillingRow(workspaceId, tx);
    const window = goatIngestionWindow({
      plan: billing.plan,
      planStartedAt: billing.planStartedAt,
      now,
      connectedSourceCount,
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
    if (available <= 0) return 0;
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
    for (const reservation of pending) {
      // Same progress guarantee as goatReservationFitsAllowance: a batch
      // larger than the whole allowance is admitted while the window is
      // untouched, so it cannot wedge the FIFO backlog behind it forever.
      if (consumed > 0 && reservation.rawEventCount > available) break;
      releasable.push(reservation);
      consumed += reservation.rawEventCount;
      available -= reservation.rawEventCount;
    }
    if (releasable.length === 0) return 0;
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
    await tx
      .update(goatBrainIngestJobs)
      .set({ planPaused: false, updatedAt: now })
      .where(
        and(
          eq(goatBrainIngestJobs.workspaceId, workspaceId),
          inArray(
            goatBrainIngestJobs.sourceItemId,
            releasable.map((reservation: { sourceItemId: string }) => reservation.sourceItemId),
          ),
          eq(goatBrainIngestJobs.planPaused, true),
        ),
      );
    return releasable.length;
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
  // The window start only depends on the plan row; the connected-source count
  // only affects the limit, so it can run inside the parallel batch below and
  // the final window (with the bonus folded in) is computed afterwards.
  const { start: windowStart } = goatIngestionWindow({
    plan: billing.plan,
    planStartedAt: billing.planStartedAt,
    now,
  });
  const [connectedSourceCount, usage, pending, providerRows, recentRows] = await Promise.all([
    countGoatConnectedWorkspaceSources(workspaceId, db),
    db
      .select({
        total: sql<number>`coalesce(sum(${goatWorkspaceIngestionReservations.rawEventCount}), 0)::integer`,
      })
      .from(goatWorkspaceIngestionReservations)
      .where(
        and(
          eq(goatWorkspaceIngestionReservations.workspaceId, workspaceId),
          eq(goatWorkspaceIngestionReservations.status, "consumed"),
          gte(goatWorkspaceIngestionReservations.consumedAt, windowStart),
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
          gte(goatWorkspaceIngestionReservations.consumedAt, windowStart),
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
  ]);
  const window = goatIngestionWindow({
    plan: billing.plan,
    planStartedAt: billing.planStartedAt,
    now,
    connectedSourceCount,
  });
  return {
    billing,
    plan: billing.plan,
    window,
    used: Number(usage[0]?.total ?? 0),
    pending: Number(pending[0]?.total ?? 0),
    connectedSourceCount,
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

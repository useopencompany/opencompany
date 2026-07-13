import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
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

export const GOAT_FREE_MONTHLY_INGESTION_LIMIT = 200;
export const GOAT_PRO_DAILY_INGESTION_LIMIT = 200;
export const GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS = 1_500;

const PRO_STATUSES = new Set<GoatStripeSubscriptionStatus>(["active", "trialing", "past_due"]);

export type GoatIngestionWindow = {
  plan: GoatWorkspacePlan;
  limit: number;
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

export function goatIngestionWindow(input: {
  plan: GoatWorkspacePlan;
  planStartedAt: Date;
  now: Date;
}): GoatIngestionWindow {
  const calendarStart = new Date(input.now);
  const resetAt = new Date(input.now);
  if (input.plan === "pro") {
    calendarStart.setUTCHours(0, 0, 0, 0);
    resetAt.setUTCHours(0, 0, 0, 0);
    resetAt.setUTCDate(resetAt.getUTCDate() + 1);
  } else {
    calendarStart.setUTCDate(1);
    calendarStart.setUTCHours(0, 0, 0, 0);
    resetAt.setUTCDate(1);
    resetAt.setUTCHours(0, 0, 0, 0);
    resetAt.setUTCMonth(resetAt.getUTCMonth() + 1);
  }
  return {
    plan: input.plan,
    limit:
      input.plan === "pro" ? GOAT_PRO_DAILY_INGESTION_LIMIT : GOAT_FREE_MONTHLY_INGESTION_LIMIT,
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
  return input.pendingUnits === 0 && input.consumedUnits + input.rawEventCount <= input.limit;
}

async function ensureBillingRow(workspaceId: string, db: DbLike) {
  const [seatCount] = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(goatWorkspaceMembers)
    .where(eq(goatWorkspaceMembers.workspaceId, workspaceId));
  const desiredSeatQuantity = Math.max(1, Number(seatCount?.count ?? 1));
  await db
    .insert(goatWorkspaceBilling)
    .values({ workspaceId, desiredSeatQuantity })
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
    await lockWorkspace(input.workspaceId, tx);
    const billing = await ensureBillingRow(input.workspaceId, tx);
    const window = goatIngestionWindow({
      plan: billing.plan,
      planStartedAt: billing.planStartedAt,
      now,
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
  return input.db ? run(db) : db.transaction(run);
}

async function releasePendingForWorkspace(workspaceId: string, now: Date, db: DbLike) {
  return db.transaction(async (tx: DbLike) => {
    await lockWorkspace(workspaceId, tx);
    const billing = await ensureBillingRow(workspaceId, tx);
    const window = goatIngestionWindow({
      plan: billing.plan,
      planStartedAt: billing.planStartedAt,
      now,
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
    let available = window.limit - Number(usage?.total ?? 0);
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
    let released = 0;
    for (const reservation of pending) {
      if (reservation.rawEventCount > available) break;
      await tx
        .update(goatWorkspaceIngestionReservations)
        .set({ status: "consumed", consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(goatWorkspaceIngestionReservations.id, reservation.id),
            eq(goatWorkspaceIngestionReservations.status, "pending"),
          ),
        );
      await tx
        .update(goatBrainIngestJobs)
        .set({ planPaused: false, updatedAt: now })
        .where(
          and(
            eq(goatBrainIngestJobs.workspaceId, workspaceId),
            eq(goatBrainIngestJobs.sourceItemId, reservation.sourceItemId),
            eq(goatBrainIngestJobs.planPaused, true),
          ),
        );
      available -= reservation.rawEventCount;
      released += 1;
    }
    return released;
  });
}

export async function releasePendingGoatIngestionReservations(
  input: { now?: Date; maxWorkspaces?: number; db?: DbLike } = {},
) {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const rows = await db
    .selectDistinct({ workspaceId: goatWorkspaceIngestionReservations.workspaceId })
    .from(goatWorkspaceIngestionReservations)
    .where(eq(goatWorkspaceIngestionReservations.status, "pending"))
    .limit(input.maxWorkspaces ?? 50);
  let released = 0;
  for (const row of rows) released += await releasePendingForWorkspace(row.workspaceId, now, db);
  return released;
}

export async function loadGoatBillingOverview(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const now = new Date();
  const billing = await ensureBillingRow(workspaceId, db);
  const monthWindow = goatCalendarMonthWindow(now);
  const window = goatIngestionWindow({
    plan: billing.plan,
    planStartedAt: billing.planStartedAt,
    now,
  });
  const [usage, monthlyUsage, pending, seats, providerRows, recentRows] = await Promise.all([
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
          eq(goatWorkspaceIngestionReservations.status, "consumed"),
          gte(goatWorkspaceIngestionReservations.consumedAt, monthWindow.start),
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
      .select({ total: sql<number>`count(*)::integer` })
      .from(goatWorkspaceMembers)
      .where(eq(goatWorkspaceMembers.workspaceId, workspaceId)),
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
  ]);
  const seatCount = Math.max(1, Number(seats[0]?.total ?? 1));
  return {
    billing,
    plan: billing.plan,
    window,
    monthWindow,
    used: Number(usage[0]?.total ?? 0),
    monthlyUsed: Number(monthlyUsage[0]?.total ?? 0),
    pending: Number(pending[0]?.total ?? 0),
    seatCount,
    monthlySubtotalEurCents: seatCount * GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
    providers: providerRows.map((row: { provider: GoatBrainSourceProvider; total: number }) => ({
      provider: row.provider,
      count: Number(row.total),
    })),
    recent: recentRows,
  };
}

export async function markGoatSeatSyncPending(workspaceId: string, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  const [seats] = await db
    .select({ total: sql<number>`count(*)::integer` })
    .from(goatWorkspaceMembers)
    .where(eq(goatWorkspaceMembers.workspaceId, workspaceId));
  const desiredSeatQuantity = Math.max(1, Number(seats?.total ?? 1));
  await db
    .insert(goatWorkspaceBilling)
    .values({ workspaceId, desiredSeatQuantity, seatSyncPendingAt: new Date() })
    .onConflictDoUpdate({
      target: goatWorkspaceBilling.workspaceId,
      set: { desiredSeatQuantity, seatSyncPendingAt: new Date(), updatedAt: new Date() },
    });
  return desiredSeatQuantity;
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
  seatQuantity: number;
};

export async function applyGoatStripeSubscriptionProjection(
  input: GoatStripeSubscriptionProjection,
  options: { db?: DbLike } = {},
) {
  const db = options.db ?? getDb();
  return db.transaction(async (tx: DbLike) => {
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
        stripeSeatQuantity: input.seatQuantity,
        seatSyncPendingAt: input.seatQuantity === current.desiredSeatQuantity ? null : new Date(),
        paymentNeedsAttention: input.status === "past_due" || input.status === "unpaid",
        lastStripeEventCreated: input.eventCreatedAt,
        updatedAt: new Date(),
      })
      .where(eq(goatWorkspaceBilling.workspaceId, input.workspaceId));
    return { applied: true as const, planChanged, plan, cancellationScheduled };
  });
}

export async function listGoatBillingSeatSyncCandidates(limit = 50, options: { db?: DbLike } = {}) {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(goatWorkspaceBilling)
    .where(
      and(
        eq(goatWorkspaceBilling.plan, "pro"),
        isNotNull(goatWorkspaceBilling.stripeSubscriptionItemId),
        isNotNull(goatWorkspaceBilling.seatSyncPendingAt),
      ),
    )
    .orderBy(asc(goatWorkspaceBilling.seatSyncPendingAt))
    .limit(limit);
}

export async function completeGoatSeatSync(input: {
  workspaceId: string;
  quantity: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await db
    .update(goatWorkspaceBilling)
    .set({ stripeSeatQuantity: input.quantity, seatSyncPendingAt: null, updatedAt: new Date() })
    .where(eq(goatWorkspaceBilling.workspaceId, input.workspaceId));
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
  return db.transaction(async (tx: DbLike) => {
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

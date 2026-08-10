// Legacy-product credit fulfillment used only by the shared Stripe webhook.
// The Goat and legacy web products bill through the same Stripe account, so the
// webhook that now lives in this app still receives legacy checkout and
// auto-refill events. Ported verbatim from apps/web/lib/billing/service.ts;
// these write to the legacy (public-schema) billing tables, not goat.*.

import { USD_MICROS_PER_CENT } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import {
  autoRefillAttempts,
  type WorkspaceBillingSettings,
  workspaceBillingSettings,
} from "@opencompany/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";

type ExecuteResultRow = Record<string, unknown>;

function rowsFromExecute<T extends ExecuteResultRow>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function readMicros(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function fulfillCheckoutSession(
  session: Stripe.Checkout.Session,
  options: { eventId?: string } = {},
) {
  if (session.payment_status !== "paid") {
    return { ok: false as const, reason: "not_paid" };
  }

  const checkoutRecordId = session.metadata?.checkoutRecordId;
  const workspaceId = session.metadata?.workspaceId;
  const userId = session.metadata?.userId;
  const amountCents = Number(session.metadata?.amountCents);

  if (!checkoutRecordId || !workspaceId || !userId || !Number.isSafeInteger(amountCents)) {
    return { ok: false as const, reason: "missing_metadata" };
  }

  const db = getDb();
  const result = await db.execute(sql`
    WITH fulfilled_session AS (
      UPDATE stripe_checkout_sessions
      SET status = 'fulfilled',
          fulfilled_at = now(),
          updated_at = now()
      WHERE id = ${checkoutRecordId}
        AND stripe_checkout_session_id = ${session.id}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND amount_cents = ${amountCents}
        AND fulfilled_at IS NULL
      RETURNING id, workspace_id, user_id, amount_cents, stripe_checkout_session_id
    ),
    balance AS (
      INSERT INTO workspace_credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT workspace_id, amount_cents, amount_cents::bigint * ${USD_MICROS_PER_CENT}, now()
      FROM fulfilled_session
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = workspace_credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = workspace_credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          updated_at = now()
      RETURNING workspace_id, balance_cents
    ),
    ledger AS (
      INSERT INTO workspace_credit_ledger (
        workspace_id,
        user_id,
        amount_cents,
        amount_usd_micros,
        source,
        stripe_checkout_session_id,
        metadata
      )
      SELECT
        workspace_id,
        user_id,
        amount_cents,
        amount_cents::bigint * ${USD_MICROS_PER_CENT},
        'stripe_checkout',
        id,
        jsonb_build_object(
          'stripeCheckoutSessionId', stripe_checkout_session_id,
          'stripeEventId', ${options.eventId ?? null}::text
        )
      FROM fulfilled_session
      RETURNING id
    )
    SELECT
      fulfilled_session.id AS "checkoutRecordId",
      fulfilled_session.workspace_id AS "workspaceId",
      fulfilled_session.user_id AS "userId",
      fulfilled_session.amount_cents AS "amountCents",
      balance.balance_cents AS "balanceCents",
      ledger.id AS "ledgerId"
    FROM fulfilled_session
    JOIN balance ON balance.workspace_id = fulfilled_session.workspace_id
    JOIN ledger ON true
  `);

  const rows = rowsFromExecute<{
    checkoutRecordId: string;
    workspaceId: string;
    userId: string;
    amountCents: number;
    balanceCents: number;
    ledgerId: number;
  }>(result);

  if (!rows[0]) {
    return { ok: false as const, reason: "already_fulfilled_or_mismatch" };
  }

  return { ok: true as const, ...rows[0] };
}

type BillingSettingsPatch = Partial<
  Pick<
    WorkspaceBillingSettings,
    | "autoRefillEnabled"
    | "stripeCustomerId"
    | "stripeDefaultPaymentMethodId"
    | "cardBrand"
    | "cardLast4"
    | "autoRefillStatus"
  >
>;

async function upsertWorkspaceBillingSettings(
  workspaceId: string,
  patch: BillingSettingsPatch,
  db = getDb(),
) {
  const now = new Date();
  await db
    .insert(workspaceBillingSettings)
    .values({ workspaceId, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceBillingSettings.workspaceId,
      set: { ...patch, updatedAt: now },
    });
}

export async function markAutoRefillAttemptFailed(input: {
  attemptId: string;
  workspaceId: string;
  stripePaymentIntentId?: string | null;
  error: string;
  needsAttention?: boolean;
  db?: ReturnType<typeof getDb>;
}) {
  const db = input.db ?? getDb();
  const now = new Date();
  // Don't clobber an already-fulfilled attempt (webhook/inline races).
  await db
    .update(autoRefillAttempts)
    .set({
      status: "failed",
      error: input.error.slice(0, 1000),
      stripePaymentIntentId: input.stripePaymentIntentId ?? undefined,
      updatedAt: now,
    })
    .where(
      and(
        eq(autoRefillAttempts.id, input.attemptId),
        sql`${autoRefillAttempts.status} <> 'succeeded'`,
      ),
    );
  if (input.needsAttention) {
    await upsertWorkspaceBillingSettings(
      input.workspaceId,
      { autoRefillStatus: "needs_attention" },
      db,
    );
  }
}

// Credits the workspace for a succeeded auto-refill. Idempotent: the attempt row
// transitions pending -> succeeded exactly once, so calling this from both the
// inline charge path and the webhook can never double-credit.
export async function fulfillAutoRefill(input: {
  attemptId: string;
  stripePaymentIntentId: string;
  eventId?: string | null;
  db?: ReturnType<typeof getDb>;
}) {
  const db = input.db ?? getDb();
  const result = await db.execute(sql`
    WITH fulfilled AS (
      UPDATE auto_refill_attempts
      SET status = 'succeeded',
          stripe_payment_intent_id = ${input.stripePaymentIntentId},
          error = NULL,
          fulfilled_at = now(),
          updated_at = now()
      WHERE id = ${input.attemptId} AND status <> 'succeeded'
      RETURNING id, workspace_id, user_id, amount_usd_micros
    ),
    balance AS (
      INSERT INTO workspace_credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT
        workspace_id,
        ROUND(amount_usd_micros::numeric / ${USD_MICROS_PER_CENT})::integer,
        amount_usd_micros,
        now()
      FROM fulfilled
      ON CONFLICT (workspace_id) DO UPDATE SET
        balance_cents = workspace_credit_balances.balance_cents + excluded.balance_cents,
        balance_usd_micros = workspace_credit_balances.balance_usd_micros + excluded.balance_usd_micros,
        updated_at = now()
      RETURNING workspace_id, balance_cents
    ),
    ledger AS (
      INSERT INTO workspace_credit_ledger (workspace_id, user_id, amount_cents, amount_usd_micros, source, metadata)
      SELECT
        workspace_id,
        user_id,
        ROUND(amount_usd_micros::numeric / ${USD_MICROS_PER_CENT})::integer,
        amount_usd_micros,
        'auto_refill',
        jsonb_build_object(
          'autoRefillAttemptId', id,
          'stripePaymentIntentId', ${input.stripePaymentIntentId}::text,
          'stripeEventId', ${input.eventId ?? null}::text
        )
      FROM fulfilled
      RETURNING id
    )
    SELECT
      fulfilled.workspace_id AS "workspaceId",
      fulfilled.user_id AS "userId",
      fulfilled.amount_usd_micros AS "amountUsdMicros",
      balance.balance_cents AS "balanceCents",
      ledger.id AS "ledgerId"
    FROM fulfilled
    JOIN balance ON balance.workspace_id = fulfilled.workspace_id
    JOIN ledger ON true
  `);

  const rows = rowsFromExecute<{
    workspaceId: string;
    userId: string | null;
    amountUsdMicros: number | string;
    balanceCents: number;
    ledgerId: number;
  }>(result);

  const row = rows[0];
  if (!row) {
    // Already fulfilled (or the attempt vanished) — idempotent no-op.
    return { ok: false as const, alreadyFulfilled: true as const };
  }

  return {
    ok: true as const,
    alreadyFulfilled: false as const,
    workspaceId: row.workspaceId,
    userId: row.userId,
    amountUsdMicros: readMicros(row.amountUsdMicros),
    balanceCents: row.balanceCents,
    ledgerId: row.ledgerId,
  };
}

// Persists the saved card after a setup-mode checkout. Marks auto-refill ready (ok)
// and enabled in the same write, so finishing setup turns the feature on.
export async function saveAutoRefillPaymentMethod(input: {
  workspaceId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  db?: ReturnType<typeof getDb>;
}) {
  await upsertWorkspaceBillingSettings(
    input.workspaceId,
    {
      stripeCustomerId: input.stripeCustomerId,
      stripeDefaultPaymentMethodId: input.paymentMethodId,
      cardBrand: input.cardBrand,
      cardLast4: input.cardLast4,
      autoRefillEnabled: true,
      autoRefillStatus: "ok",
    },
    input.db,
  );
}

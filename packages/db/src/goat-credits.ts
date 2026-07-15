import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import type { GoatCreditLedgerSource } from "./goat-schema";
import { goatCreditLedger, goatStripeCheckoutSessions } from "./goat-schema";

type DbLike = any;

// Mirrors USD_MICROS_PER_CENT in @opencompany/billing; duplicated because the
// dependency points the other way (billing has no drizzle schema, db has no
// billing dependency).
export const GOAT_USD_MICROS_PER_CENT = 10_000;

export function goatUsdMicrosToCents(micros: number) {
  return Math.round(micros / GOAT_USD_MICROS_PER_CENT);
}

// Every money mutation below is a single-statement CTE chain. The web client
// is neon-http (no interactive transactions), so chaining the ledger insert
// and balance upsert inside one statement is what makes them atomic — do not
// split these into sequential drizzle calls.

function rowsFromExecute<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: T[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export async function getGoatCreditBalanceUsdMicros(
  workspaceId: string,
  db?: DbLike,
): Promise<number> {
  const result = await (db ?? getDb()).execute(sql`
    SELECT balance_usd_micros AS "balanceUsdMicros"
    FROM goat.credit_balances
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `);
  const rows = rowsFromExecute<{ balanceUsdMicros: number | string }>(result);
  return rows[0] ? Number(rows[0].balanceUsdMicros) : 0;
}

export async function hasPositiveGoatCreditBalance(workspaceId: string, db?: DbLike) {
  return (await getGoatCreditBalanceUsdMicros(workspaceId, db)) > 0;
}

export type GoatCreditDebitInput = {
  workspaceId: string;
  userWorkosId?: string | null;
  source: Extract<
    GoatCreditLedgerSource,
    "chat_model_usage" | "frontier_ingest" | "ingest_overage"
  >;
  idempotencyKey: string;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  costBasis: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  chatSessionId?: string | null;
  ingestJobId?: string | null;
  reservationId?: string | null;
  db?: DbLike;
};

// Unconditional debit: the balance may go negative (a turn that finishes after
// the balance hit zero still gets charged), matching the web credit system.
// The unique idempotency_key index turns replays into no-ops.
export async function recordGoatCreditDebit(input: GoatCreditDebitInput) {
  if (input.totalCostUsdMicros <= 0) {
    return { ok: false as const, reason: "zero_cost" as const };
  }
  const db = input.db ?? getDb();
  const result = await db.execute(sql`
    WITH ledger AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        user_workos_id,
        amount_cents,
        amount_usd_micros,
        source,
        idempotency_key,
        chat_session_id,
        ingest_job_id,
        reservation_id,
        provider_cost_usd_micros,
        platform_fee_usd_micros,
        cost_basis,
        metadata
      )
      VALUES (
        ${input.workspaceId},
        ${input.userWorkosId ?? null},
        ${-goatUsdMicrosToCents(input.totalCostUsdMicros)},
        ${-input.totalCostUsdMicros},
        ${input.source},
        ${input.idempotencyKey},
        ${input.chatSessionId ?? null},
        ${input.ingestJobId ?? null},
        ${input.reservationId ?? null},
        ${input.providerCostUsdMicros},
        ${input.platformFeeUsdMicros},
        ${JSON.stringify(input.costBasis)}::jsonb,
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      ON CONFLICT DO NOTHING
      RETURNING workspace_id, id, amount_usd_micros
    ),
    balance AS (
      INSERT INTO goat.credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT
        workspace_id,
        ${-goatUsdMicrosToCents(input.totalCostUsdMicros)},
        amount_usd_micros,
        now()
      FROM ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          balance_cents = ROUND((goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros)::numeric / ${GOAT_USD_MICROS_PER_CENT})::integer,
          updated_at = now()
      RETURNING workspace_id, balance_usd_micros
    )
    SELECT ledger.id AS "ledgerId", balance.balance_usd_micros AS "balanceUsdMicros"
    FROM ledger
    JOIN balance ON balance.workspace_id = ledger.workspace_id
  `);
  const rows = rowsFromExecute<{ ledgerId: number; balanceUsdMicros: number | string }>(result);
  if (!rows[0]) return { ok: false as const, reason: "duplicate" as const };
  return {
    ok: true as const,
    ledgerId: Number(rows[0].ledgerId),
    balanceUsdMicros: Number(rows[0].balanceUsdMicros),
  };
}

// One-time grant at workspace creation (and the backfill for pre-existing
// workspaces). The partial unique index on (workspace_id) WHERE
// source = 'starter_grant' makes re-runs no-ops.
export async function grantGoatStarterCredit(input: {
  workspaceId: string;
  userWorkosId?: string | null;
  amountCents: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const result = await db.execute(sql`
    WITH ledger AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        user_workos_id,
        amount_cents,
        amount_usd_micros,
        source,
        metadata
      )
      VALUES (
        ${input.workspaceId},
        ${input.userWorkosId ?? null},
        ${input.amountCents},
        ${input.amountCents}::bigint * ${GOAT_USD_MICROS_PER_CENT},
        'starter_grant',
        jsonb_build_object('reason', 'goat_workspace_starter_credit')
      )
      ON CONFLICT (workspace_id) WHERE source = 'starter_grant' DO NOTHING
      RETURNING id, workspace_id, amount_cents, amount_usd_micros
    ),
    balance AS (
      INSERT INTO goat.credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT workspace_id, amount_cents, amount_usd_micros, now()
      FROM ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = goat.credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          updated_at = now()
      RETURNING workspace_id, balance_cents
    )
    SELECT ledger.id AS "ledgerId", balance.balance_cents AS "balanceCents"
    FROM ledger
    JOIN balance ON balance.workspace_id = ledger.workspace_id
  `);
  const rows = rowsFromExecute<{ ledgerId: number; balanceCents: number }>(result);
  if (!rows[0]) return { ok: false as const, reason: "already_granted" as const };
  return { ok: true as const, ...rows[0] };
}

export async function createGoatPendingCheckoutRecord(input: {
  id: string;
  workspaceId: string;
  userWorkosId: string;
  amountCents: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await db.insert(goatStripeCheckoutSessions).values({
    id: input.id,
    workspaceId: input.workspaceId,
    userWorkosId: input.userWorkosId,
    amountCents: input.amountCents,
    status: "pending",
    metadata: {
      goatWorkspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      amountCents: String(input.amountCents),
      checkoutRecordId: input.id,
    },
  });
}

export async function markGoatCheckoutRecordOpen(input: {
  id: string;
  stripeCheckoutSessionId: string;
  metadata: Record<string, unknown>;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await db
    .update(goatStripeCheckoutSessions)
    .set({
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      status: "open",
      metadata: input.metadata,
      updatedAt: new Date(),
    })
    .where(eq(goatStripeCheckoutSessions.id, input.id));
}

export async function markGoatCheckoutRecordFailed(input: {
  id: string;
  error: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await db
    .update(goatStripeCheckoutSessions)
    .set({ status: "failed", metadata: { error: input.error }, updatedAt: new Date() })
    .where(eq(goatStripeCheckoutSessions.id, input.id));
}

// Called from the shared Stripe webhook for checkout.session.completed events
// with metadata.billingProduct === 'goat_topup'. The `fulfilled_at IS NULL`
// guard is the idempotency: Stripe retries and duplicate events no-op.
export async function fulfillGoatTopUpCheckoutSession(
  session: {
    id: string;
    payment_status: string | null;
    metadata?: Record<string, string> | null;
  },
  options: { eventId?: string } = {},
) {
  if (session.payment_status !== "paid") {
    return { ok: false as const, reason: "not_paid" as const };
  }
  const checkoutRecordId = session.metadata?.checkoutRecordId;
  const workspaceId = session.metadata?.goatWorkspaceId;
  const userWorkosId = session.metadata?.userWorkosId;
  const amountCents = Number(session.metadata?.amountCents);
  if (!checkoutRecordId || !workspaceId || !userWorkosId || !Number.isSafeInteger(amountCents)) {
    return { ok: false as const, reason: "missing_metadata" as const };
  }

  const db = getDb();
  const result = await db.execute(sql`
    WITH fulfilled_session AS (
      UPDATE goat.stripe_checkout_sessions
      SET status = 'fulfilled',
          fulfilled_at = now(),
          updated_at = now()
      WHERE id = ${checkoutRecordId}
        AND stripe_checkout_session_id = ${session.id}
        AND workspace_id = ${workspaceId}
        AND user_workos_id = ${userWorkosId}
        AND amount_cents = ${amountCents}
        AND fulfilled_at IS NULL
      RETURNING id, workspace_id, user_workos_id, amount_cents, stripe_checkout_session_id
    ),
    balance AS (
      INSERT INTO goat.credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT workspace_id, amount_cents, amount_cents::bigint * ${GOAT_USD_MICROS_PER_CENT}, now()
      FROM fulfilled_session
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = goat.credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          updated_at = now()
      RETURNING workspace_id, balance_cents
    ),
    ledger AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        user_workos_id,
        amount_cents,
        amount_usd_micros,
        source,
        checkout_session_id,
        metadata
      )
      SELECT
        workspace_id,
        user_workos_id,
        amount_cents,
        amount_cents::bigint * ${GOAT_USD_MICROS_PER_CENT},
        'stripe_topup',
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
      fulfilled_session.amount_cents AS "amountCents",
      balance.balance_cents AS "balanceCents"
    FROM fulfilled_session
    JOIN balance ON balance.workspace_id = fulfilled_session.workspace_id
  `);
  const rows = rowsFromExecute<{
    checkoutRecordId: string;
    amountCents: number;
    balanceCents: number;
  }>(result);
  if (!rows[0]) return { ok: false as const, reason: "already_fulfilled_or_missing" as const };
  return { ok: true as const, ...rows[0] };
}

export type GoatCreditLedgerEntryView = {
  id: number;
  amountUsdMicros: number;
  source: GoatCreditLedgerSource;
  createdAt: Date;
};

export type GoatCreditOverview = {
  balanceUsdMicros: number;
  spendThisMonthUsdMicros: number;
  recentEntries: GoatCreditLedgerEntryView[];
};

export async function loadGoatCreditOverview(
  workspaceId: string,
  options: { now?: Date; db?: DbLike } = {},
): Promise<GoatCreditOverview> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const balanceUsdMicros = await getGoatCreditBalanceUsdMicros(workspaceId, db);
  const spendResult = await db.execute(sql`
    SELECT COALESCE(-SUM(amount_usd_micros), 0) AS "spendUsdMicros"
    FROM goat.credit_ledger
    WHERE workspace_id = ${workspaceId}
      AND amount_usd_micros < 0
      AND created_at >= ${monthStart.toISOString()}
  `);
  const spendRows = rowsFromExecute<{ spendUsdMicros: number | string }>(spendResult);
  const entries = await db
    .select({
      id: goatCreditLedger.id,
      amountUsdMicros: goatCreditLedger.amountUsdMicros,
      source: goatCreditLedger.source,
      createdAt: goatCreditLedger.createdAt,
    })
    .from(goatCreditLedger)
    .where(eq(goatCreditLedger.workspaceId, workspaceId))
    .orderBy(desc(goatCreditLedger.createdAt), desc(goatCreditLedger.id))
    .limit(20);

  return {
    balanceUsdMicros,
    spendThisMonthUsdMicros: spendRows[0] ? Number(spendRows[0].spendUsdMicros) : 0,
    recentEntries: entries.map((entry: (typeof entries)[number]) => ({
      id: Number(entry.id),
      amountUsdMicros: Number(entry.amountUsdMicros),
      source: entry.source,
      createdAt: entry.createdAt,
    })),
  };
}

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { includedUsageAllowanceCents } from "./billing-constants";
import { getDb } from "./client";
import type { CreditLedgerSource, WorkspacePlan } from "./schema";
import { creditLedger, stripeCheckoutSessions } from "./schema";

type DbLike = any;

// Mirrors USD_MICROS_PER_CENT in @opencompany/billing; duplicated because the
// dependency points the other way (billing has no drizzle schema, db has no
// billing dependency).
export const USD_MICROS_PER_CENT = 10_000;

export function usdMicrosToCents(micros: number) {
  return Math.round(micros / USD_MICROS_PER_CENT);
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

export async function getCreditPoolsUsdMicros(
  workspaceId: string,
  db?: DbLike,
): Promise<{
  balanceUsdMicros: number;
  includedBalanceUsdMicros: number;
  topUpBalanceUsdMicros: number;
}> {
  const result = await (db ?? getDb()).execute(sql`
    SELECT
      balance_usd_micros AS "balanceUsdMicros",
      included_balance_usd_micros AS "includedBalanceUsdMicros",
      top_up_balance_usd_micros AS "topUpBalanceUsdMicros"
    FROM goat.credit_balances
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `);
  const rows = rowsFromExecute<{
    balanceUsdMicros: number | string;
    includedBalanceUsdMicros?: number | string | null;
    topUpBalanceUsdMicros?: number | string | null;
  }>(result);
  const row = rows[0];
  if (!row) {
    return { balanceUsdMicros: 0, includedBalanceUsdMicros: 0, topUpBalanceUsdMicros: 0 };
  }
  const balanceUsdMicros = Number(row.balanceUsdMicros);
  const includedBalanceUsdMicros = Number(row.includedBalanceUsdMicros ?? 0);
  const topUpBalanceUsdMicros =
    row.topUpBalanceUsdMicros === null || row.topUpBalanceUsdMicros === undefined
      ? balanceUsdMicros - includedBalanceUsdMicros
      : Number(row.topUpBalanceUsdMicros);
  return { balanceUsdMicros, includedBalanceUsdMicros, topUpBalanceUsdMicros };
}

export async function getCreditBalanceUsdMicros(workspaceId: string, db?: DbLike): Promise<number> {
  return (await getCreditPoolsUsdMicros(workspaceId, db)).balanceUsdMicros;
}

export async function hasPositiveCreditBalance(workspaceId: string, db?: DbLike) {
  return (await getCreditBalanceUsdMicros(workspaceId, db)) > 0;
}

export type CreditDebitInput = {
  workspaceId: string;
  userWorkosId?: string | null;
  // v4 debit sources only; "frontier_ingest"/"ingest_overage" are legacy
  // read-only history and "ingest_fee" is written by the admission CTE in
  // ./billing, never through this function.
  source: Extract<
    CreditLedgerSource,
    "chat_model_usage" | "ingest_model_usage" | "capability_usage"
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

// Unconditional debit: monthly included usage is spent first, then top-up
// funds. The aggregate balance may go negative (a turn that finishes after the
// balance hit zero still gets charged), matching the web credit system. The
// unique idempotency_key index turns replays into no-ops.
export async function recordCreditDebit(input: CreditDebitInput) {
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
        ${-usdMicrosToCents(input.totalCostUsdMicros)},
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
    locked_balance AS MATERIALIZED (
      SELECT
        workspace_id,
        greatest(included_balance_usd_micros, 0) AS included_balance_usd_micros,
        top_up_balance_usd_micros
      FROM goat.credit_balances
      WHERE workspace_id = ${input.workspaceId}
      FOR UPDATE
    ),
    debit_split AS (
      SELECT
        COALESCE((SELECT included_balance_usd_micros FROM locked_balance), 0) AS included_before,
        LEAST(
          ${input.totalCostUsdMicros}::bigint,
          COALESCE((SELECT included_balance_usd_micros FROM locked_balance), 0)
        ) AS included_debit,
        ${input.totalCostUsdMicros}::bigint - LEAST(
          ${input.totalCostUsdMicros}::bigint,
          COALESCE((SELECT included_balance_usd_micros FROM locked_balance), 0)
        ) AS top_up_debit
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
      SELECT
        workspace_id,
        ${-usdMicrosToCents(input.totalCostUsdMicros)},
        amount_usd_micros,
        0,
        ${-input.totalCostUsdMicros},
        now()
      FROM ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          balance_cents = ROUND((goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros)::numeric / ${USD_MICROS_PER_CENT})::integer,
          included_balance_usd_micros = goat.credit_balances.included_balance_usd_micros - (SELECT included_debit FROM debit_split),
          top_up_balance_usd_micros = goat.credit_balances.top_up_balance_usd_micros - (SELECT top_up_debit FROM debit_split),
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

// Rotates the expiring included pool on the first of each UTC month. Within a
// month the allowance only moves upward, so a Pro seat added mid-month gets
// its full $20 immediately while removing and re-adding a seat cannot mint the
// same allowance twice. Top-up and historical starter-grant funds are never
// expired or changed here.
export async function grantMonthlyIncludedUsage(input: {
  workspaceId: string;
  plan: WorkspacePlan;
  seatQuantity: number;
  periodStart: Date;
  periodEnd: Date;
  eventId?: string | null;
  db?: DbLike;
}) {
  if (!Number.isSafeInteger(input.seatQuantity) || input.seatQuantity < 1) {
    throw new Error("Monthly included usage requires at least one seat.");
  }
  if (!(input.periodStart < input.periodEnd)) {
    throw new Error("Monthly included usage requires a valid billing period.");
  }
  const targetAllowanceCents = includedUsageAllowanceCents(input.plan, input.seatQuantity);
  const db = input.db ?? getDb();
  const grantKey = `included_usage_grant:${input.workspaceId}:${input.periodStart.toISOString()}:${targetAllowanceCents}`;
  const expireKey = `included_usage_expiration:${input.workspaceId}:${input.periodStart.toISOString()}`;
  const expirationMetadata = JSON.stringify({
    reason: "included_usage_no_rollover",
    newPeriodStart: input.periodStart.toISOString(),
    stripeEventId: input.eventId ?? null,
  });
  const grantMetadata = JSON.stringify({
    reason: "monthly_included_usage",
    plan: input.plan,
    seatQuantity: input.seatQuantity,
    allowanceCents: targetAllowanceCents,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    stripeEventId: input.eventId ?? null,
  });

  // The billing row must exist before the grant statement starts. PostgreSQL
  // data-modifying CTEs share one snapshot and cannot reliably modify the same
  // row twice, so an upsert inside `current_billing` followed by
  // `billing_update` leaves the period projection stale. A default row is a
  // safe, retryable intermediate state if the grant statement later fails.
  await db.execute(sql`
    INSERT INTO goat.workspace_billing (workspace_id)
    VALUES (${input.workspaceId})
    ON CONFLICT (workspace_id) DO NOTHING
  `);

  const result = await db.execute(sql`
    WITH current_billing AS MATERIALIZED (
      SELECT included_usage_period_start, included_usage_allowance_cents
      FROM goat.workspace_billing
      WHERE workspace_id = ${input.workspaceId}
      FOR UPDATE
    ),
    locked_balance AS MATERIALIZED (
      SELECT workspace_id, included_balance_usd_micros
      FROM goat.credit_balances
      WHERE workspace_id = ${input.workspaceId}
      FOR UPDATE
    ),
    should_rotate AS (
      SELECT COALESCE(
        (SELECT included_usage_period_start IS DISTINCT FROM ${input.periodStart.toISOString()}::timestamptz FROM current_billing),
        true
      ) AS value
    ),
    grant_amount AS (
      SELECT GREATEST(
        ${targetAllowanceCents} - CASE
          WHEN (SELECT value FROM should_rotate) THEN 0
          ELSE COALESCE((SELECT included_usage_allowance_cents FROM current_billing), 0)
        END,
        0
      )::integer AS cents
    ),
    expiration AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        amount_cents,
        amount_usd_micros,
        source,
        idempotency_key,
        metadata
      )
      SELECT
        ${input.workspaceId},
        -ROUND(COALESCE(included_balance_usd_micros, 0)::numeric / ${USD_MICROS_PER_CENT})::integer,
        -COALESCE(included_balance_usd_micros, 0),
        'included_usage_expiration',
        ${expireKey},
        ${expirationMetadata}::jsonb
      FROM locked_balance
      WHERE (SELECT value FROM should_rotate)
        AND COALESCE(included_balance_usd_micros, 0) > 0
      ON CONFLICT DO NOTHING
      RETURNING amount_usd_micros
    ),
    grant_row AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        amount_cents,
        amount_usd_micros,
        source,
        idempotency_key,
        metadata
      )
      SELECT
        ${input.workspaceId},
        (SELECT cents FROM grant_amount),
        (SELECT cents FROM grant_amount)::bigint * ${USD_MICROS_PER_CENT},
        'included_usage_grant',
        ${grantKey},
        ${grantMetadata}::jsonb
      WHERE (SELECT cents FROM grant_amount) > 0
      ON CONFLICT DO NOTHING
      RETURNING amount_usd_micros
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
      SELECT
        ${input.workspaceId},
        ROUND((COALESCE((SELECT SUM(amount_usd_micros) FROM expiration), 0) + COALESCE((SELECT SUM(amount_usd_micros) FROM grant_row), 0))::numeric / ${USD_MICROS_PER_CENT})::integer,
        COALESCE((SELECT SUM(amount_usd_micros) FROM expiration), 0) + COALESCE((SELECT SUM(amount_usd_micros) FROM grant_row), 0),
        COALESCE((SELECT SUM(amount_usd_micros) FROM expiration), 0) + COALESCE((SELECT SUM(amount_usd_micros) FROM grant_row), 0),
        0,
        now()
      WHERE EXISTS (SELECT 1 FROM expiration) OR EXISTS (SELECT 1 FROM grant_row)
      ON CONFLICT (workspace_id) DO UPDATE
      SET included_balance_usd_micros = goat.credit_balances.included_balance_usd_micros + excluded.included_balance_usd_micros,
          balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          balance_cents = ROUND((goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros)::numeric / ${USD_MICROS_PER_CENT})::integer,
          updated_at = now()
      RETURNING balance_usd_micros
    ),
    billing_update AS (
      UPDATE goat.workspace_billing
      SET included_usage_period_start = ${input.periodStart.toISOString()},
          included_usage_period_end = ${input.periodEnd.toISOString()},
          included_usage_allowance_cents = CASE
            WHEN (SELECT value FROM should_rotate) THEN ${targetAllowanceCents}
            ELSE GREATEST(included_usage_allowance_cents, ${targetAllowanceCents})
          END,
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
      RETURNING included_usage_allowance_cents
    )
    SELECT
      COALESCE((SELECT COUNT(*) FROM grant_row), 0)::integer AS "grants",
      COALESCE((SELECT COUNT(*) FROM expiration), 0)::integer AS "expirations",
      COALESCE((SELECT balance_usd_micros FROM balance), NULL) AS "balanceUsdMicros",
      (SELECT included_usage_allowance_cents FROM billing_update) AS "allowanceCents"
  `);
  const rows = rowsFromExecute<{
    grants: number | string;
    expirations: number | string;
    balanceUsdMicros: number | string | null;
    allowanceCents: number | string;
  }>(result);
  const row = rows[0];
  return {
    ok: Number(row?.grants ?? 0) > 0,
    grants: Number(row?.grants ?? 0),
    expirations: Number(row?.expirations ?? 0),
    balanceUsdMicros: row?.balanceUsdMicros == null ? null : Number(row.balanceUsdMicros),
    allowanceCents: Number(row?.allowanceCents ?? targetAllowanceCents),
  };
}

export async function createPendingCheckoutRecord(input: {
  id: string;
  workspaceId: string;
  userWorkosId: string;
  amountCents: number;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await db.insert(stripeCheckoutSessions).values({
    id: input.id,
    workspaceId: input.workspaceId,
    userWorkosId: input.userWorkosId,
    amountCents: input.amountCents,
    status: "pending",
    metadata: {
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      amountCents: String(input.amountCents),
      checkoutRecordId: input.id,
    },
  });
}

export async function markCheckoutRecordOpen(input: {
  id: string;
  stripeCheckoutSessionId: string;
  metadata: Record<string, unknown>;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  await db
    .update(stripeCheckoutSessions)
    .set({
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      status: "open",
      metadata: input.metadata,
      updatedAt: new Date(),
    })
    .where(eq(stripeCheckoutSessions.id, input.id));
}

export async function markCheckoutRecordFailed(input: { id: string; error: string; db?: DbLike }) {
  const db = input.db ?? getDb();
  await db
    .update(stripeCheckoutSessions)
    .set({ status: "failed", metadata: { error: input.error }, updatedAt: new Date() })
    .where(
      and(eq(stripeCheckoutSessions.id, input.id), isNull(stripeCheckoutSessions.fulfilledAt)),
    );
}

// Called from the shared Stripe webhook for immediate or delayed successful
// opencompany top-up Checkout events. The `fulfilled_at IS NULL` guard is the
// idempotency: overlapping event types and Stripe retries no-op.
export async function fulfillTopUpCheckoutSession(
  session: {
    id: string;
    payment_status: string | null;
    status?: string | null;
    amount_total?: number | null;
    metadata?: Record<string, string> | null;
  },
  options: { eventId?: string; db?: DbLike } = {},
) {
  const isCompletedNoCostOrder =
    session.payment_status === "no_payment_required" &&
    session.status === "complete" &&
    session.amount_total === 0;
  if (session.payment_status !== "paid" && !isCompletedNoCostOrder) {
    return { ok: false as const, reason: "not_paid" as const };
  }
  const checkoutRecordId = session.metadata?.checkoutRecordId;
  const workspaceId = session.metadata?.workspaceId;
  const userWorkosId = session.metadata?.userWorkosId;
  const amountCents = Number(session.metadata?.amountCents);
  if (!checkoutRecordId || !workspaceId || !userWorkosId || !Number.isSafeInteger(amountCents)) {
    return { ok: false as const, reason: "missing_metadata" as const };
  }

  const db = options.db ?? getDb();
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
      INSERT INTO goat.credit_balances (
        workspace_id,
        balance_cents,
        balance_usd_micros,
        included_balance_usd_micros,
        top_up_balance_usd_micros,
        updated_at
      )
      SELECT
        workspace_id,
        amount_cents,
        amount_cents::bigint * ${USD_MICROS_PER_CENT},
        0,
        amount_cents::bigint * ${USD_MICROS_PER_CENT},
        now()
      FROM fulfilled_session
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = goat.credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          top_up_balance_usd_micros = goat.credit_balances.top_up_balance_usd_micros + excluded.balance_usd_micros,
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
        amount_cents::bigint * ${USD_MICROS_PER_CENT},
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

// Off-session auto-refill fulfillment. The unique idempotency key on the
// PaymentIntent id makes the synchronous confirm path and the
// payment_intent.succeeded webhook safe to both run.
export async function recordAutoRefillCredit(input: {
  workspaceId: string;
  amountCents: number;
  paymentIntentId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const result = await db.execute(sql`
    WITH ledger AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        amount_cents,
        amount_usd_micros,
        source,
        idempotency_key,
        metadata
      )
      VALUES (
        ${input.workspaceId},
        ${input.amountCents},
        ${input.amountCents}::bigint * ${USD_MICROS_PER_CENT},
        'stripe_topup',
        ${`pi:${input.paymentIntentId}`},
        jsonb_build_object('kind', 'auto_refill', 'stripePaymentIntentId', ${input.paymentIntentId})
      )
      ON CONFLICT DO NOTHING
      RETURNING id, workspace_id, amount_cents, amount_usd_micros
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
      SELECT workspace_id, amount_cents, amount_usd_micros, 0, amount_usd_micros, now()
      FROM ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = goat.credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          top_up_balance_usd_micros = goat.credit_balances.top_up_balance_usd_micros + excluded.balance_usd_micros,
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

export type SpendCategory = "chat" | "ingestion" | "capabilities" | "other";

export type SpendBreakdownRow = {
  day: string;
  category: SpendCategory;
  spendUsdMicros: number;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
};

// Daily debit totals by category with the raw-model-cost vs platform-fee
// split, for the usage dashboard. Legacy v3 sources map into "ingestion" so
// history stays visible.
export async function loadSpendBreakdown(
  workspaceId: string,
  options: { days?: number; now?: Date; db?: DbLike } = {},
): Promise<SpendBreakdownRow[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.days ?? 30) * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  const result = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
      CASE
        WHEN source = 'chat_model_usage' THEN 'chat'
        WHEN source IN ('ingest_model_usage', 'ingest_fee', 'frontier_ingest', 'ingest_overage') THEN 'ingestion'
        WHEN source = 'capability_usage' THEN 'capabilities'
        ELSE 'other'
      END AS "category",
      -SUM(amount_usd_micros) AS "spendUsdMicros",
      SUM(provider_cost_usd_micros) AS "providerCostUsdMicros",
      SUM(platform_fee_usd_micros) AS "platformFeeUsdMicros"
    FROM goat.credit_ledger
    WHERE workspace_id = ${workspaceId}
      AND amount_usd_micros < 0
      AND created_at >= ${since.toISOString()}
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2 ASC
  `);
  return rowsFromExecute<{
    day: string;
    category: SpendCategory;
    spendUsdMicros: number | string;
    providerCostUsdMicros: number | string;
    platformFeeUsdMicros: number | string;
  }>(result).map((row) => ({
    day: row.day,
    category: row.category,
    spendUsdMicros: Number(row.spendUsdMicros),
    providerCostUsdMicros: Number(row.providerCostUsdMicros),
    platformFeeUsdMicros: Number(row.platformFeeUsdMicros),
  }));
}

export type CreditLedgerEntryView = {
  id: number;
  amountUsdMicros: number;
  source: CreditLedgerSource;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type CreditOverview = {
  balanceUsdMicros: number;
  spendThisMonthUsdMicros: number;
  spendThisMonthByCategory: Record<Exclude<SpendCategory, "other">, number>;
  recentEntries: CreditLedgerEntryView[];
};

export async function loadCreditOverview(
  workspaceId: string,
  options: { now?: Date; db?: DbLike } = {},
): Promise<CreditOverview> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const balanceUsdMicros = await getCreditBalanceUsdMicros(workspaceId, db);
  const spendResult = await db.execute(sql`
    SELECT COALESCE(-SUM(amount_usd_micros), 0) AS "spendUsdMicros"
    FROM goat.credit_ledger
    WHERE workspace_id = ${workspaceId}
      AND amount_usd_micros < 0
      AND created_at >= ${monthStart.toISOString()}
  `);
  const spendRows = rowsFromExecute<{ spendUsdMicros: number | string }>(spendResult);
  const categorySpendResult = await db.execute(sql`
    SELECT
      CASE
        WHEN source = 'chat_model_usage' THEN 'chat'
        WHEN source IN ('ingest_model_usage', 'ingest_fee', 'frontier_ingest', 'ingest_overage') THEN 'ingestion'
        WHEN source = 'capability_usage' THEN 'capabilities'
        ELSE 'other'
      END AS "category",
      COALESCE(-SUM(amount_usd_micros), 0) AS "spendUsdMicros"
    FROM goat.credit_ledger
    WHERE workspace_id = ${workspaceId}
      AND amount_usd_micros < 0
      AND created_at >= ${monthStart.toISOString()}
    GROUP BY 1
  `);
  const categorySpendRows = rowsFromExecute<{
    category: SpendCategory;
    spendUsdMicros: number | string;
  }>(categorySpendResult);
  const spendThisMonthByCategory = {
    chat: 0,
    ingestion: 0,
    capabilities: 0,
  };
  for (const row of categorySpendRows) {
    if (row.category !== "other") {
      spendThisMonthByCategory[row.category] = Number(row.spendUsdMicros);
    }
  }
  const entries = await db
    .select({
      id: creditLedger.id,
      amountUsdMicros: creditLedger.amountUsdMicros,
      source: creditLedger.source,
      providerCostUsdMicros: creditLedger.providerCostUsdMicros,
      platformFeeUsdMicros: creditLedger.platformFeeUsdMicros,
      metadata: creditLedger.metadata,
      createdAt: creditLedger.createdAt,
    })
    .from(creditLedger)
    .where(eq(creditLedger.workspaceId, workspaceId))
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(20);

  return {
    balanceUsdMicros,
    spendThisMonthUsdMicros: spendRows[0] ? Number(spendRows[0].spendUsdMicros) : 0,
    spendThisMonthByCategory,
    recentEntries: entries.map((entry: (typeof entries)[number]) => ({
      id: Number(entry.id),
      amountUsdMicros: Number(entry.amountUsdMicros),
      source: entry.source,
      providerCostUsdMicros: Number(entry.providerCostUsdMicros),
      platformFeeUsdMicros: Number(entry.platformFeeUsdMicros),
      metadata:
        entry.metadata && typeof entry.metadata === "object"
          ? (entry.metadata as Record<string, unknown>)
          : {},
      createdAt: entry.createdAt,
    })),
  };
}

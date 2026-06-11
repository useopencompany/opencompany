import { randomUUID } from "node:crypto";
import {
  centsToUsdMicros,
  getWorkspaceSpendCapStatus,
  USD_MICROS_PER_CENT,
  usdMicrosToCents,
} from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import {
  creditCodeRedemptions,
  creditCodes,
  stripeCheckoutSessions,
  workspaceCreditBalances,
  workspaceCreditLedger,
} from "@opencompany/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { normalizeCreditCode } from "@/lib/billing/constants";

export type BillingLedgerEntry = {
  id: number;
  amountCents: number;
  amountUsdMicros: number;
  source: string;
  sessionId: string | null;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  createdAt: Date;
  costBasis: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type BillingSessionChargeSummary = {
  sessionId: string;
  title: string;
  agentName: string;
  totalUsdMicros: number;
  modelCostUsdMicros: number;
  toolCostUsdMicros: number;
  sandboxCostUsdMicros: number;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  createdAt: Date;
};

type ExecuteResultRow = Record<string, unknown>;

export const DEFAULT_SIGNUP_CREDIT_AMOUNT_CENTS = 300;

function rowsFromExecute<T extends ExecuteResultRow>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function readTimestamp(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

export function newStripeCheckoutRecordId() {
  return `chk_${randomUUID()}`;
}

export async function loadBillingOverview(workspaceId: string) {
  const db = getDb();
  const [balanceRow, ledgerRows, spendRows, sessionChargeRows, spendCap] = await Promise.all([
    db
      .select({
        balanceCents: workspaceCreditBalances.balanceCents,
        balanceUsdMicros: workspaceCreditBalances.balanceUsdMicros,
      })
      .from(workspaceCreditBalances)
      .where(eq(workspaceCreditBalances.workspaceId, workspaceId))
      .limit(1),
    db
      .select({
        id: workspaceCreditLedger.id,
        amountCents: workspaceCreditLedger.amountCents,
        amountUsdMicros: workspaceCreditLedger.amountUsdMicros,
        source: workspaceCreditLedger.source,
        sessionId: workspaceCreditLedger.sessionId,
        providerCostUsdMicros: workspaceCreditLedger.providerCostUsdMicros,
        platformFeeUsdMicros: workspaceCreditLedger.platformFeeUsdMicros,
        createdAt: workspaceCreditLedger.createdAt,
        costBasis: workspaceCreditLedger.costBasis,
        metadata: workspaceCreditLedger.metadata,
      })
      .from(workspaceCreditLedger)
      .where(eq(workspaceCreditLedger.workspaceId, workspaceId))
      .orderBy(desc(workspaceCreditLedger.createdAt))
      .limit(20),
    db.execute(sql`
      SELECT
        COALESCE(SUM(-amount_usd_micros) FILTER (
          WHERE amount_usd_micros < 0 AND created_at >= now() - interval '7 days'
        ), 0) AS "spendLast7UsdMicros",
        COALESCE(SUM(-amount_usd_micros) FILTER (
          WHERE amount_usd_micros < 0 AND created_at >= now() - interval '30 days'
        ), 0) AS "spendLast30UsdMicros"
      FROM workspace_credit_ledger
      WHERE workspace_id = ${workspaceId}
    `),
    db.execute(sql`
      WITH RECURSIVE session_tree(id, root_id, path) AS (
        SELECT id, id AS root_id, ARRAY[id]::text[]
        FROM agent_sessions
        WHERE workspace_id = ${workspaceId}
          AND parent_session_id IS NULL
        UNION ALL
        SELECT child.id, session_tree.root_id, session_tree.path || child.id
        FROM agent_sessions child
        INNER JOIN session_tree ON child.parent_session_id = session_tree.id
        WHERE child.workspace_id = ${workspaceId}
          AND NOT child.id = ANY(session_tree.path)
      ),
      ledger_with_root AS (
        SELECT
          ledger.*,
          COALESCE(session_tree.root_id, ledger.session_id) AS root_session_id
        FROM workspace_credit_ledger ledger
        LEFT JOIN session_tree ON session_tree.id = ledger.session_id
        WHERE ledger.workspace_id = ${workspaceId}
          AND ledger.amount_usd_micros < 0
          AND ledger.session_id IS NOT NULL
      )
      SELECT
        root_session_id AS "sessionId",
        root_session.title AS "title",
        root_agent.name AS "agentName",
        COALESCE(SUM(-ledger_with_root.amount_usd_micros), 0) AS "totalUsdMicros",
        COALESCE(SUM(-ledger_with_root.amount_usd_micros) FILTER (WHERE ledger_with_root.source = 'model_usage'), 0) AS "modelCostUsdMicros",
        COALESCE(SUM(-ledger_with_root.amount_usd_micros) FILTER (WHERE ledger_with_root.source = 'tool_usage'), 0) AS "toolCostUsdMicros",
        COALESCE(SUM(-ledger_with_root.amount_usd_micros) FILTER (WHERE ledger_with_root.source = 'sandbox_usage'), 0) AS "sandboxCostUsdMicros",
        COALESCE(SUM(ledger_with_root.provider_cost_usd_micros), 0) AS "providerCostUsdMicros",
        COALESCE(SUM(ledger_with_root.platform_fee_usd_micros), 0) AS "platformFeeUsdMicros",
        MAX(ledger_with_root.created_at) AS "createdAt"
      FROM ledger_with_root
      INNER JOIN agent_sessions root_session ON root_session.id = ledger_with_root.root_session_id
      INNER JOIN agents root_agent ON root_agent.id = root_session.agent_id
      GROUP BY root_session_id, root_session.title, root_agent.name
      ORDER BY MAX(ledger_with_root.created_at) DESC
      LIMIT 5
    `),
    getWorkspaceSpendCapStatus({ db, workspaceId }),
  ]);
  const balanceUsdMicros =
    balanceRow[0]?.balanceUsdMicros ?? centsToUsdMicros(balanceRow[0]?.balanceCents ?? 0);
  const spend = rowsFromExecute<{
    spendLast7UsdMicros: number | string;
    spendLast30UsdMicros: number | string;
  }>(spendRows)[0];

  return {
    balanceUsdMicros,
    balanceCents: usdMicrosToCents(balanceUsdMicros),
    spendLast7UsdMicros: readMicros(spend?.spendLast7UsdMicros),
    spendLast30UsdMicros: readMicros(spend?.spendLast30UsdMicros),
    dailyCap: {
      enabled: spendCap.capConfigured,
      capUsdMicros: spendCap.capUsdMicros,
      spentTrailing24hUsdMicros: spendCap.spentTrailing24hUsdMicros,
      overCap: spendCap.overCap,
    },
    recentSessionCharges: rowsFromExecute<BillingSessionChargeSummary>(sessionChargeRows)
      .filter((row): row is typeof row & { sessionId: string } => Boolean(row.sessionId))
      .map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        agentName: row.agentName,
        totalUsdMicros: readMicros(row.totalUsdMicros),
        modelCostUsdMicros: readMicros(row.modelCostUsdMicros),
        toolCostUsdMicros: readMicros(row.toolCostUsdMicros),
        sandboxCostUsdMicros: readMicros(row.sandboxCostUsdMicros),
        providerCostUsdMicros: readMicros(row.providerCostUsdMicros),
        platformFeeUsdMicros: readMicros(row.platformFeeUsdMicros),
        createdAt: readTimestamp(row.createdAt),
      })) satisfies BillingSessionChargeSummary[],
    ledger: ledgerRows.map((row) => ({
      ...row,
      createdAt: readTimestamp(row.createdAt),
    })) satisfies BillingLedgerEntry[],
  };
}

export async function createPendingCheckoutRecord(input: {
  id: string;
  workspaceId: string;
  userId: string;
  amountCents: number;
}) {
  const db = getDb();

  await db.insert(stripeCheckoutSessions).values({
    id: input.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    amountCents: input.amountCents,
    status: "pending",
    metadata: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      amountCents: String(input.amountCents),
      checkoutRecordId: input.id,
    },
  });
}

export async function grantDefaultSignupCreditForWorkspace(input: {
  workspaceId: string;
  userId: string;
}) {
  const db = getDb();
  const amountCents = DEFAULT_SIGNUP_CREDIT_AMOUNT_CENTS;

  const result = await db.execute(sql`
    WITH ledger AS (
      INSERT INTO workspace_credit_ledger (
        workspace_id,
        user_id,
        amount_cents,
        amount_usd_micros,
        source,
        metadata
      )
      VALUES (
        ${input.workspaceId},
        ${input.userId},
        ${amountCents},
        ${amountCents}::bigint * ${USD_MICROS_PER_CENT},
        'signup_bonus',
        jsonb_build_object('reason', 'default_signup_credit')
      )
      ON CONFLICT (workspace_id) WHERE source = 'signup_bonus' DO NOTHING
      RETURNING id, workspace_id, amount_cents, amount_usd_micros
    ),
    balance AS (
      INSERT INTO workspace_credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT workspace_id, amount_cents, amount_usd_micros, now()
      FROM ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = workspace_credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = workspace_credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          updated_at = now()
      RETURNING workspace_id, balance_cents
    )
    SELECT
      ledger.id AS "ledgerId",
      ledger.amount_cents AS "amountCents",
      balance.balance_cents AS "balanceCents"
    FROM ledger
    JOIN balance ON balance.workspace_id = ledger.workspace_id
  `);

  const rows = rowsFromExecute<{
    ledgerId: number;
    amountCents: number;
    balanceCents: number;
  }>(result);

  if (!rows[0]) {
    return { ok: false as const, reason: "already_granted" as const };
  }

  return { ok: true as const, ...rows[0] };
}

export async function markCheckoutRecordOpen(input: {
  id: string;
  stripeCheckoutSessionId: string;
  metadata: Record<string, unknown>;
}) {
  const db = getDb();

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

export async function markCheckoutRecordFailed(input: { id: string; error: string }) {
  const db = getDb();

  await db
    .update(stripeCheckoutSessions)
    .set({
      status: "failed",
      metadata: { error: input.error },
      updatedAt: new Date(),
    })
    .where(eq(stripeCheckoutSessions.id, input.id));
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

async function describeRedeemFailure(input: { code: string; workspaceId: string }) {
  const db = getDb();
  const [code] = await db
    .select({
      id: creditCodes.id,
      active: creditCodes.active,
      startsAt: creditCodes.startsAt,
      expiresAt: creditCodes.expiresAt,
      maxRedemptions: creditCodes.maxRedemptions,
      redeemedCount: creditCodes.redeemedCount,
    })
    .from(creditCodes)
    .where(eq(creditCodes.code, input.code))
    .limit(1);

  if (!code) return "Code not found.";

  const [redemption] = await db
    .select({ id: creditCodeRedemptions.id })
    .from(creditCodeRedemptions)
    .where(
      and(
        eq(creditCodeRedemptions.creditCodeId, code.id),
        eq(creditCodeRedemptions.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);

  if (redemption) return "Code has already been redeemed for this workspace.";
  if (!code.active) return "Code is not active.";

  const now = Date.now();
  if (code.startsAt && code.startsAt.getTime() > now) return "Code is not active yet.";
  if (code.expiresAt && code.expiresAt.getTime() <= now) return "Code has expired.";
  if (code.maxRedemptions !== null && code.redeemedCount >= code.maxRedemptions) {
    return "Code has already been fully redeemed.";
  }

  return "Code could not be redeemed.";
}

export async function redeemCreditCodeForWorkspace(input: {
  code: string;
  workspaceId: string;
  userId: string;
}) {
  const normalizedCode = normalizeCreditCode(input.code);
  if (!normalizedCode) {
    return { ok: false as const, error: "Code is required." };
  }

  const db = getDb();
  const result = await db.execute(sql`
    WITH matched_code AS (
      SELECT id, code, amount_cents
      FROM credit_codes
      WHERE code = ${normalizedCode}
        AND active = true
        AND (starts_at IS NULL OR starts_at <= now())
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    ),
    claimed_code AS (
      UPDATE credit_codes
      SET redeemed_count = redeemed_count + 1,
          updated_at = now()
      WHERE id IN (SELECT id FROM matched_code)
        AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
      RETURNING id, code, amount_cents
    ),
    redemption AS (
      INSERT INTO credit_code_redemptions (credit_code_id, workspace_id, user_id, amount_cents)
      SELECT id, ${input.workspaceId}, ${input.userId}, amount_cents
      FROM claimed_code
      ON CONFLICT (credit_code_id, workspace_id) DO NOTHING
      RETURNING id, credit_code_id, amount_cents
    ),
    undo_duplicate_claim AS (
      UPDATE credit_codes
      SET redeemed_count = GREATEST(redeemed_count - 1, 0),
          updated_at = now()
      WHERE id IN (SELECT id FROM claimed_code)
        AND NOT EXISTS (SELECT 1 FROM redemption)
      RETURNING id
    ),
    balance AS (
      INSERT INTO workspace_credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT ${input.workspaceId}, amount_cents, amount_cents::bigint * ${USD_MICROS_PER_CENT}, now()
      FROM redemption
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
        credit_code_redemption_id,
        metadata
      )
      SELECT
        ${input.workspaceId},
        ${input.userId},
        redemption.amount_cents,
        redemption.amount_cents::bigint * ${USD_MICROS_PER_CENT},
        'credit_code',
        redemption.id,
        jsonb_build_object(
          'creditCodeId', redemption.credit_code_id,
          'code', ${normalizedCode}
        )
      FROM redemption
      RETURNING id
    )
    SELECT
      redemption.id AS "redemptionId",
      redemption.amount_cents AS "amountCents",
      balance.balance_cents AS "balanceCents",
      ledger.id AS "ledgerId"
    FROM redemption
    JOIN balance ON balance.workspace_id = ${input.workspaceId}
    JOIN ledger ON true
  `);

  const rows = rowsFromExecute<{
    redemptionId: number;
    amountCents: number;
    balanceCents: number;
    ledgerId: number;
  }>(result);

  if (!rows[0]) {
    return {
      ok: false as const,
      error: await describeRedeemFailure({ code: normalizedCode, workspaceId: input.workspaceId }),
    };
  }

  return { ok: true as const, ...rows[0] };
}

function readMicros(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

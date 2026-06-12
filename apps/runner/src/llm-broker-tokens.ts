import { createHash, randomBytes, randomUUID } from "node:crypto";
import { calculateHostedToolUsageCost, recordWorkspaceUsageDebit } from "@opencompany/billing";
import { createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import { rowsFromExecute } from "./sql-exec";

const brokerLogger = createLogger({ service: "opencompany-runner", runtime: "llm-broker" });

// Per-delegation tokens for the runner-hosted LLM broker (see llm-broker.ts). A hosted
// coding tool or the memory CLI authenticates to the broker with one of these opaque
// tokens instead of a raw provider key; the broker meters every upstream request against
// the token, and `settleBrokerToken` turns the metered total into the single billable
// agent_session_tool_usage row for the delegation.
//
// Settlement deliberately does NOT use the run-lease guard: upstream spend has already
// happened, so it must be billed even when the lease was reclaimed mid-delegation. The
// double-billing defense is the atomic CAS on `settled_at` in `claimSettlement` instead —
// exactly one caller (tool finally, session archive/abort, or the expiry sweeper, on any
// runner instance) wins the claim.

export type BrokerProvider = "gateway" | "openai";

const TOKEN_PREFIX = "ocbt_";
export const DEFAULT_BROKER_TOKEN_BUDGET_USD_MICROS = 5_000_000;

export type MintBrokerTokenInput = {
  sessionId: string;
  workspaceId: string;
  messageId: string | null;
  toolCallId: string | null;
  toolName: string;
  provider: BrokerProvider;
  ttlMs: number;
  budgetUsdMicros?: number | null;
};

export type MintedBrokerToken = {
  tokenId: string;
  token: string;
  expiresAt: Date;
};

// Result of a hash lookup for an incoming broker request. Budget enforcement happens in
// the route handler (spent vs budget) so the 402 can carry the numbers.
export type ValidatedBrokerToken = {
  id: string;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  provider: BrokerProvider;
  budgetUsdMicros: number | null;
  spentUsdMicros: number;
};

export type BrokerSpendInput = {
  tokenId: string;
  sessionId: string;
  endpoint: string;
  model: string | null;
  streamed: boolean;
  upstreamStatus: number | null;
  inputTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  usageParsed: boolean;
  latencyMs: number | null;
  rawUsage: Record<string, unknown>;
};

// Denormalized totals returned by the settlement CAS — everything needed to write the
// billable tool-usage row without re-aggregating llm_broker_requests.
export type BrokerTokenTotals = {
  id: string;
  sessionId: string;
  workspaceId: string;
  messageId: string | null;
  toolCallId: string | null;
  toolName: string;
  provider: BrokerProvider;
  spentUsdMicros: number;
  requestCount: number;
  inputTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  unparsedRequestCount: number;
};

type InsertTokenRow = {
  id: string;
  tokenHash: string;
  sessionId: string;
  workspaceId: string;
  messageId: string | null;
  toolCallId: string | null;
  toolName: string;
  provider: BrokerProvider;
  budgetUsdMicros: number | null;
  expiresAt: Date;
};

// DB seam, mirroring LeaseWriteStore: every method is a single atomic statement so the
// behaviour is testable without a database and safe across runner instances.
export type BrokerTokenStore = {
  insertToken(row: InsertTokenRow): Promise<void>;
  findActiveByHash(tokenHash: string): Promise<ValidatedBrokerToken | null>;
  recordSpend(input: BrokerSpendInput): Promise<void>;
  revokeToken(tokenId: string): Promise<void>;
  revokeTokensForSession(sessionId: string): Promise<string[]>;
  claimSettlement(tokenId: string): Promise<BrokerTokenTotals | null>;
  findSettleableTokenIds(limit: number): Promise<string[]>;
  insertSettledToolUsage(input: {
    sessionId: string;
    messageId: string | null;
    toolCallId: string;
    toolName: string;
    provider: string;
    operation: string;
    costUsdMicros: number;
    rawUsage: Record<string, unknown>;
  }): Promise<{ id: number }>;
  linkSettledToolUsage(tokenId: string, toolUsageId: number): Promise<void>;
};

export function hashBrokerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function brokerTokenBudgetUsdMicros(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_BROKER_TOKEN_BUDGET_USD_MICROS;
  }
  return Math.min(Math.round(value), DEFAULT_BROKER_TOKEN_BUDGET_USD_MICROS);
}

const TOTALS_COLUMNS = sql`
  id,
  session_id AS "sessionId",
  workspace_id AS "workspaceId",
  message_id AS "messageId",
  tool_call_id AS "toolCallId",
  tool_name AS "toolName",
  provider,
  spent_usd_micros AS "spentUsdMicros",
  request_count AS "requestCount",
  input_tokens AS "inputTokens",
  input_cache_read_tokens AS "inputCacheReadTokens",
  input_cache_write_tokens AS "inputCacheWriteTokens",
  output_tokens AS "outputTokens",
  unparsed_request_count AS "unparsedRequestCount"
`;

export function createDbBrokerTokenStore(): BrokerTokenStore {
  return {
    async insertToken(row) {
      await getDb().execute(sql`
        INSERT INTO llm_broker_tokens (
          id, token_hash, session_id, workspace_id, message_id, tool_call_id,
          tool_name, provider, budget_usd_micros, expires_at
        )
        VALUES (
          ${row.id}, ${row.tokenHash}, ${row.sessionId}, ${row.workspaceId},
          ${row.messageId}, ${row.toolCallId}, ${row.toolName}, ${row.provider},
          ${row.budgetUsdMicros}, ${row.expiresAt}
        )
      `);
    },

    async findActiveByHash(tokenHash) {
      const result = await getDb().execute(sql`
        SELECT
          id,
          session_id AS "sessionId",
          workspace_id AS "workspaceId",
          tool_name AS "toolName",
          provider,
          budget_usd_micros AS "budgetUsdMicros",
          spent_usd_micros AS "spentUsdMicros"
        FROM llm_broker_tokens
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND settled_at IS NULL
          AND expires_at > now()
        LIMIT 1
      `);
      const row = rowsFromExecute<ValidatedBrokerToken>(result)[0];
      if (!row) return null;
      return {
        ...row,
        budgetUsdMicros: row.budgetUsdMicros == null ? null : Number(row.budgetUsdMicros),
        spentUsdMicros: Number(row.spentUsdMicros),
      };
    },

    async recordSpend(input) {
      // One statement: audit row + denormalized token counters, so budget enforcement
      // and settlement never need to aggregate llm_broker_requests.
      await getDb().execute(sql`
        WITH request_row AS (
          INSERT INTO llm_broker_requests (
            token_id, session_id, endpoint, model, streamed, upstream_status,
            input_tokens, input_cache_read_tokens, input_cache_write_tokens, output_tokens,
            cost_usd_micros, usage_parsed, latency_ms, raw_usage
          )
          VALUES (
            ${input.tokenId}, ${input.sessionId}, ${input.endpoint}, ${input.model},
            ${input.streamed}, ${input.upstreamStatus},
            ${input.inputTokens}, ${input.inputCacheReadTokens}, ${input.inputCacheWriteTokens},
            ${input.outputTokens}, ${input.costUsdMicros}, ${input.usageParsed},
            ${input.latencyMs}, ${JSON.stringify(input.rawUsage)}::jsonb
          )
          RETURNING token_id
        )
        UPDATE llm_broker_tokens
        SET
          spent_usd_micros = spent_usd_micros + ${input.costUsdMicros},
          request_count = request_count + 1,
          input_tokens = input_tokens + ${input.inputTokens},
          input_cache_read_tokens = input_cache_read_tokens + ${input.inputCacheReadTokens},
          input_cache_write_tokens = input_cache_write_tokens + ${input.inputCacheWriteTokens},
          output_tokens = output_tokens + ${input.outputTokens},
          unparsed_request_count = unparsed_request_count + ${input.usageParsed ? 0 : 1},
          last_used_at = now()
        WHERE id = (SELECT token_id FROM request_row)
      `);
    },

    async revokeToken(tokenId) {
      await getDb().execute(sql`
        UPDATE llm_broker_tokens
        SET revoked_at = now()
        WHERE id = ${tokenId} AND revoked_at IS NULL
      `);
    },

    async revokeTokensForSession(sessionId) {
      const result = await getDb().execute(sql`
        UPDATE llm_broker_tokens
        SET revoked_at = now()
        WHERE session_id = ${sessionId} AND revoked_at IS NULL
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).map((row) => row.id);
    },

    async claimSettlement(tokenId) {
      // The CAS: exactly one caller flips settled_at and receives the totals.
      const result = await getDb().execute(sql`
        UPDATE llm_broker_tokens
        SET settled_at = now()
        WHERE id = ${tokenId} AND settled_at IS NULL
        RETURNING ${TOTALS_COLUMNS}
      `);
      const row = rowsFromExecute<BrokerTokenTotals>(result)[0];
      return row ? normalizeTotals(row) : null;
    },

    async findSettleableTokenIds(limit) {
      // Crash leftovers: revoked-but-unsettled (a finally block died between revoke and
      // settle) or expired-but-unsettled (the runner died mid-delegation). The 5-minute
      // grace past expiry leaves room for an in-flight final request to be metered.
      const result = await getDb().execute(sql`
        SELECT id
        FROM llm_broker_tokens
        WHERE settled_at IS NULL
          AND (revoked_at IS NOT NULL OR expires_at < now() - interval '5 minutes')
        LIMIT ${limit}
      `);
      return rowsFromExecute<{ id: string }>(result).map((row) => row.id);
    },

    async insertSettledToolUsage(input) {
      // Deliberately NOT lease-guarded — see the module comment.
      const result = await getDb().execute(sql`
        INSERT INTO agent_session_tool_usage (
          session_id, message_id, run_lease_id, tool_call_id, tool_name,
          provider, operation, provider_request_id, cost_usd_micros, raw_usage
        )
        VALUES (
          ${input.sessionId}, ${input.messageId}, NULL, ${input.toolCallId}, ${input.toolName},
          ${input.provider}, ${input.operation}, NULL, ${input.costUsdMicros},
          ${JSON.stringify(input.rawUsage)}::jsonb
        )
        RETURNING id
      `);
      const row = rowsFromExecute<{ id: number }>(result)[0];
      if (!row) {
        throw new Error("Failed to insert broker settlement tool usage row.");
      }
      return row;
    },

    async linkSettledToolUsage(tokenId, toolUsageId) {
      await getDb().execute(sql`
        UPDATE llm_broker_tokens
        SET settled_tool_usage_id = ${toolUsageId}
        WHERE id = ${tokenId}
      `);
    },
  };
}

// Raw db.execute skips Drizzle's column mapping, so bigint columns arrive as strings.
function normalizeTotals(row: BrokerTokenTotals): BrokerTokenTotals {
  return {
    ...row,
    spentUsdMicros: Number(row.spentUsdMicros),
    requestCount: Number(row.requestCount),
    inputTokens: Number(row.inputTokens),
    inputCacheReadTokens: Number(row.inputCacheReadTokens),
    inputCacheWriteTokens: Number(row.inputCacheWriteTokens),
    outputTokens: Number(row.outputTokens),
    unparsedRequestCount: Number(row.unparsedRequestCount),
  };
}

export async function mintBrokerToken(
  input: MintBrokerTokenInput,
  store: BrokerTokenStore = createDbBrokerTokenStore(),
): Promise<MintedBrokerToken> {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlMs);
  await store.insertToken({
    id: tokenId,
    tokenHash: hashBrokerToken(token),
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    provider: input.provider,
    budgetUsdMicros: brokerTokenBudgetUsdMicros(input.budgetUsdMicros),
    expiresAt,
  });
  return { tokenId, token, expiresAt };
}

export async function validateBrokerToken(
  rawToken: string,
  store: BrokerTokenStore = createDbBrokerTokenStore(),
): Promise<ValidatedBrokerToken | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  return store.findActiveByHash(hashBrokerToken(rawToken));
}

// Map the delegation's tool to the provider label used in tool-usage breakdowns, matching
// what the tool's own (now display-only) usage rows report.
function settlementProvider(toolName: string): string {
  if (toolName === "memory") return "vercel-ai-gateway";
  if (toolName === "codex_coder") return "codex";
  if (toolName === "opencode_coder") return "opencode";
  return toolName;
}

export type BrokerSettlementResult =
  | { settled: false; reason: "already_settled" }
  | { settled: true; billed: false }
  | { settled: true; billed: true; toolUsageId: number; chargedCostUsdMicros: number };

type SettlementDeps = {
  store: BrokerTokenStore;
  recordDebit: typeof recordWorkspaceUsageDebit;
  appendEvent: typeof appendRuntimeEvent;
  // Lazy so DB-less unit tests can inject everything without a configured database.
  getDbImpl: typeof getDb;
};

export async function settleBrokerToken(
  tokenId: string,
  deps?: Partial<SettlementDeps>,
): Promise<BrokerSettlementResult> {
  const store = deps?.store ?? createDbBrokerTokenStore();
  const recordDebit = deps?.recordDebit ?? recordWorkspaceUsageDebit;
  const appendEvent = deps?.appendEvent ?? appendRuntimeEvent;
  const getDbImpl = deps?.getDbImpl ?? getDb;

  const totals = await store.claimSettlement(tokenId);
  if (!totals) return { settled: false, reason: "already_settled" };

  // A token that never reached the broker (or only made unmetered failed requests)
  // settles as a no-op; the token row remains as the audit trail.
  if (totals.requestCount === 0 && totals.spentUsdMicros === 0) {
    return { settled: true, billed: false };
  }

  const provider = settlementProvider(totals.toolName);
  const operation = "brokered";
  const cost = calculateHostedToolUsageCost({
    provider,
    operation,
    providerCostUsdMicros: totals.spentUsdMicros,
    costSource: "broker_metered",
  });

  const toolUsageRow = await store.insertSettledToolUsage({
    sessionId: totals.sessionId,
    messageId: totals.messageId,
    toolCallId: totals.toolCallId ?? `broker:${totals.id}`,
    toolName: totals.toolName,
    provider,
    operation,
    costUsdMicros: cost.providerCostUsdMicros,
    rawUsage: {
      costSource: "broker_metered",
      brokerTokenId: totals.id,
      brokerProvider: totals.provider,
      requestCount: totals.requestCount,
      unparsedRequestCount: totals.unparsedRequestCount,
      inputTokens: totals.inputTokens,
      inputCacheReadTokens: totals.inputCacheReadTokens,
      inputCacheWriteTokens: totals.inputCacheWriteTokens,
      outputTokens: totals.outputTokens,
    },
  });

  if (cost.billable) {
    await recordDebit({
      db: getDbImpl(),
      sessionId: totals.sessionId,
      messageId: totals.messageId,
      toolUsageId: toolUsageRow.id,
      source: "tool_usage",
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        brokerTokenId: totals.id,
        toolCallId: totals.toolCallId,
        toolName: totals.toolName,
      },
    });
  }

  await store.linkSettledToolUsage(totals.id, toolUsageRow.id);

  // Unconditional (lease-less) append so the session cost UI rolls the brokered cost in.
  // Same payload shape as recordToolUsage's session.tool_usage event.
  await appendEvent(getDbImpl(), {
    sessionId: totals.sessionId,
    messageId: totals.messageId,
    type: "session.tool_usage",
    payload: {
      messageId: totals.messageId ?? "",
      toolCallId: totals.toolCallId ?? `broker:${totals.id}`,
      toolName: totals.toolName,
      provider,
      operation,
      costUsdMicros: cost.providerCostUsdMicros,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      chargedCostUsdMicros: cost.totalCostUsdMicros,
    },
  });

  return {
    settled: true,
    billed: cost.billable,
    toolUsageId: toolUsageRow.id,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
  };
}

// Run one brokered delegation: mint a token for the tool call, hand it to `fn`, and
// always revoke + settle in the finally — success, timeout, abort, and error paths all
// flow through here. Settlement failures are logged, never thrown, so they cannot mask
// the tool's own outcome (the expiry sweeper re-settles leftovers).
export async function withBrokerDelegation<T>(
  input: MintBrokerTokenInput,
  fn: (token: MintedBrokerToken) => Promise<T>,
  deps?: Partial<SettlementDeps>,
): Promise<T> {
  const store = deps?.store ?? createDbBrokerTokenStore();
  const minted = await mintBrokerToken(input, store);
  try {
    return await fn(minted);
  } finally {
    try {
      await store.revokeToken(minted.tokenId);
      await settleBrokerToken(minted.tokenId, { ...deps, store });
    } catch (error) {
      brokerLogger.error("Failed to revoke/settle broker token after delegation", {
        event: "opencompany.llm_broker_settle_failed",
        token_id: minted.tokenId,
        session_id: input.sessionId,
        error,
      });
    }
  }
}

// Revoke + settle every token a session still holds. Called from archiveSession and
// abortSession; safe to race with a tool's own finally block thanks to the CAS.
export async function settleBrokerTokensForSession(
  sessionId: string,
  deps?: Partial<SettlementDeps>,
): Promise<void> {
  const store = deps?.store ?? createDbBrokerTokenStore();
  const tokenIds = await store.revokeTokensForSession(sessionId);
  for (const tokenId of tokenIds) {
    await settleBrokerToken(tokenId, { ...deps, store });
  }
}

// Sweeper hook (piggybacked on the stale-run sweep): settle crash leftovers so a runner
// death mid-delegation never strands metered spend unbilled.
export async function settleExpiredBrokerTokens(
  deps?: Partial<SettlementDeps>,
  limit = 50,
): Promise<number> {
  const store = deps?.store ?? createDbBrokerTokenStore();
  const tokenIds = await store.findSettleableTokenIds(limit);
  let settled = 0;
  for (const tokenId of tokenIds) {
    const result = await settleBrokerToken(tokenId, { ...deps, store });
    if (result.settled) settled += 1;
  }
  return settled;
}

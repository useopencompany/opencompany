import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import { rowsFromExecute } from "./sql-exec";

// Roll a delegated child's (sub)tree usage onto the parent session, emitting only the delta since
// the last emit so resumes / multi-child trees never double-count. This is the non-lease variant
// used by the child-finish hook: by the time a child finishes, no run owns the parent's lease, so
// the event is appended directly. The delta dedup makes concurrent/duplicate emits idempotent.
export async function emitDelegatedUsageRollup(input: {
  parentSessionId: string;
  parentMessageId: string | null;
  childSessionId: string;
  parentToolCallId: string;
}) {
  const rollup = await loadSessionTreeUsageRollup(input.childSessionId);
  if (!hasUsageRollupValue(rollup)) return;
  const alreadyEmitted = await loadEmittedDelegatedUsageRollup({
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
  });
  const delta = subtractSessionTreeUsageRollup(rollup, alreadyEmitted);
  if (!hasUsageRollupValue(delta)) return;

  await appendRuntimeEvent(getDb(), {
    sessionId: input.parentSessionId,
    messageId: input.parentMessageId,
    type: "session.delegated_usage",
    payload: {
      childSessionId: input.childSessionId,
      parentToolCallId: input.parentToolCallId,
      usage: delta.usage,
      toolUsage: delta.toolUsage,
      cost: delta.cost,
    },
  });
}

export type SessionTreeUsageRollup = {
  usage: {
    inputTokens: number;
    inputNoCacheTokens: number;
    inputCacheReadTokens: number;
    inputCacheWriteTokens: number;
    outputTokens: number;
    outputTextTokens: number;
    outputReasoningTokens: number;
    totalTokens: number;
  };
  toolUsage: {
    totalCostUsdMicros: number;
    byProviderOperation: Array<{
      provider: string;
      operation: string;
      costUsdMicros: number;
      calls: number;
    }>;
  };
  cost: {
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    totalCostUsdMicros: number;
    modelCostUsdMicros: number;
    toolCostUsdMicros: number;
    sandboxCostUsdMicros: number;
  };
};

async function loadEmittedDelegatedUsageRollup(input: {
  parentSessionId: string;
  childSessionId: string;
}): Promise<SessionTreeUsageRollup> {
  const result = await getDb().execute(sql`
    SELECT payload AS "payload"
    FROM agent_session_events
    WHERE session_id = ${input.parentSessionId}
      AND type = 'session.delegated_usage'
      AND payload->>'childSessionId' = ${input.childSessionId}
  `);

  return rowsFromExecute<{ payload?: unknown }>(result).reduce(
    (total, row) => addSessionTreeUsageRollup(total, parseDelegatedUsagePayload(row.payload)),
    emptySessionTreeUsageRollup(),
  );
}

function parseDelegatedUsagePayload(value: unknown): SessionTreeUsageRollup {
  const payload = readJsonObject(value);
  const usage = readJsonObject(payload.usage);
  const toolUsage = readJsonObject(payload.toolUsage);
  const cost = readJsonObject(payload.cost);
  return {
    usage: {
      inputTokens: readNumber(usage.inputTokens),
      inputNoCacheTokens: readNumber(usage.inputNoCacheTokens),
      inputCacheReadTokens: readNumber(usage.inputCacheReadTokens),
      inputCacheWriteTokens: readNumber(usage.inputCacheWriteTokens),
      outputTokens: readNumber(usage.outputTokens),
      outputTextTokens: readNumber(usage.outputTextTokens),
      outputReasoningTokens: readNumber(usage.outputReasoningTokens),
      totalTokens: readNumber(usage.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: readNumber(toolUsage.totalCostUsdMicros),
      byProviderOperation: readToolUsageOperations(toolUsage.byProviderOperation),
    },
    cost: {
      providerCostUsdMicros: readNumber(cost.providerCostUsdMicros),
      platformFeeUsdMicros: readNumber(cost.platformFeeUsdMicros),
      totalCostUsdMicros: readNumber(cost.totalCostUsdMicros),
      modelCostUsdMicros: readNumber(cost.modelCostUsdMicros),
      toolCostUsdMicros: readNumber(cost.toolCostUsdMicros),
      sandboxCostUsdMicros: readNumber(cost.sandboxCostUsdMicros),
    },
  };
}

function emptySessionTreeUsageRollup(): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      outputTextTokens: 0,
      outputReasoningTokens: 0,
      totalTokens: 0,
    },
    toolUsage: {
      totalCostUsdMicros: 0,
      byProviderOperation: [],
    },
    cost: {
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
      sandboxCostUsdMicros: 0,
    },
  };
}

function addSessionTreeUsageRollup(
  left: SessionTreeUsageRollup,
  right: SessionTreeUsageRollup,
): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: left.usage.inputTokens + right.usage.inputTokens,
      inputNoCacheTokens: left.usage.inputNoCacheTokens + right.usage.inputNoCacheTokens,
      inputCacheReadTokens: left.usage.inputCacheReadTokens + right.usage.inputCacheReadTokens,
      inputCacheWriteTokens: left.usage.inputCacheWriteTokens + right.usage.inputCacheWriteTokens,
      outputTokens: left.usage.outputTokens + right.usage.outputTokens,
      outputTextTokens: left.usage.outputTextTokens + right.usage.outputTextTokens,
      outputReasoningTokens: left.usage.outputReasoningTokens + right.usage.outputReasoningTokens,
      totalTokens: left.usage.totalTokens + right.usage.totalTokens,
    },
    toolUsage: {
      totalCostUsdMicros: left.toolUsage.totalCostUsdMicros + right.toolUsage.totalCostUsdMicros,
      byProviderOperation: addToolUsageOperations(
        left.toolUsage.byProviderOperation,
        right.toolUsage.byProviderOperation,
      ),
    },
    cost: {
      providerCostUsdMicros: left.cost.providerCostUsdMicros + right.cost.providerCostUsdMicros,
      platformFeeUsdMicros: left.cost.platformFeeUsdMicros + right.cost.platformFeeUsdMicros,
      totalCostUsdMicros: left.cost.totalCostUsdMicros + right.cost.totalCostUsdMicros,
      modelCostUsdMicros: left.cost.modelCostUsdMicros + right.cost.modelCostUsdMicros,
      toolCostUsdMicros: left.cost.toolCostUsdMicros + right.cost.toolCostUsdMicros,
      sandboxCostUsdMicros: left.cost.sandboxCostUsdMicros + right.cost.sandboxCostUsdMicros,
    },
  };
}

function subtractSessionTreeUsageRollup(
  total: SessionTreeUsageRollup,
  emitted: SessionTreeUsageRollup,
): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: subtractMetric(total.usage.inputTokens, emitted.usage.inputTokens),
      inputNoCacheTokens: subtractMetric(
        total.usage.inputNoCacheTokens,
        emitted.usage.inputNoCacheTokens,
      ),
      inputCacheReadTokens: subtractMetric(
        total.usage.inputCacheReadTokens,
        emitted.usage.inputCacheReadTokens,
      ),
      inputCacheWriteTokens: subtractMetric(
        total.usage.inputCacheWriteTokens,
        emitted.usage.inputCacheWriteTokens,
      ),
      outputTokens: subtractMetric(total.usage.outputTokens, emitted.usage.outputTokens),
      outputTextTokens: subtractMetric(
        total.usage.outputTextTokens,
        emitted.usage.outputTextTokens,
      ),
      outputReasoningTokens: subtractMetric(
        total.usage.outputReasoningTokens,
        emitted.usage.outputReasoningTokens,
      ),
      totalTokens: subtractMetric(total.usage.totalTokens, emitted.usage.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: subtractMetric(
        total.toolUsage.totalCostUsdMicros,
        emitted.toolUsage.totalCostUsdMicros,
      ),
      byProviderOperation: subtractToolUsageOperations(
        total.toolUsage.byProviderOperation,
        emitted.toolUsage.byProviderOperation,
      ),
    },
    cost: {
      providerCostUsdMicros: subtractMetric(
        total.cost.providerCostUsdMicros,
        emitted.cost.providerCostUsdMicros,
      ),
      platformFeeUsdMicros: subtractMetric(
        total.cost.platformFeeUsdMicros,
        emitted.cost.platformFeeUsdMicros,
      ),
      totalCostUsdMicros: subtractMetric(
        total.cost.totalCostUsdMicros,
        emitted.cost.totalCostUsdMicros,
      ),
      modelCostUsdMicros: subtractMetric(
        total.cost.modelCostUsdMicros,
        emitted.cost.modelCostUsdMicros,
      ),
      toolCostUsdMicros: subtractMetric(
        total.cost.toolCostUsdMicros,
        emitted.cost.toolCostUsdMicros,
      ),
      sandboxCostUsdMicros: subtractMetric(
        total.cost.sandboxCostUsdMicros,
        emitted.cost.sandboxCostUsdMicros,
      ),
    },
  };
}

function addToolUsageOperations(
  left: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
  right: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
) {
  const byKey = new Map<string, (typeof left)[number]>();
  for (const row of [...left, ...right]) {
    const key = `${row.provider}:${row.operation}`;
    const current = byKey.get(key) ?? {
      provider: row.provider,
      operation: row.operation,
      costUsdMicros: 0,
      calls: 0,
    };
    current.costUsdMicros += row.costUsdMicros;
    current.calls += row.calls;
    byKey.set(key, current);
  }
  return Array.from(byKey.values()).sort((leftRow, rightRow) =>
    `${leftRow.provider}:${leftRow.operation}`.localeCompare(
      `${rightRow.provider}:${rightRow.operation}`,
    ),
  );
}

function subtractToolUsageOperations(
  total: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
  emitted: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
) {
  const emittedByKey = new Map(
    emitted.map((row) => [`${row.provider}:${row.operation}`, row] as const),
  );
  return total
    .map((row) => {
      const emittedRow = emittedByKey.get(`${row.provider}:${row.operation}`);
      return {
        provider: row.provider,
        operation: row.operation,
        costUsdMicros: subtractMetric(row.costUsdMicros, emittedRow?.costUsdMicros ?? 0),
        calls: subtractMetric(row.calls, emittedRow?.calls ?? 0),
      };
    })
    .filter((row) => row.costUsdMicros > 0 || row.calls > 0);
}

function subtractMetric(total: number, emitted: number) {
  return Math.max(total - emitted, 0);
}

async function loadSessionTreeUsageRollup(sessionId: string): Promise<SessionTreeUsageRollup> {
  const result = await getDb().execute(sql`
    WITH RECURSIVE session_tree(id, path) AS (
      SELECT id, ARRAY[id]::text[]
      FROM agent_sessions
      WHERE id = ${sessionId}
      UNION ALL
      SELECT child.id, session_tree.path || child.id
      FROM agent_sessions child
      INNER JOIN session_tree ON child.parent_session_id = session_tree.id
      WHERE NOT child.id = ANY(session_tree.path)
    ),
    usage_totals AS (
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(input_no_cache_tokens), 0) AS input_no_cache_tokens,
        COALESCE(SUM(input_cache_read_tokens), 0) AS input_cache_read_tokens,
        COALESCE(SUM(input_cache_write_tokens), 0) AS input_cache_write_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(output_text_tokens), 0) AS output_text_tokens,
        COALESCE(SUM(output_reasoning_tokens), 0) AS output_reasoning_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM agent_session_usage
      WHERE session_id IN (SELECT id FROM session_tree)
    ),
    cost_totals AS (
      SELECT
        COALESCE(SUM(provider_cost_usd_micros), 0) AS provider_cost_usd_micros,
        COALESCE(SUM(platform_fee_usd_micros), 0) AS platform_fee_usd_micros,
        COALESCE(SUM(-amount_usd_micros), 0) AS total_cost_usd_micros,
        COALESCE(SUM(-amount_usd_micros) FILTER (WHERE source = 'model_usage'), 0) AS model_cost_usd_micros,
        COALESCE(SUM(-amount_usd_micros) FILTER (WHERE source = 'tool_usage'), 0) AS tool_cost_usd_micros,
        COALESCE(SUM(-amount_usd_micros) FILTER (WHERE source = 'sandbox_usage'), 0) AS sandbox_cost_usd_micros
      FROM workspace_credit_ledger
      WHERE session_id IN (SELECT id FROM session_tree)
        AND amount_usd_micros < 0
    ),
    tool_usage_rows AS (
      SELECT
        provider,
        operation,
        COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
        COUNT(*)::int AS calls
      FROM agent_session_tool_usage
      WHERE session_id IN (SELECT id FROM session_tree)
      GROUP BY provider, operation
    ),
    tool_totals AS (
      SELECT
        COALESCE(SUM(cost_usd_micros), 0) AS tool_usage_cost_usd_micros,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'provider', provider,
              'operation', operation,
              'costUsdMicros', cost_usd_micros,
              'calls', calls
            )
            ORDER BY provider, operation
          ),
          '[]'::jsonb
        ) AS tool_usage_by_provider_operation
      FROM tool_usage_rows
    )
    SELECT
      usage_totals.input_tokens AS "inputTokens",
      usage_totals.input_no_cache_tokens AS "inputNoCacheTokens",
      usage_totals.input_cache_read_tokens AS "inputCacheReadTokens",
      usage_totals.input_cache_write_tokens AS "inputCacheWriteTokens",
      usage_totals.output_tokens AS "outputTokens",
      usage_totals.output_text_tokens AS "outputTextTokens",
      usage_totals.output_reasoning_tokens AS "outputReasoningTokens",
      usage_totals.total_tokens AS "totalTokens",
      cost_totals.provider_cost_usd_micros AS "providerCostUsdMicros",
      cost_totals.platform_fee_usd_micros AS "platformFeeUsdMicros",
      cost_totals.total_cost_usd_micros AS "totalCostUsdMicros",
      cost_totals.model_cost_usd_micros AS "modelCostUsdMicros",
      cost_totals.tool_cost_usd_micros AS "toolCostUsdMicros",
      cost_totals.sandbox_cost_usd_micros AS "sandboxCostUsdMicros",
      tool_totals.tool_usage_cost_usd_micros AS "toolUsageTotalCostUsdMicros",
      tool_totals.tool_usage_by_provider_operation AS "toolUsageByProviderOperation"
    FROM usage_totals
    CROSS JOIN cost_totals
    CROSS JOIN tool_totals
  `);

  const row = rowsFromExecute<Record<string, unknown>>(result)[0] ?? {};
  return parseSessionTreeUsageRollup(row);
}

function parseSessionTreeUsageRollup(row: Record<string, unknown>): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: readNumber(row.inputTokens),
      inputNoCacheTokens: readNumber(row.inputNoCacheTokens),
      inputCacheReadTokens: readNumber(row.inputCacheReadTokens),
      inputCacheWriteTokens: readNumber(row.inputCacheWriteTokens),
      outputTokens: readNumber(row.outputTokens),
      outputTextTokens: readNumber(row.outputTextTokens),
      outputReasoningTokens: readNumber(row.outputReasoningTokens),
      totalTokens: readNumber(row.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: readNumber(row.toolUsageTotalCostUsdMicros),
      byProviderOperation: readToolUsageOperations(row.toolUsageByProviderOperation),
    },
    cost: {
      providerCostUsdMicros: readNumber(row.providerCostUsdMicros),
      platformFeeUsdMicros: readNumber(row.platformFeeUsdMicros),
      totalCostUsdMicros: readNumber(row.totalCostUsdMicros),
      modelCostUsdMicros: readNumber(row.modelCostUsdMicros),
      toolCostUsdMicros: readNumber(row.toolCostUsdMicros),
      sandboxCostUsdMicros: readNumber(row.sandboxCostUsdMicros),
    },
  };
}

function hasUsageRollupValue(rollup: SessionTreeUsageRollup) {
  return (
    rollup.usage.totalTokens > 0 ||
    rollup.cost.totalCostUsdMicros > 0 ||
    rollup.toolUsage.byProviderOperation.length > 0
  );
}

function readToolUsageOperations(value: unknown) {
  return readJsonArray(value)
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      provider: typeof row.provider === "string" ? row.provider : "",
      operation: typeof row.operation === "string" ? row.operation : "",
      costUsdMicros: readNumber(row.costUsdMicros),
      calls: readNumber(row.calls),
    }))
    .filter((row) => row.provider && row.operation);
}

function readJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

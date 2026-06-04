import { createSessionStreamToken } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionUsage,
  agents,
  sessionStars,
} from "@opencompany/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  type AgentSessionDetailPayload,
  isSidebarSessionActive,
  type SessionStreamCredentialPayload,
  type SidebarSessionPayload,
  serializeAgentSessionDetail,
  serializeSidebarSession,
} from "@/lib/agent-sessions/payload";
import { getRunnerPublicUrl, getRunnerStreamTokenSecret } from "@/lib/agent-sessions/runner";
import { computeThinkingDurationSeconds } from "@/lib/agent-sessions/runtime-events";

const SIDEBAR_RECENCY_LIMIT = 50;

export async function loadSidebarSessionsForWorkspace(
  userId: string,
  workspaceId: string,
): Promise<SidebarSessionPayload[]> {
  const db = getDb();

  const baseColumns = {
    id: agentSessions.id,
    title: agentSessions.title,
    status: agentSessions.status,
    modelName: agentSessions.modelName,
    lastError: agentSessions.lastError,
    createdAt: agentSessions.createdAt,
    updatedAt: agentSessions.updatedAt,
    starredAt: sessionStars.starredAt,
  };

  const visibilityFilter = and(
    eq(agentSessions.workspaceId, workspaceId),
    eq(agentSessions.userId, userId),
    eq(agentSessions.source, "user"),
    isNull(agentSessions.archivedAt),
  );

  // Star state is per user; join only the current user's star rows.
  const starJoin = and(
    eq(sessionStars.sessionId, agentSessions.id),
    eq(sessionStars.userId, userId),
  );

  // The recency window is capped, so a starred-but-stale session can fall
  // outside it. Fetch starred sessions explicitly and union them in so a pinned
  // session always renders regardless of how far down the recency list it sits.
  const [recent, starred] = await Promise.all([
    db
      .select(baseColumns)
      .from(agentSessions)
      .leftJoin(sessionStars, starJoin)
      .where(visibilityFilter)
      .orderBy(desc(agentSessions.updatedAt))
      .limit(SIDEBAR_RECENCY_LIMIT),
    db
      .select(baseColumns)
      .from(agentSessions)
      .innerJoin(sessionStars, starJoin)
      .where(and(visibilityFilter, isNotNull(sessionStars.starredAt)))
      .orderBy(desc(agentSessions.updatedAt)),
  ]);

  const byId = new Map<string, (typeof recent)[number]>();
  for (const row of recent) byId.set(row.id, row);
  for (const row of starred) byId.set(row.id, row);

  // The persisted session status is unreliable for the "is it working now?"
  // question (it can lag or get stuck), so the green dot is driven by whether a
  // session still has a streaming assistant message. Look that up for the
  // visible set and union it with the running/provisioning statuses.
  const sessionIds = Array.from(byId.keys());
  const runningAssistantRows = sessionIds.length
    ? await db
        .select({ sessionId: agentSessionMessages.sessionId })
        .from(agentSessionMessages)
        .where(
          and(
            inArray(agentSessionMessages.sessionId, sessionIds),
            eq(agentSessionMessages.role, "assistant"),
            eq(agentSessionMessages.status, "running"),
          ),
        )
    : [];
  const activeSessionIds = new Set(runningAssistantRows.map((row) => row.sessionId));

  return Array.from(byId.values())
    .toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .map((row) =>
      serializeSidebarSession({
        ...row,
        active: isSidebarSessionActive(
          row.status,
          activeSessionIds.has(row.id),
          row.lastError !== null,
        ),
      }),
    );
}

export async function loadAgentSessionDetailForWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string,
): Promise<AgentSessionDetailPayload | null> {
  const db = getDb();
  const [session] = await db
    .select({
      id: agentSessions.id,
      agentId: agents.id,
      agentName: agents.name,
      agentPath: agents.path,
      title: agentSessions.title,
      status: agentSessions.status,
      source: agentSessions.source,
      modelProvider: agentSessions.modelProvider,
      modelName: agentSessions.modelName,
      parentSessionId: agentSessions.parentSessionId,
      parentMessageId: agentSessions.parentMessageId,
      parentToolCallId: agentSessions.parentToolCallId,
      e2bSandboxId: agentSessions.e2bSandboxId,
      workdir: agentSessions.workdir,
      runLeaseId: agentSessions.runLeaseId,
      abortRequestedAt: agentSessions.abortRequestedAt,
      lastError: agentSessions.lastError,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) return null;

  const [parentRows, children, messages, events, usageRows, rollupRows] = await Promise.all([
    session.parentSessionId
      ? db
          .select({
            id: agentSessions.id,
            title: agentSessions.title,
            status: agentSessions.status,
            agentName: agents.name,
            agentPath: agents.path,
            parentMessageId: agentSessions.parentMessageId,
            parentToolCallId: agentSessions.parentToolCallId,
            createdAt: agentSessions.createdAt,
            updatedAt: agentSessions.updatedAt,
          })
          .from(agentSessions)
          .innerJoin(agents, eq(agentSessions.agentId, agents.id))
          .where(
            and(
              eq(agentSessions.id, session.parentSessionId),
              eq(agentSessions.workspaceId, workspaceId),
              eq(agentSessions.userId, userId),
              isNull(agentSessions.archivedAt),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    db
      .select({
        id: agentSessions.id,
        title: agentSessions.title,
        status: agentSessions.status,
        agentName: agents.name,
        agentPath: agents.path,
        parentMessageId: agentSessions.parentMessageId,
        parentToolCallId: agentSessions.parentToolCallId,
        createdAt: agentSessions.createdAt,
        updatedAt: agentSessions.updatedAt,
      })
      .from(agentSessions)
      .innerJoin(agents, eq(agentSessions.agentId, agents.id))
      .where(
        and(
          eq(agentSessions.parentSessionId, sessionId),
          eq(agentSessions.workspaceId, workspaceId),
          eq(agentSessions.userId, userId),
          eq(agentSessions.source, "agent"),
          isNull(agentSessions.archivedAt),
        ),
      )
      .orderBy(desc(agentSessions.updatedAt))
      .limit(25),
    db
      .select()
      .from(agentSessionMessages)
      .where(eq(agentSessionMessages.sessionId, sessionId))
      .orderBy(asc(agentSessionMessages.createdAt)),
    db
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, sessionId))
      .orderBy(asc(agentSessionEvents.id))
      .limit(300),
    db
      .select({
        messageId: agentSessionUsage.messageId,
        inputTokens: agentSessionUsage.inputTokens,
        inputNoCacheTokens: agentSessionUsage.inputNoCacheTokens,
        inputCacheReadTokens: agentSessionUsage.inputCacheReadTokens,
        inputCacheWriteTokens: agentSessionUsage.inputCacheWriteTokens,
        outputTokens: agentSessionUsage.outputTokens,
        outputTextTokens: agentSessionUsage.outputTextTokens,
        outputReasoningTokens: agentSessionUsage.outputReasoningTokens,
        totalTokens: agentSessionUsage.totalTokens,
      })
      .from(agentSessionUsage)
      .where(eq(agentSessionUsage.sessionId, sessionId)),
    db.execute(sql`
      WITH RECURSIVE session_tree(id, path) AS (
        SELECT id, ARRAY[id]::text[]
        FROM agent_sessions
        WHERE id = ${sessionId}
          AND workspace_id = ${workspaceId}
          AND user_id = ${userId}
          AND archived_at IS NULL
        UNION ALL
        SELECT child.id, session_tree.path || child.id
        FROM agent_sessions child
        INNER JOIN session_tree ON child.parent_session_id = session_tree.id
        WHERE child.workspace_id = ${workspaceId}
          AND child.user_id = ${userId}
          AND child.archived_at IS NULL
          AND NOT child.id = ANY(session_tree.path)
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
    `),
  ]);
  const rollup = parseSessionTreeRollup(rowsFromExecute<Record<string, unknown>>(rollupRows)[0]);
  const usage = rollup.usage;
  const usageByMessageId = new Map<string, { outputReasoningTokens: number }>();
  for (const row of usageRows) {
    if (!row.messageId) continue;
    const current = usageByMessageId.get(row.messageId) ?? { outputReasoningTokens: 0 };
    current.outputReasoningTokens += row.outputReasoningTokens;
    usageByMessageId.set(row.messageId, current);
  }
  const eventsWithCreatedAt = events.map((event) => ({
    ...event,
    createdAt: event.createdAt.toISOString(),
  }));
  const messagesWithUsage = messages.map((message) => {
    const outputReasoningTokens = usageByMessageId.get(message.id)?.outputReasoningTokens ?? 0;
    const sessionMessage = {
      ...message,
      outputReasoningTokens,
      createdAt: message.createdAt.toISOString(),
      completedAt: message.completedAt?.toISOString() ?? null,
    };
    return {
      ...message,
      outputReasoningTokens,
      thinkingDurationSeconds: computeThinkingDurationSeconds(sessionMessage, eventsWithCreatedAt),
    };
  });
  const toolUsage = rollup.toolUsage;
  const cost = rollup.cost;
  const runnerUrl = getRunnerPublicUrl();
  const serializedSession = {
    ...session,
    source: session.source === "agent" ? ("agent" as const) : ("user" as const),
  };

  return serializeAgentSessionDetail({
    session: serializedSession,
    related: {
      parent: parentRows[0] ?? null,
      children,
    },
    messages: messagesWithUsage,
    events: eventsWithCreatedAt,
    usage,
    toolUsage,
    cost,
    runnerUrl,
  });
}

export async function loadAgentSessionStreamCredentialForWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string,
): Promise<SessionStreamCredentialPayload | null> {
  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) return null;

  const runnerUrl = getRunnerPublicUrl();
  const streamTokenSecret = getRunnerStreamTokenSecret();
  const streamTokenExpiresAt = Date.now() + 60 * 60 * 1000;
  const streamToken =
    runnerUrl && streamTokenSecret
      ? createSessionStreamToken(
          {
            sessionId,
            userId,
            expiresAt: streamTokenExpiresAt,
          },
          streamTokenSecret,
        )
      : null;

  return {
    runnerUrl,
    streamToken,
    streamTokenExpiresAt: streamToken ? streamTokenExpiresAt : null,
  };
}

function parseSessionTreeRollup(row: Record<string, unknown> | undefined) {
  return {
    usage: {
      inputTokens: readNumber(row?.inputTokens),
      inputNoCacheTokens: readNumber(row?.inputNoCacheTokens),
      inputCacheReadTokens: readNumber(row?.inputCacheReadTokens),
      inputCacheWriteTokens: readNumber(row?.inputCacheWriteTokens),
      outputTokens: readNumber(row?.outputTokens),
      outputTextTokens: readNumber(row?.outputTextTokens),
      outputReasoningTokens: readNumber(row?.outputReasoningTokens),
      totalTokens: readNumber(row?.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: readNumber(row?.toolUsageTotalCostUsdMicros),
      byProviderOperation: readToolUsageOperations(row?.toolUsageByProviderOperation),
    },
    cost: {
      providerCostUsdMicros: readNumber(row?.providerCostUsdMicros),
      platformFeeUsdMicros: readNumber(row?.platformFeeUsdMicros),
      totalCostUsdMicros: readNumber(row?.totalCostUsdMicros),
      modelCostUsdMicros: readNumber(row?.modelCostUsdMicros),
      toolCostUsdMicros: readNumber(row?.toolCostUsdMicros),
      sandboxCostUsdMicros: readNumber(row?.sandboxCostUsdMicros),
    },
  };
}

function readToolUsageOperations(value: unknown) {
  const rows = readJsonArray(value);
  return rows
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

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

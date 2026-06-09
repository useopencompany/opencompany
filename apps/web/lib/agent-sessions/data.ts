import { getDb } from "@opencompany/db/client";
import {
  agentSessionEvents,
  agentSessionMessageAttachments,
  agentSessionMessages,
  agentSessions,
  agentSessionUsage,
  agents,
  sessionStars,
} from "@opencompany/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  type AgentSessionDetailPayload,
  type SidebarSessionPayload,
  serializeAgentSessionDetail,
  serializeSidebarSession,
} from "@/lib/agent-sessions/payload";
import {
  computeThinkingDurationSeconds,
  type SessionCostSummary,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";

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
    source: agentSessions.source,
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

  return Array.from(byId.values())
    .toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .map(serializeSidebarSession);
}

// Personal sessions are the user's sessions against their private default agent. Same
// shape as the sidebar list, but scoped to a single agent and without star state (the
// /personal experiment has no pinning yet). Ordered most-recently-updated first so the
// sidebar can group them by recency the same way the main app does.
export async function loadPersonalSessionsForAgent(
  userId: string,
  workspaceId: string,
  agentId: string,
): Promise<SidebarSessionPayload[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: agentSessions.id,
      title: agentSessions.title,
      status: agentSessions.status,
      source: agentSessions.source,
      modelName: agentSessions.modelName,
      lastError: agentSessions.lastError,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentId, agentId),
        // Unified personal list: web-originated AND WhatsApp-originated threads (not delegated).
        inArray(agentSessions.source, ["user", "whatsapp"]),
        isNull(agentSessions.archivedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(SIDEBAR_RECENCY_LIMIT);

  return rows.map((row) => serializeSidebarSession({ ...row, starredAt: null }));
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

  const [
    parentRows,
    children,
    messages,
    events,
    usageRows,
    rollupRows,
    latestModelRequestRows,
    latestUsageRows,
  ] = await Promise.all([
    session.parentSessionId
      ? db
          .select({
            id: agentSessions.id,
            title: agentSessions.title,
            status: agentSessions.status,
            source: agentSessions.source,
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
        source: agentSessions.source,
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
          // Both delegated children ("agent") and memory-keeper passes ("memory") are grouped
          // under their parent; the live session list filters to source "user" so neither clutters it.
          inArray(agentSessions.source, ["agent", "memory"]),
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
      // Exclude the per-turn `debug.model_request` snapshots from the windowed event list: they are
      // large, hidden from the inspector, and would otherwise consume the 300-row budget (and ship
      // to the browser repeatedly). The latest one is fetched separately below.
      .where(
        and(
          eq(agentSessionEvents.sessionId, sessionId),
          ne(agentSessionEvents.type, "debug.model_request"),
        ),
      )
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
    // The single most-recent model-request debug snapshot. Surfaced as a top-level detail field
    // (not via the windowed `events` above) so the "Copy Debug JSON" export still finds it on long
    // sessions whose latest turn falls outside the 300-event window.
    db
      .select({ payload: agentSessionEvents.payload })
      .from(agentSessionEvents)
      .where(
        and(
          eq(agentSessionEvents.sessionId, sessionId),
          eq(agentSessionEvents.type, "debug.model_request"),
        ),
      )
      .orderBy(desc(agentSessionEvents.id))
      .limit(1),
    // The most recent model step for THIS session only (not the recursive tree). Its
    // input + output tokens approximate how full the model's context window currently is —
    // the prompt just sent plus what was generated and carried into the next turn. This is the
    // "context now" figure, distinct from the cumulative `usage` rollup which only grows.
    db
      .select({
        inputTokens: agentSessionUsage.inputTokens,
        outputTokens: agentSessionUsage.outputTokens,
      })
      .from(agentSessionUsage)
      .where(eq(agentSessionUsage.sessionId, sessionId))
      .orderBy(desc(agentSessionUsage.createdAt))
      .limit(1),
  ]);
  const rollup = parseSessionTreeRollup(rowsFromExecute<Record<string, unknown>>(rollupRows)[0]);
  const usage = rollup.usage;
  const latestUsage = latestUsageRows[0];
  const currentContextTokens = latestUsage ? latestUsage.inputTokens + latestUsage.outputTokens : 0;
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
  // Batch-load attachment metadata for these messages (only user messages can carry
  // attachments, but we key by id so the join is a single query). Only the 4 client-safe
  // fields are projected — blobUrl/blobPathname/sizeBytes never reach the browser; the UI
  // fetches the bytes through /api/attachments/[id].
  const messageIds = messages.map((message) => message.id);
  const attachmentRows =
    messageIds.length > 0
      ? await db
          .select({
            id: agentSessionMessageAttachments.id,
            messageId: agentSessionMessageAttachments.messageId,
            kind: agentSessionMessageAttachments.kind,
            mediaType: agentSessionMessageAttachments.mediaType,
            filename: agentSessionMessageAttachments.filename,
          })
          .from(agentSessionMessageAttachments)
          .where(inArray(agentSessionMessageAttachments.messageId, messageIds))
      : [];
  const attachmentsByMessageId = new Map<
    string,
    Array<{ id: string; kind: "image" | "pdf" | "text"; mediaType: string; filename: string }>
  >();
  for (const row of attachmentRows) {
    const attachment = {
      id: row.id,
      kind: row.kind,
      mediaType: row.mediaType,
      filename: row.filename,
    };
    const existing = attachmentsByMessageId.get(row.messageId);
    if (existing) {
      existing.push(attachment);
    } else {
      attachmentsByMessageId.set(row.messageId, [attachment]);
    }
  }
  const messagesWithUsage = messages.map((message) => {
    const outputReasoningTokens = usageByMessageId.get(message.id)?.outputReasoningTokens ?? 0;
    const sessionMessage = {
      ...message,
      outputReasoningTokens,
      createdAt: message.createdAt.toISOString(),
      completedAt: message.completedAt?.toISOString() ?? null,
    };
    const attachments = attachmentsByMessageId.get(message.id);
    return {
      ...message,
      outputReasoningTokens,
      thinkingDurationSeconds: computeThinkingDurationSeconds(sessionMessage, eventsWithCreatedAt),
      ...(attachments ? { attachments } : {}),
    };
  });
  const toolUsage = rollup.toolUsage;
  const cost = rollup.cost;
  const serializedSession = {
    ...session,
    source:
      session.source === "agent"
        ? ("agent" as const)
        : session.source === "memory"
          ? ("memory" as const)
          : session.source === "whatsapp"
            ? ("whatsapp" as const)
            : ("user" as const),
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
    currentContextTokens,
    latestModelRequest: latestModelRequestRows[0]?.payload ?? null,
  });
}

type CreatedSessionRow = typeof agentSessions.$inferSelect;
type CreatedMessageRow = typeof agentSessionMessages.$inferSelect;
type CreatedEventRow = {
  id: number;
  type: string;
  messageId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
};

const EMPTY_USAGE: SessionUsageSummary = {
  inputTokens: 0,
  inputNoCacheTokens: 0,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
  outputTokens: 0,
  outputTextTokens: 0,
  outputReasoningTokens: 0,
  totalTokens: 0,
};

const EMPTY_TOOL_USAGE: SessionToolUsageSummary = {
  totalCostUsdMicros: 0,
  byProviderOperation: [],
};

const EMPTY_COST: SessionCostSummary = {
  providerCostUsdMicros: 0,
  platformFeeUsdMicros: 0,
  totalCostUsdMicros: 0,
  modelCostUsdMicros: 0,
  toolCostUsdMicros: 0,
  sandboxCostUsdMicros: 0,
};

// Synthesize the detail payload for a freshly created session from the rows we just
// wrote, instead of re-querying it via loadAgentSessionDetailForWorkspace (an initial
// join plus six aggregate queries). A brand-new session has no children, no usage, no
// cost, and exactly the messages/events created here — so every aggregate is a known
// zero. This keeps the create-session server actions off the slow read path; the
// detail query still refetches the canonical aggregates on the next turn completion.
export function buildCreatedSessionDetail(input: {
  agent: { name: string; path: string | null };
  session: CreatedSessionRow;
  messages: CreatedMessageRow[];
  events: CreatedEventRow[];
}): AgentSessionDetailPayload {
  return serializeAgentSessionDetail({
    session: {
      id: input.session.id,
      agentId: input.session.agentId,
      agentName: input.agent.name,
      agentPath: input.agent.path,
      title: input.session.title,
      status: input.session.status,
      source: input.session.source,
      modelProvider: input.session.modelProvider,
      modelName: input.session.modelName,
      parentSessionId: input.session.parentSessionId,
      parentMessageId: input.session.parentMessageId,
      parentToolCallId: input.session.parentToolCallId,
      e2bSandboxId: input.session.e2bSandboxId,
      workdir: input.session.workdir,
      runLeaseId: input.session.runLeaseId,
      abortRequestedAt: input.session.abortRequestedAt,
      lastError: input.session.lastError,
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
    },
    related: { parent: null, children: [] },
    messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      internal: message.internal,
      modelMessage: message.modelMessage ?? null,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      responseToMessageId: message.responseToMessageId,
      // A just-created session has no model usage yet, and a user message never has
      // reasoning, so both are zero until the runner streams the assistant turn.
      outputReasoningTokens: 0,
      thinkingDurationSeconds: 0,
      createdAt: message.createdAt,
      completedAt: message.completedAt,
    })),
    events: input.events.map((event) => ({
      id: event.id,
      type: event.type,
      messageId: event.messageId,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
    usage: EMPTY_USAGE,
    toolUsage: EMPTY_TOOL_USAGE,
    cost: EMPTY_COST,
    // A just-created session has no model steps yet, so the context window is empty.
    currentContextTokens: 0,
  });
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

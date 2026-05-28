import { createSessionStreamToken } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionToolUsage,
  agentSessionUsage,
  agents,
  users,
  workspaceCreditLedger,
} from "@opencompany/db/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  type AgentSessionDetailPayload,
  type SessionStreamCredentialPayload,
  type SidebarSessionPayload,
  serializeAgentSessionDetail,
  serializeSidebarSession,
} from "@/lib/agent-sessions/payload";
import { getRunnerPublicUrl, getRunnerStreamTokenSecret } from "@/lib/agent-sessions/runner";

export async function loadSidebarSessionsForWorkspace(
  userId: string,
  workspaceId: string,
): Promise<SidebarSessionPayload[]> {
  const db = getDb();
  const sessions = await db
    .select({
      id: agentSessions.id,
      title: agentSessions.title,
      status: agentSessions.status,
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
        isNull(agentSessions.archivedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(50);

  return sessions.map(serializeSidebarSession);
}

export async function loadAgentSessionDetailForWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string,
  canViewWorkspaceSessions = false,
): Promise<AgentSessionDetailPayload | null> {
  const db = getDb();
  const [session] = await db
    .select({
      id: agentSessions.id,
      userId: agentSessions.userId,
      agentId: agents.id,
      agentName: agents.name,
      agentPath: agents.path,
      title: agentSessions.title,
      status: agentSessions.status,
      modelProvider: agentSessions.modelProvider,
      modelName: agentSessions.modelName,
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
        canViewWorkspaceSessions ? undefined : eq(agentSessions.userId, userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) return null;

  const [messages, events, usageRows, toolUsageRows, costRows] = await Promise.all([
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
    db
      .select({
        provider: agentSessionToolUsage.provider,
        operation: agentSessionToolUsage.operation,
        costUsdMicros: agentSessionToolUsage.costUsdMicros,
      })
      .from(agentSessionToolUsage)
      .where(eq(agentSessionToolUsage.sessionId, sessionId)),
    db
      .select({
        source: workspaceCreditLedger.source,
        amountUsdMicros: workspaceCreditLedger.amountUsdMicros,
        providerCostUsdMicros: workspaceCreditLedger.providerCostUsdMicros,
        platformFeeUsdMicros: workspaceCreditLedger.platformFeeUsdMicros,
      })
      .from(workspaceCreditLedger)
      .where(eq(workspaceCreditLedger.sessionId, sessionId)),
  ]);
  const usage = usageRows.reduce(
    (totals, row) => ({
      inputTokens: totals.inputTokens + row.inputTokens,
      inputNoCacheTokens: totals.inputNoCacheTokens + row.inputNoCacheTokens,
      inputCacheReadTokens: totals.inputCacheReadTokens + row.inputCacheReadTokens,
      inputCacheWriteTokens: totals.inputCacheWriteTokens + row.inputCacheWriteTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
      outputTextTokens: totals.outputTextTokens + row.outputTextTokens,
      outputReasoningTokens: totals.outputReasoningTokens + row.outputReasoningTokens,
      totalTokens: totals.totalTokens + row.totalTokens,
    }),
    {
      inputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      outputTextTokens: 0,
      outputReasoningTokens: 0,
      totalTokens: 0,
    },
  );
  const usageByMessageId = new Map<string, { outputReasoningTokens: number }>();
  for (const row of usageRows) {
    if (!row.messageId) continue;
    const current = usageByMessageId.get(row.messageId) ?? { outputReasoningTokens: 0 };
    current.outputReasoningTokens += row.outputReasoningTokens;
    usageByMessageId.set(row.messageId, current);
  }
  const messagesWithUsage = messages.map((message) => ({
    ...message,
    outputReasoningTokens: usageByMessageId.get(message.id)?.outputReasoningTokens ?? 0,
    thinkingDurationSeconds: readMessageDurationSeconds(message.createdAt, message.completedAt),
  }));
  const toolUsage = summarizeToolUsage(toolUsageRows);
  const cost = summarizeSessionCost(costRows);
  const viewerCanMutate = session.userId === userId;
  const runnerUrl = viewerCanMutate ? getRunnerPublicUrl() : null;

  return serializeAgentSessionDetail({
    session: { ...session, viewerCanMutate },
    messages: messagesWithUsage,
    events,
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
  const streamToken =
    runnerUrl && streamTokenSecret
      ? createSessionStreamToken(
          {
            sessionId,
            userId,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
          streamTokenSecret,
        )
      : null;

  return { runnerUrl, streamToken };
}

export type AgentSessionSummaryPayload = {
  id: string;
  title: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export async function loadAgentSessionSummariesForWorkspace(input: {
  agentId: string;
  userId: string;
  workspaceId: string;
  canViewWorkspaceSessions: boolean;
  limit?: number;
}): Promise<AgentSessionSummaryPayload[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: agentSessions.id,
      title: agentSessions.title,
      status: agentSessions.status,
      lastError: agentSessions.lastError,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(agentSessions)
    .innerJoin(users, eq(agentSessions.userId, users.id))
    .where(
      and(
        eq(agentSessions.workspaceId, input.workspaceId),
        eq(agentSessions.agentId, input.agentId),
        input.canViewWorkspaceSessions ? undefined : eq(agentSessions.userId, input.userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(input.limit ?? 8);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    user: {
      id: row.userId,
      name: displayUserName(row),
      email: row.email,
    },
  }));
}

function readMessageDurationSeconds(startedAt: Date, completedAt: Date | null) {
  if (!completedAt || completedAt < startedAt) return undefined;
  return Math.max(Math.round((completedAt.getTime() - startedAt.getTime()) / 1000), 1);
}

function displayUserName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email;
}

function summarizeToolUsage(
  rows: Array<{ provider: string; operation: string; costUsdMicros: number }>,
) {
  const byProviderOperation = new Map<
    string,
    { provider: string; operation: string; costUsdMicros: number; calls: number }
  >();

  for (const row of rows) {
    const key = `${row.provider}:${row.operation}`;
    const current = byProviderOperation.get(key) ?? {
      provider: row.provider,
      operation: row.operation,
      costUsdMicros: 0,
      calls: 0,
    };
    current.costUsdMicros += row.costUsdMicros;
    current.calls += 1;
    byProviderOperation.set(key, current);
  }

  return {
    totalCostUsdMicros: rows.reduce((total, row) => total + row.costUsdMicros, 0),
    byProviderOperation: Array.from(byProviderOperation.values()).sort((left, right) =>
      `${left.provider}:${left.operation}`.localeCompare(`${right.provider}:${right.operation}`),
    ),
  };
}

function summarizeSessionCost(
  rows: Array<{
    source: string;
    amountUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
  }>,
) {
  return rows.reduce(
    (totals, row) => {
      const totalCostUsdMicros = Math.max(-row.amountUsdMicros, 0);
      return {
        providerCostUsdMicros: totals.providerCostUsdMicros + row.providerCostUsdMicros,
        platformFeeUsdMicros: totals.platformFeeUsdMicros + row.platformFeeUsdMicros,
        totalCostUsdMicros: totals.totalCostUsdMicros + totalCostUsdMicros,
        modelCostUsdMicros:
          totals.modelCostUsdMicros + (row.source === "model_usage" ? totalCostUsdMicros : 0),
        toolCostUsdMicros:
          totals.toolCostUsdMicros + (row.source === "tool_usage" ? totalCostUsdMicros : 0),
      };
    },
    {
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
    },
  );
}

"use server";

import {
  createSessionStreamToken,
  newAgentSessionId,
  newAgentSessionMessageId,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  type Agent,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionUsage,
  agents,
} from "@opencompany/db/schema";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  dispatchAgentMessageSubmitted,
  dispatchAgentSessionAbortRequested,
  dispatchAgentSessionStarted,
} from "@/lib/agent-sessions/events";
import {
  callRunner,
  getRunnerPublicUrl,
  getRunnerStreamTokenSecret,
} from "@/lib/agent-sessions/runner";
import { getCurrentWorkspace, requireCurrentWorkspace } from "@/lib/auth";

export async function createAgentSession(idOrPath: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const agent = await loadAgentForSession(idOrPath, workspace.id);

  if (!agent) {
    throw new Error("Agent not found.");
  }

  const sessionId = await insertAgentSession({
    agent,
    title: agent.name,
    userId: user.id,
    workspaceId: workspace.id,
  });

  after(async () => {
    await dispatchAgentSessionStarted({ sessionId, workspaceId: workspace.id });
  });

  revalidatePath("/", "layout");
  revalidatePath("/agents");
  redirect(`/session/${sessionId}`);
}

export async function createAgentSessionFromPrompt(agentId: string, content: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, error: "Message is required." } as const;
  }

  const agent = await loadAgentForSession(agentId, workspace.id);
  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  const sessionId = await insertAgentSession({
    agent,
    title: titleFromPrompt(trimmed),
    userId: user.id,
    workspaceId: workspace.id,
  });
  const messageId = await insertUserMessage(sessionId, trimmed);

  after(async () => {
    await triggerAgentMessageRun({ sessionId, messageId, workspaceId: workspace.id });
  });

  revalidatePath("/", "layout");
  revalidatePath("/");
  redirect(`/session/${sessionId}`);
}

export async function submitAgentSessionMessage(sessionId: string, content: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, error: "Message is required." } as const;
  }

  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  const messageId = await insertUserMessage(sessionId, trimmed);

  after(async () => {
    await triggerAgentMessageRun({ sessionId, messageId, workspaceId: workspace.id });
  });

  revalidatePath(`/session/${sessionId}`);
  return { ok: true, messageId } as const;
}

export async function abortAgentSession(sessionId: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  await db
    .update(agentSessions)
    .set({
      status: "aborting",
      abortRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentSessions.id, sessionId));

  after(async () => {
    await dispatchAgentSessionAbortRequested({ sessionId, workspaceId: workspace.id });
  });

  return { ok: true } as const;
}

export async function archiveAgentSession(sessionId: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const [session] = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      e2bSandboxId: agentSessions.e2bSandboxId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  if (!session.e2bSandboxId) {
    await archiveSessionLocally(sessionId, null);
    revalidatePath("/", "layout");
    revalidatePath("/");
    revalidatePath(`/session/${sessionId}`);
    return { ok: true } as const;
  }

  if (!getRunnerPublicUrl() || !process.env.RUNNER_INTERNAL_TOKEN) {
    return {
      ok: false,
      error:
        "Runner is not configured, so the sandbox cannot be stopped safely. Set RUNNER_PUBLIC_URL and RUNNER_INTERNAL_TOKEN before archiving this session.",
    } as const;
  }

  await db.batch([
    db
      .update(agentSessions)
      .set({ status: "archiving", lastError: null, updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId)),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "archiving", message: "Archiving session" },
    }),
  ]);

  try {
    await callRunner(`/internal/sessions/${sessionId}/archive`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not archive session.";
    await db.batch([
      db
        .update(agentSessions)
        .set({ status: session.status, lastError: message, updatedAt: new Date() })
        .where(eq(agentSessions.id, sessionId)),
      db.insert(agentSessionEvents).values({
        sessionId,
        type: "session.error",
        payload: { message },
      }),
    ]);
    return { ok: false, error: message } as const;
  }

  revalidatePath("/", "layout");
  revalidatePath("/");
  revalidatePath(`/session/${sessionId}`);
  return { ok: true } as const;
}

export async function loadAgentSessionForPage(sessionId: string) {
  const { user, workspace } = await requireCurrentWorkspace();
  const db = getDb();
  const [session] = await db
    .select({
      id: agentSessions.id,
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
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) return null;

  const [messages, events, usageRows] = await Promise.all([
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

  const runnerUrl = getRunnerPublicUrl();
  const streamTokenSecret = getRunnerStreamTokenSecret();
  const token =
    runnerUrl && streamTokenSecret
      ? createSessionStreamToken(
          {
            sessionId,
            userId: user.id,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
          streamTokenSecret,
        )
      : null;

  return { session, messages, events, usage, runnerUrl, token };
}

async function archiveSessionLocally(sessionId: string, previousSandboxId: string | null) {
  const db = getDb();
  const now = new Date();

  await db.batch([
    db
      .update(agentSessions)
      .set({
        status: "archived",
        archivedAt: now,
        sandboxTerminatedAt: now,
        e2bSandboxId: null,
        runLeaseId: null,
        runLeaseOwner: null,
        runLeaseMessageId: null,
        runLeaseExpiresAt: null,
        runHeartbeatAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, sessionId)),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "archived", message: "Session archived" },
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.archived",
      payload: {
        sandboxId: previousSandboxId,
        sandboxKilled: false,
        sandboxAlreadyStopped: previousSandboxId === null,
      },
    }),
  ]);
}

async function loadAgentForSession(idOrPath: string, workspaceId: string) {
  const db = getDb();
  const decodedPath = decodeURIComponent(idOrPath);
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        or(eq(agents.id, idOrPath), eq(agents.path, decodedPath)),
      ),
    )
    .limit(1);

  return agent ?? null;
}

async function insertAgentSession(input: {
  agent: Agent;
  title: string;
  userId: string;
  workspaceId: string;
}) {
  const db = getDb();
  const sessionId = newAgentSessionId();

  await db.batch([
    db.insert(agentSessions).values({
      id: sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agent.id,
      title: input.title,
      modelProvider: input.agent.config.model.provider,
      modelName: input.agent.config.model.name,
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "created", message: "Session created" },
    }),
  ]);

  return sessionId;
}

async function insertUserMessage(sessionId: string, content: string) {
  const db = getDb();
  const messageId = newAgentSessionMessageId();

  await db.batch([
    db.insert(agentSessionMessages).values({
      id: messageId,
      sessionId,
      role: "user",
      status: "completed",
      content,
      modelMessage: { role: "user", content },
      completedAt: new Date(),
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      messageId,
      type: "message.created",
      payload: { messageId, role: "user" },
    }),
  ]);

  return messageId;
}

async function triggerAgentMessageRun(input: {
  sessionId: string;
  messageId: string;
  workspaceId: string;
}) {
  if (!canCallRunnerDirectly()) {
    await dispatchAgentMessageSubmitted(input);
    return;
  }

  try {
    await callRunner(`/internal/sessions/${input.sessionId}/messages/${input.messageId}/run`, {
      event: "opencompany.direct_run_message_failed",
      session_id: input.sessionId,
      message_id: input.messageId,
    });
  } catch {
    await dispatchAgentMessageSubmitted(input);
  }
}

function canCallRunnerDirectly() {
  return Boolean(
    (process.env.RUNNER_INTERNAL_URL || process.env.RUNNER_PUBLIC_URL) &&
      process.env.RUNNER_INTERNAL_TOKEN,
  );
}

function titleFromPrompt(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? "Untitled session";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

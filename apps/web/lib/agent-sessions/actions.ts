"use server";

import {
  createSessionStreamToken,
  newAgentSessionId,
  newAgentSessionMessageId,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agents,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
} from "@opencompany/db/schema";
import { and, asc, eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  dispatchAgentMessageSubmitted,
  dispatchAgentSessionAbortRequested,
  dispatchAgentSessionStarted,
} from "@/lib/agent-sessions/events";
import { getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import { getCurrentWorkspace } from "@/lib/auth";

export async function createAgentSession(idOrPath: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const decodedPath = decodeURIComponent(idOrPath);
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspace.id),
        or(eq(agents.id, idOrPath), eq(agents.path, decodedPath)),
      ),
    )
    .limit(1);

  if (!agent) {
    throw new Error("Agent not found.");
  }

  const sessionId = newAgentSessionId();
  await db.batch([
    db.insert(agentSessions).values({
      id: sessionId,
      workspaceId: workspace.id,
      userId: user.id,
      agentId: agent.id,
      title: agent.name,
      modelProvider: agent.config.model.provider,
      modelName: agent.config.model.name,
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "created", message: "Session created" },
    }),
  ]);

  after(async () => {
    await dispatchAgentSessionStarted({ sessionId, workspaceId: workspace.id });
  });

  revalidatePath("/agents");
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
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  const messageId = newAgentSessionMessageId();
  await db.batch([
    db.insert(agentSessionMessages).values({
      id: messageId,
      sessionId,
      role: "user",
      status: "completed",
      content: trimmed,
      completedAt: new Date(),
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      messageId,
      type: "message.created",
      payload: { messageId, role: "user" },
    }),
  ]);

  after(async () => {
    await dispatchAgentMessageSubmitted({ sessionId, messageId, workspaceId: workspace.id });
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
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  await db
    .update(agentSessions)
    .set({ status: "aborting", abortRequestedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));

  after(async () => {
    await dispatchAgentSessionAbortRequested({ sessionId, workspaceId: workspace.id });
  });

  return { ok: true } as const;
}

export async function loadAgentSessionForPage(sessionId: string) {
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const [session] = await db
    .select({
      id: agentSessions.id,
      title: agentSessions.title,
      status: agentSessions.status,
      modelName: agentSessions.modelName,
      lastError: agentSessions.lastError,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
      ),
    )
    .limit(1);

  if (!session) return null;

  const [messages, events] = await Promise.all([
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
  ]);

  const runnerUrl = getRunnerPublicUrl();
  const token =
    runnerUrl && process.env.RUNNER_INTERNAL_TOKEN
      ? createSessionStreamToken(
          {
            sessionId,
            userId: user.id,
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
          process.env.RUNNER_STREAM_TOKEN_SECRET ?? process.env.RUNNER_INTERNAL_TOKEN,
        )
      : null;

  return { session, messages, events, runnerUrl, token };
}

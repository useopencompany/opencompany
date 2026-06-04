"use server";

import {
  type AgentSessionQuestionAnswer,
  newAgentSessionId,
  newAgentSessionMessageId,
} from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import {
  type Agent,
  agentSessionEvents,
  agentSessionMessages,
  agentSessionQuestions,
  agentSessions,
  agents,
  agentToolApprovals,
  sessionStars,
} from "@opencompany/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { after } from "next/server";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import {
  dispatchAgentAfterSessionCheck,
  dispatchAgentSessionAbortRequested,
  dispatchAgentSessionStarted,
} from "@/lib/agent-sessions/events";
import {
  triggerAgentApprovalResume,
  triggerAgentMessageRun,
  triggerAgentQuestionResume,
} from "@/lib/agent-sessions/message-runner";
import { sidebarSessionFromDetail } from "@/lib/agent-sessions/payload";
import { validateQuestionAnswers } from "@/lib/agent-sessions/question-validation";
import { callRunner, getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import { currentWorkspace } from "@/lib/auth";
import { batchWithTxid } from "@/lib/db/txid";
import { determineApprovalResolution } from "./approval-resolution";

export async function createAgentSession(idOrPath: string) {
  const { user, workspace } = await currentWorkspace();
  if (!(await hasPositiveWorkspaceBalance({ db: getDb(), workspaceId: workspace.id }))) {
    return {
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/settings?billing=insufficient",
    } as const;
  }
  const agent = await loadAgentForSession(idOrPath, workspace.id);

  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  const sessionId = await insertAgentSession({
    agent,
    title: agent.name,
    userId: user.id,
    workspaceId: workspace.id,
  });

  // Analytics is a network flush (PostHog) that must not sit on the critical path, so it
  // runs concurrently with the session-start dispatch inside `after()`.
  after(() =>
    Promise.all([
      dispatchAgentSessionStarted({ sessionId, workspaceId: workspace.id }),
      captureServerEvent("session_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        model_provider: agent.config.model.provider,
        model_name: agent.config.model.name,
        source: "agent",
      }),
    ]),
  );

  return loadCreatedSessionResult(sessionId, user.id, workspace.id);
}

export async function createAgentSessionFromPrompt(agentId: string, content: string) {
  const { user, workspace } = await currentWorkspace();
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, error: "Message is required." } as const;
  }
  if (!(await hasPositiveWorkspaceBalance({ db: getDb(), workspaceId: workspace.id }))) {
    return {
      ok: false,
      error: "Add workspace credits to start a session.",
      redirectTo: "/settings?billing=insufficient",
    } as const;
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

  // Analytics is a network flush (PostHog) that previously blocked this action's return
  // and therefore the runner dispatch. Run dispatch and analytics concurrently in
  // `after()` so neither sits on the time-to-first-token path.
  after(() =>
    Promise.all([
      triggerAgentMessageRun({ sessionId, messageId, workspaceId: workspace.id }),
      dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id }),
      captureServerEvent("session_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        model_provider: agent.config.model.provider,
        model_name: agent.config.model.name,
        source: "prompt",
      }),
      captureServerEvent("session_message_sent", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        message_id: messageId,
        model_provider: agent.config.model.provider,
        model_name: agent.config.model.name,
        is_initial_message: true,
        message_length: trimmed.length,
      }),
    ]),
  );

  return loadCreatedSessionResult(sessionId, user.id, workspace.id);
}

export async function submitAgentSessionMessage(sessionId: string, content: string) {
  const { user, workspace } = await currentWorkspace();
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, error: "Message is required." } as const;
  }

  const db = getDb();
  // The balance check and the session-authz lookup are independent reads, so run them
  // concurrently — one round-trip on the message path instead of two.
  const [hasBalance, sessionRows] = await Promise.all([
    hasPositiveWorkspaceBalance({ db, workspaceId: workspace.id }),
    db
      .select({
        id: agentSessions.id,
        agentId: agentSessions.agentId,
        modelProvider: agentSessions.modelProvider,
        modelName: agentSessions.modelName,
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
      .limit(1),
  ]);

  // Preserve the prior error precedence: credits before session existence.
  if (!hasBalance) {
    return { ok: false, error: "Add workspace credits to continue this session." } as const;
  }
  const session = sessionRows[0];
  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  // A freeform reply while an ask_user_question is pending supersedes it: the user chose to
  // answer in prose instead. Cancel the pending row so the backstop can't later revive the
  // session, and do NOT trigger a question resume — the new message run continues the turn (the
  // dangling tool-call is dropped from model history by buildModelMessages). Status-guarded so a
  // concurrent answer/cancel always wins.
  await db
    .update(agentSessionQuestions)
    .set({
      status: "cancelled",
      resolutionSource: "superseded",
      answeredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionQuestions.sessionId, sessionId),
        eq(agentSessionQuestions.status, "pending"),
      ),
    );

  const messageId = await insertUserMessage(sessionId, trimmed);

  // Analytics is a network flush (PostHog) that previously blocked this action's return
  // and therefore the runner dispatch. Run dispatch and analytics concurrently in
  // `after()` so neither sits on the time-to-first-token path.
  after(() =>
    Promise.all([
      triggerAgentMessageRun({ sessionId, messageId, workspaceId: workspace.id }),
      dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id }),
      captureServerEvent("session_message_sent", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: session.agentId,
        session_id: sessionId,
        message_id: messageId,
        model_provider: session.modelProvider,
        model_name: session.modelName,
        is_initial_message: false,
        message_length: trimmed.length,
      }),
    ]),
  );

  return { ok: true, messageId } as const;
}

export async function abortAgentSession(sessionId: string) {
  const { user, workspace } = await currentWorkspace();
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

// Approve or deny a paused tool call. The approval row is the source of truth: the
// runner no longer polls it. This action records the user's decision and then drives
// the resume by calling the runner's resume endpoint. The `status = 'pending'` guard
// makes this idempotent and ensures
// only the winning caller proceeds — a row the backstop sweep already auto-denied on
// timeout, or a concurrent duplicate decision, flips nothing and triggers no resume.
export async function resolveToolApproval(input: {
  sessionId: string;
  toolCallId: string;
  decision: "approved" | "denied";
}) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  const updated = await db
    .update(agentToolApprovals)
    .set({
      status: input.decision,
      decidedAt: new Date(),
      decidedByUserId: user.id,
      decisionSource: "user",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentToolApprovals.sessionId, input.sessionId),
        eq(agentToolApprovals.toolCallId, input.toolCallId),
        eq(agentToolApprovals.status, "pending"),
      ),
    )
    .returning({ id: agentToolApprovals.id });

  const resolution = determineApprovalResolution({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    decision: input.decision,
    workspaceId: workspace.id,
    updatedRows: updated,
  });
  if (!resolution.ok) {
    return { ok: false, error: resolution.error } as const;
  }

  // Only the caller that actually flipped the row drives the resume, so a duplicate or
  // already-resolved decision can't double-trigger the runner. This must be awaited:
  // otherwise the UI can optimistically show "denying..." after the approval row was
  // decided, while no resume job/event was actually produced.
  if (resolution.shouldResume) {
    await triggerAgentApprovalResume({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      workspaceId: workspace.id,
    });
  }

  return { ok: true } as const;
}

// Record the user's answers to a paused ask_user_question and drive the resume. The question row
// is the source of truth (the runner does not poll it). The `status = 'pending'` guard makes this
// idempotent and ensures only the winning caller resumes — a row the backstop already timed out,
// or a concurrent submit, flips nothing and triggers no resume.
export async function submitAgentSessionQuestionResponse(input: {
  sessionId: string;
  toolCallId: string;
  answers: AgentSessionQuestionAnswer[];
}) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const [row] = await db
    .select({
      questions: agentSessionQuestions.questions,
      status: agentSessionQuestions.status,
    })
    .from(agentSessionQuestions)
    .innerJoin(agentSessions, eq(agentSessions.id, agentSessionQuestions.sessionId))
    .where(
      and(
        eq(agentSessionQuestions.sessionId, input.sessionId),
        eq(agentSessionQuestions.toolCallId, input.toolCallId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!row) {
    return { ok: false, error: "Question not found." } as const;
  }
  if (row.status !== "pending") {
    return { ok: false, error: "This question is no longer awaiting an answer." } as const;
  }

  const validationError = validateQuestionAnswers(row.questions, input.answers);
  if (validationError) {
    return { ok: false, error: validationError } as const;
  }

  const updated = await db
    .update(agentSessionQuestions)
    .set({
      status: "answered",
      answers: input.answers,
      answeredAt: new Date(),
      answeredByUserId: user.id,
      resolutionSource: "user",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionQuestions.sessionId, input.sessionId),
        eq(agentSessionQuestions.toolCallId, input.toolCallId),
        eq(agentSessionQuestions.status, "pending"),
      ),
    )
    .returning({ id: agentSessionQuestions.id });

  if (updated.length === 0) {
    return { ok: false, error: "This question is no longer awaiting an answer." } as const;
  }

  await triggerAgentQuestionResume({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    workspaceId: workspace.id,
  });

  return { ok: true } as const;
}

// Dismiss a paused ask_user_question (the X / Skip). Cancels the row and triggers a resume that
// resolves QUIETLY: the runner persists an "unanswered" tool-result and parks the session as
// completed WITHOUT generating an assistant message (see the isQuietDecline branch in
// resumeQuestionResponseWithContext). The composer returns and the agent only speaks again on the
// user's next message — which then replays over assistant(ask) → tool(unanswered) → user(...). Same
// status-guard and only-winner-resumes semantics as the answer path.
export async function cancelAgentSessionQuestion(input: { sessionId: string; toolCallId: string }) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }

  const updated = await db
    .update(agentSessionQuestions)
    .set({
      status: "cancelled",
      resolutionSource: "user",
      answeredAt: new Date(),
      answeredByUserId: user.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionQuestions.sessionId, input.sessionId),
        eq(agentSessionQuestions.toolCallId, input.toolCallId),
        eq(agentSessionQuestions.status, "pending"),
      ),
    )
    .returning({ id: agentSessionQuestions.id });

  if (updated.length === 0) {
    return { ok: false, error: "This question is no longer awaiting an answer." } as const;
  }

  await triggerAgentQuestionResume({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    workspaceId: workspace.id,
  });

  return { ok: true } as const;
}

export async function archiveAgentSession(sessionId: string) {
  const { user, workspace } = await currentWorkspace();
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
    const txid = await archiveSessionLocally(sessionId, null);
    return { ok: true, txid } as const;
  }

  if (!getRunnerPublicUrl() || !process.env.RUNNER_INTERNAL_TOKEN) {
    return {
      ok: false,
      error:
        "Runner is not configured, so the sandbox cannot be stopped safely. Set RUNNER_PUBLIC_URL and RUNNER_INTERNAL_TOKEN before archiving this session.",
    } as const;
  }

  // The runner sets archived_at later (out of band), so we reconcile the
  // optimistic delete against THIS transaction — the status="archiving" write.
  // Once it syncs the sidebar selector keeps the row hidden (it excludes the
  // "archiving" status) until archived_at lands and removes it from the shape.
  const txid = await batchWithTxid(
    db
      .update(agentSessions)
      .set({ status: "archiving", lastError: null, updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId)),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "archiving", message: "Archiving session" },
    }),
  );

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

  return { ok: true, txid } as const;
}

export async function setSessionStar(sessionId: string, starred: boolean) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  // Guard: only the owning user may star a session they can actually see.
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

  if (starred) {
    const starredAt = new Date();
    const txid = await batchWithTxid(
      db
        .insert(sessionStars)
        .values({ userId: user.id, sessionId, starredAt })
        .onConflictDoUpdate({
          target: [sessionStars.userId, sessionStars.sessionId],
          set: { starredAt },
        }),
    );
    return { ok: true, txid, starredAt: starredAt.toISOString() } as const;
  }

  const txid = await batchWithTxid(
    db
      .delete(sessionStars)
      .where(and(eq(sessionStars.userId, user.id), eq(sessionStars.sessionId, sessionId))),
  );
  return { ok: true, txid, starredAt: null } as const;
}

async function loadCreatedSessionResult(sessionId: string, userId: string, workspaceId: string) {
  const detail = await loadAgentSessionDetailForWorkspace(sessionId, userId, workspaceId);
  if (!detail) {
    return { ok: false, error: "Session was created but could not be loaded." } as const;
  }

  return { ok: true, session: sidebarSessionFromDetail(detail), detail } as const;
}

// Returns the Postgres txid of the archive write so an optimistic sidebar delete
// can reconcile against the row leaving the agent_sessions shape (archived_at is
// set here, which removes it from the shape).
async function archiveSessionLocally(
  sessionId: string,
  previousSandboxId: string | null,
): Promise<number> {
  const db = getDb();
  const now = new Date();

  return batchWithTxid(
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
  );
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
      payload: { messageId, role: "user", content, status: "completed" },
    }),
  ]);

  return messageId;
}

function titleFromPrompt(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? "Untitled session";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

"use server";

import {
  type AgentSessionQuestionAnswer,
  ATTACHMENT_MAX_PER_MESSAGE,
  getAgentModelDefinition,
  modelSupportsAttachments,
  newAgentSessionId,
  newAgentSessionMessageAttachmentId,
  newAgentSessionMessageId,
  normalizeAgentConfig,
  validateAttachmentCandidate,
} from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import {
  type Agent,
  agentSessionEvents,
  agentSessionMessageAttachments,
  agentSessionMessages,
  agentSessionQuestions,
  agentSessions,
  agents,
  agentToolApprovals,
  onboardingResponses,
  sessionStars,
  workspaces,
} from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { and, eq, isNull, or } from "drizzle-orm";
import { after } from "next/server";
import { buildCreatedSessionDetail } from "@/lib/agent-sessions/data";
import { appendSessionStreamEvent, closeSessionStream } from "@/lib/agent-sessions/durable-streams";
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
import { isSessionContinuable, isToolStepLimitResumable } from "@/lib/agent-sessions/resumable";
import { callRunner, getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import type { SendMode } from "@/lib/agent-sessions/send-mode";
import { currentWorkspace } from "@/lib/auth";
import {
  ensureWorkspaceRunAllowance,
  type RunAllowanceReason,
  runAllowanceErrorMessage,
} from "@/lib/billing/run-allowance";
import { batchWithTxid } from "@/lib/db/txid";
import { normalizeCompanyUrl } from "@/lib/onboarding/validation";
import {
  enablePersonalAgentIntegrations,
  type PersonalIntegrationId,
} from "@/lib/personal/actions";
import { personalPaths } from "@/lib/personal/paths";
import { determineApprovalResolution } from "./approval-resolution";

type SessionStartSurface = "company" | "personal";

type SessionStartOptions = {
  surface?: SessionStartSurface;
};

function billingRedirectForSurface(
  surface: SessionStartSurface = "company",
  reason: RunAllowanceReason = "no_balance",
) {
  const query = reason === "weekly_limit_reached" ? "?billing=limit" : "?billing=insufficient";
  return surface === "personal" ? `${personalPaths.settings}${query}` : `/company/settings${query}`;
}

export async function createAgentSession(idOrPath: string, options: SessionStartOptions = {}) {
  const { user, workspace } = await currentWorkspace();
  const allowance = await ensureWorkspaceRunAllowance({
    workspaceId: workspace.id,
    userId: user.id,
  });
  if (!allowance.allowed) {
    return {
      ok: false,
      error: runAllowanceErrorMessage(allowance.reason, "start"),
      redirectTo: billingRedirectForSurface(options.surface, allowance.reason),
      reason: allowance.reason,
    } as const;
  }
  const agent = await loadAgentForSession(idOrPath, workspace.id, user.id);

  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  const { session, statusEvent } = await insertAgentSession({
    agent,
    title: agent.name,
    userId: user.id,
    workspaceId: workspace.id,
  });
  const sessionId = session.id;
  const engine = session.engine;

  // Analytics is a network flush (PostHog) that must not sit on the critical path, so it
  // runs concurrently with the session-start dispatch inside `after()`.
  after(() =>
    Promise.all([
      ...(engine === "opencompany"
        ? [dispatchAgentSessionStarted({ sessionId, workspaceId: workspace.id })]
        : []),
      captureServerEvent("session_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        model_provider: agent.config.model.provider,
        model_name: agent.config.model.name,
        engine,
        source: "agent",
      }),
    ]),
  );

  const detail = buildCreatedSessionDetail({
    agent,
    session,
    messages: [],
    events: [statusEvent],
  });
  return { ok: true, session: sidebarSessionFromDetail(detail), detail } as const;
}

export async function createAgentSessionFromPrompt(
  agentId: string,
  content: string,
  modelId?: string,
  attachments: SubmitAttachmentInput[] = [],
  options: SessionStartOptions = {},
) {
  const { user, workspace } = await currentWorkspace();
  const trimmed = content.trim();
  if (!trimmed && attachments.length === 0) {
    return { ok: false, error: "Message is required." } as const;
  }
  const db = getDb();
  const [allowance, agent] = await Promise.all([
    ensureWorkspaceRunAllowance({ db, workspaceId: workspace.id, userId: user.id }),
    loadAgentForSession(agentId, workspace.id, user.id, db),
  ]);

  if (!allowance.allowed) {
    return {
      ok: false,
      error: runAllowanceErrorMessage(allowance.reason, "start"),
      redirectTo: billingRedirectForSurface(options.surface, allowance.reason),
      reason: allowance.reason,
    } as const;
  }
  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  // A valid catalog model picked in the composer overrides the agent's default for this
  // session only; an unknown/stale id is ignored in favor of the agent default.
  const modelName = modelId && getAgentModelDefinition(modelId) ? modelId : agent.config.model.name;
  const engine = normalizeAgentConfig(agent.config).engine;

  if (engine === "codex" && attachments.length > 0) {
    return { ok: false, error: "Codex sessions do not support attachments yet." } as const;
  }

  // Re-validate attachments server-side against this session's model + the caller's workspace.
  const attachmentCheck = validateSubmitAttachments(attachments, modelName, workspace.id);
  if (!attachmentCheck.ok) {
    return { ok: false, error: attachmentCheck.error } as const;
  }

  const {
    session,
    statusEvent,
    message,
    createdEvent,
    attachments: messageAttachments,
  } = await insertAgentSessionWithUserMessage({
    agent,
    title: titleFromPrompt(trimmed),
    userId: user.id,
    workspaceId: workspace.id,
    modelName,
    content: trimmed,
    attachments,
  });
  const sessionId = session.id;
  const messageId = message.id;
  const sessionEngine = session.engine;

  // Analytics is a network flush (PostHog) that previously blocked this action's return
  // and therefore the runner dispatch. Run dispatch and analytics concurrently in
  // `after()` so neither sits on the time-to-first-token path.
  after(() =>
    Promise.all([
      triggerAgentMessageRun({
        sessionId,
        messageId,
        workspaceId: workspace.id,
        engine: sessionEngine,
      }),
      ...(sessionEngine === "opencompany"
        ? [dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id })]
        : []),
      captureServerEvent("session_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        model_provider: agent.config.model.provider,
        model_name: modelName,
        engine: sessionEngine,
        source: "prompt",
      }),
      captureServerEvent("session_message_sent", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        message_id: messageId,
        model_provider: agent.config.model.provider,
        model_name: modelName,
        engine: sessionEngine,
        is_initial_message: true,
        message_length: trimmed.length,
      }),
    ]),
  );

  const detail = buildCreatedSessionDetail({
    agent,
    session,
    messages: [message],
    events: [statusEvent, createdEvent],
    attachments: messageAttachments,
  });
  return { ok: true, session: sidebarSessionFromDetail(detail), detail } as const;
}

// Background context the user gave on the onboarding screens (their role, company, team size, and
// how familiar they are with agents). It is never typed into chat — the user no longer types a first
// task — so we inject it invisibly into the first message's model content so the onboarding skill
// starts already knowing them (see buildOnboardingModelContent).
export type PersonalOnboardingContext = {
  name: string;
  website: string;
  role: string;
  teamSize?: string;
  agentExperience?: string;
};

// The chosen preset (if any) from the agent-setup step, the integrations the user left enabled, and
// the short attribution survey we persist for analytics. The
// integrations are written to the agent body before the run fires; the preset's mode + integration
// list ride (invisibly) into the first message so the onboarding skill tunes the soul to that role;
// the survey + context are persisted best-effort and never block the session.
export type PersonalOnboardingOptions = {
  integrations: PersonalIntegrationId[];
  skipBillingCheck?: boolean;
  setup?: { id: string; title: string; intent: string };
  survey?: { heardFrom: string; heardFromDetail: string };
};

// Persist the onboarding answers (attribution survey + role/team/company) the same way the legacy
// workspace flow did — minus the leo scaffold, sales-call booking, and redirect. Best-effort: a
// failure here must never block the user from starting their first session. Idempotent on userId, so
// re-running onboarding (e.g. dev reset) doesn't duplicate the row.
async function persistPersonalOnboardingSurvey(
  userId: string,
  workspaceId: string,
  context: PersonalOnboardingContext,
  survey: { heardFrom: string; heardFromDetail: string } | undefined,
) {
  try {
    const db = getDb();
    const now = new Date();
    const heardFrom = survey?.heardFrom?.trim() ?? "";
    const companyUrl = normalizeCompanyUrl(context.website.trim());

    if (heardFrom) {
      await db
        .insert(onboardingResponses)
        .values({
          userId,
          workspaceId,
          heardFrom,
          heardFromDetail: heardFrom === "other" ? survey?.heardFromDetail?.trim() || null : null,
          role: context.role.trim(),
          agentExperience: context.agentExperience?.trim() || "",
          helpAreas: [],
          updatedAt: now,
        })
        .onConflictDoNothing({ target: onboardingResponses.userId });
    }

    await db
      .update(workspaces)
      .set({
        ...(context.teamSize?.trim() ? { teamSize: context.teamSize.trim() } : {}),
        ...(companyUrl ? { companyUrl } : {}),
        updatedAt: now,
      })
      .where(eq(workspaces.id, workspaceId));
  } catch (error) {
    captureException(error, {
      event: "opencompany.personal_onboarding_survey_persist_failed",
      workspace_id: workspaceId,
      user_id: userId,
    });
  }
}

// Personal onboarding session creation: the visible first message is the user's "what do you want
// to get done today?" answer. We seed it as a normal user message (so it reads naturally in the
// transcript) but the model-only content also carries (a) the background context the user gave on
// the first screen and (b) a thin pointer to the `onboarding` skill, so the agent runs the
// first-session procedure (read context → save to memory → name itself + tune its soul → start the
// task) without any of that machinery leaking into the UI.
export async function createPersonalOnboardingSession(
  agentId: string,
  context: PersonalOnboardingContext,
  prompt: string,
  options: PersonalOnboardingOptions = { integrations: [] },
) {
  // skipOnboarding: this action IS the final onboarding step — the caller has not completed
  // onboarding yet (the survey row that marks completion is persisted below), so the default
  // gate would bounce the submit straight back to /onboarding.
  const { user, workspace } = await currentWorkspace({ skipOnboarding: true });
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ok: false, error: "Tell the agent what you'd like to get done." } as const;
  }
  if (!options.skipBillingCheck) {
    const allowance = await ensureWorkspaceRunAllowance({
      workspaceId: workspace.id,
      userId: user.id,
    });
    if (!allowance.allowed) {
      return {
        ok: false,
        error: runAllowanceErrorMessage(allowance.reason, "start"),
        redirectTo: billingRedirectForSurface("company", allowance.reason),
        reason: allowance.reason,
      } as const;
    }
  }

  // Persist the attribution survey + role/team/company (best-effort, never blocks the session).
  await persistPersonalOnboardingSurvey(user.id, workspace.id, context, options.survey);

  // Enable the integrations the user kept selected before the run fires. This appends their
  // @mentions to the agent body (idempotent); the deferred run below reads the fresh agent, so the
  // tools are wired in time. Best-effort — a failure here must not block starting the session.
  if (options.integrations.length > 0) {
    await enablePersonalAgentIntegrations(agentId, options.integrations);
  }

  const agent = await loadAgentForSession(agentId, workspace.id, user.id);
  if (!agent) {
    return { ok: false, error: "Agent not found." } as const;
  }

  const { session, statusEvent } = await insertAgentSession({
    agent,
    title: titleFromPrompt(trimmed),
    userId: user.id,
    workspaceId: workspace.id,
  });
  const sessionId = session.id;
  const sessionEngine = session.engine;

  // Visible content = the task verbatim. Model-only content appends the background context and the
  // onboarding pointer; it never renders in the transcript (modelMessage), so the user just sees
  // their own message.
  const modelContent = buildOnboardingModelContent(trimmed, context, options);
  const { message, createdEvent } = await insertUserMessage(sessionId, trimmed, {
    workspaceId: workspace.id,
    attachments: [],
    modelContent,
  });
  const messageId = message.id;

  after(() =>
    Promise.all([
      triggerAgentMessageRun({
        sessionId,
        messageId,
        workspaceId: workspace.id,
        engine: sessionEngine,
      }),
      ...(sessionEngine === "opencompany"
        ? [dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id })]
        : []),
      captureServerEvent("session_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: agent.id,
        session_id: sessionId,
        model_provider: agent.config.model.provider,
        model_name: agent.config.model.name,
        engine: sessionEngine,
        source: "onboarding",
      }),
    ]),
  );

  const detail = buildCreatedSessionDetail({
    agent,
    session,
    messages: [message],
    events: [statusEvent, createdEvent],
  });
  return { ok: true, session: sidebarSessionFromDetail(detail), detail } as const;
}

export type SubmitAttachmentInput = {
  blobPathname: string;
  blobUrl: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
};

// Server-side re-validation of attachments — the client checks are advisory only. Enforces the
// per-message limit, the MIME/size envelope, the model's image/pdf capability, and that every
// blob pointer is scoped to the caller's workspace. Shared by the new-session prompt path and the
// follow-up message path so both gates stay identical.
function validateSubmitAttachments(
  attachments: SubmitAttachmentInput[],
  modelName: string,
  workspaceId: string,
): { ok: true } | { ok: false; error: string } {
  if (attachments.length > ATTACHMENT_MAX_PER_MESSAGE) {
    return { ok: false, error: "Too many attachments." };
  }
  const capability = modelSupportsAttachments(modelName);
  for (const att of attachments) {
    const result = validateAttachmentCandidate({
      mediaType: att.mediaType,
      sizeBytes: att.sizeBytes,
      filename: att.filename,
    });
    if (!result.ok) {
      return { ok: false, error: "Unsupported or oversized attachment." };
    }
    if (result.kind === "image" && !capability.images) {
      return { ok: false, error: "This model can't read images." };
    }
    if (result.kind === "pdf" && !capability.pdf) {
      return { ok: false, error: "This model can't read PDFs." };
    }
    if (!att.blobPathname.startsWith(`workspace/${workspaceId}/`)) {
      return { ok: false, error: "Attachment outside workspace scope." };
    }
  }
  return { ok: true };
}

// Build the attachment rows for a message. The attachment bytes never touch Postgres — these
// rows persist metadata + the private-blob pointers; the runner hydrates the bytes from Blob at
// run time. Shared by the prompt (new-session) and follow-up message inserts.
function buildAttachmentRows(input: {
  messageId: string;
  sessionId: string;
  workspaceId: string;
  attachments: SubmitAttachmentInput[];
}) {
  return input.attachments.map((att) => {
    const v = validateAttachmentCandidate({
      mediaType: att.mediaType,
      sizeBytes: att.sizeBytes,
      filename: att.filename,
    });
    return {
      id: newAgentSessionMessageAttachmentId(),
      messageId: input.messageId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      kind: v.ok ? v.kind : ("image" as const),
      mediaType: att.mediaType,
      filename: att.filename,
      sizeBytes: att.sizeBytes,
      blobPathname: att.blobPathname,
      blobUrl: att.blobUrl,
    };
  });
}

export async function submitAgentSessionMessage(
  sessionId: string,
  content: string,
  attachments: SubmitAttachmentInput[] = [],
  sendMode: SendMode = "steer",
) {
  const { user, workspace } = await currentWorkspace();
  const trimmed = content.trim();
  if (!trimmed && attachments.length === 0) {
    return { ok: false, error: "Message is required." } as const;
  }

  const db = getDb();
  // The balance check and the session-authz lookup are independent reads, so run them
  // concurrently — one round-trip on the message path instead of two.
  const [allowance, sessionRows] = await Promise.all([
    ensureWorkspaceRunAllowance({ db, workspaceId: workspace.id, userId: user.id }),
    db
      .select({
        id: agentSessions.id,
        agentId: agentSessions.agentId,
        modelProvider: agentSessions.modelProvider,
        modelName: agentSessions.modelName,
        engine: agentSessions.engine,
        status: agentSessions.status,
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
  if (!allowance.allowed) {
    return { ok: false, error: runAllowanceErrorMessage(allowance.reason, "continue") } as const;
  }
  const session = sessionRows[0];
  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }
  if (session.engine === "codex" && attachments.length > 0) {
    return { ok: false, error: "Codex sessions do not support attachments yet." } as const;
  }

  // Re-validate attachments server-side: the client checks are advisory only. Enforced against
  // the session's actual model and the caller's workspace (same gate as the new-session path).
  const attachmentCheck = validateSubmitAttachments(attachments, session.modelName, workspace.id);
  if (!attachmentCheck.ok) {
    return { ok: false, error: attachmentCheck.error } as const;
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

  // Steering only applies mid-work — a message sent while a turn is actively in flight (or parked
  // mid-turn awaiting input/approval). When the session is idle or the run is already done, this is
  // just a normal message: we don't tag it with a send-mode, so the UI renders a plain bubble (not
  // a "Steered" annotation) and a finished run is never re-steered. The runner still treats a NULL
  // mode as steer if one somehow lands mid-run, so this only affects presentation, never delivery.
  const midWork =
    session.status === "running" ||
    session.status === "awaiting_approval" ||
    session.status === "awaiting_input";
  const effectiveSendMode = midWork ? sendMode : null;
  const { message } = await insertUserMessage(sessionId, trimmed, {
    workspaceId: workspace.id,
    attachments,
    sendMode: effectiveSendMode,
  });
  const messageId = message.id;

  // Interrupt mode: the user aborted the in-flight turn to run this message now. Request the
  // abort synchronously (off the time-to-first-token path it would otherwise share) so the
  // runner stops at its next step/tool boundary as soon as possible; its abort-path
  // continuation then answers this message next. Only meaningful while a turn is actually
  // running — otherwise interrupt is just a normal send. Steer and queue never abort.
  const interruptRunning = sendMode === "interrupt" && session.status === "running";
  if (interruptRunning) {
    await db
      .update(agentSessions)
      .set({ status: "aborting", abortRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId));
    await appendSessionStreamEvent(sessionId, {
      id: null,
      type: "session.status",
      messageId: null,
      payload: { status: "aborting" },
      createdAt: new Date().toISOString(),
    });
  }

  // Analytics is a network flush (PostHog) that previously blocked this action's return
  // and therefore the runner dispatch. Run dispatch and analytics concurrently in
  // `after()` so neither sits on the time-to-first-token path.
  after(() =>
    Promise.all([
      ...(interruptRunning
        ? [dispatchAgentSessionAbortRequested({ sessionId, workspaceId: workspace.id })]
        : []),
      triggerAgentMessageRun({
        sessionId,
        messageId,
        workspaceId: workspace.id,
        engine: session.engine,
      }),
      ...(session.engine === "opencompany"
        ? [dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id })]
        : []),
      captureServerEvent("session_message_sent", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: session.agentId,
        session_id: sessionId,
        message_id: messageId,
        model_provider: session.modelProvider,
        model_name: session.modelName,
        engine: session.engine,
        is_initial_message: false,
        message_length: trimmed.length,
      }),
    ]),
  );

  return { ok: true, messageId } as const;
}

// Switch the model a session runs with, on the fly. This is the session's own model override
// (stored on agentSessions.modelName) — it is sticky for the session and applies to every
// following turn until changed again. It does NOT touch the agent's saved default model. The
// runner reads agentSessions.modelName as the model override on its next turn, so this takes
// effect on the next message and never interrupts an in-flight run.
export async function setAgentSessionModel(sessionId: string, modelId: string) {
  const { user, workspace } = await currentWorkspace();
  if (!getAgentModelDefinition(modelId)) {
    return { ok: false, error: "Unknown model." } as const;
  }

  const db = getDb();
  const updated = await db
    .update(agentSessions)
    .set({
      modelProvider: "vercel-ai-gateway",
      modelName: modelId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
        isNull(agentSessions.archivedAt),
      ),
    )
    .returning({ id: agentSessions.id });

  if (updated.length === 0) {
    return { ok: false, error: "Session not found." } as const;
  }

  return { ok: true } as const;
}

export async function continueInterruptedSession(sessionId: string) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const [allowance, sessionRows] = await Promise.all([
    ensureWorkspaceRunAllowance({ db, workspaceId: workspace.id, userId: user.id }),
    db
      .select({
        id: agentSessions.id,
        agentId: agentSessions.agentId,
        status: agentSessions.status,
        runLeaseId: agentSessions.runLeaseId,
        lastError: agentSessions.lastError,
        modelProvider: agentSessions.modelProvider,
        modelName: agentSessions.modelName,
        engine: agentSessions.engine,
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

  if (!allowance.allowed) {
    return { ok: false, error: runAllowanceErrorMessage(allowance.reason, "continue") } as const;
  }
  const session = sessionRows[0];
  if (!session) {
    return { ok: false, error: "Session not found." } as const;
  }
  if (!isSessionContinuable({ status: session.status, lastError: session.lastError })) {
    return { ok: false, error: "This session is not interrupted." } as const;
  }
  if (session.runLeaseId) {
    return { ok: false, error: "This session is still running. Try again shortly." } as const;
  }

  const stepLimitResume = isToolStepLimitResumable({
    status: session.status,
    lastError: session.lastError,
  });
  const { message } = await insertUserMessage(sessionId, "Continue", {
    workspaceId: workspace.id,
    attachments: [],
    modelContent: stepLimitResume
      ? [
          "Continue after the prior turn reached the tool-step limit before producing a final answer.",
          "Inspect the persisted tool results, conversation, current workspace, and sandbox state before deciding what to do next.",
          "Avoid repeating completed work or duplicating side effects.",
          "Finish with a final answer if enough work is complete; otherwise continue only the missing work.",
        ].join(" ")
      : [
          "Continue from the interrupted turn.",
          "The prior runner process was stopped while this session was active.",
          "Inspect the current workspace and sandbox state before deciding what to do next.",
          "Do not repeat completed work or duplicate side effects if the interrupted tool already made progress.",
        ].join(" "),
  });
  const messageId = message.id;

  after(() =>
    Promise.all([
      triggerAgentMessageRun({
        sessionId,
        messageId,
        workspaceId: workspace.id,
        engine: session.engine,
      }),
      ...(session.engine === "opencompany"
        ? [dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id })]
        : []),
      captureServerEvent("session_message_sent", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        agent_id: session.agentId,
        session_id: sessionId,
        message_id: messageId,
        model_provider: session.modelProvider,
        model_name: session.modelName,
        engine: session.engine,
        is_initial_message: false,
        message_length: "Continue".length,
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

  // Reflect the optimistic "aborting" status on the Durable Stream so a
  // stream-sourced transcript shows it immediately; the runner's subsequent
  // durable status events (aborting → aborted) reconcile. Best-effort.
  await appendSessionStreamEvent(sessionId, {
    id: null,
    type: "session.status",
    messageId: null,
    payload: { status: "aborting" },
    createdAt: new Date().toISOString(),
  });

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

// Rename a session's sidebar title. The title is auto-generated from the first
// message at creation; this lets the owning user override it. Returns the Postgres
// txid of the write so the sidebar's optimistic update (agentSessions.update())
// reconciles cleanly against the Electric replication stream.
export async function renameAgentSession(sessionId: string, title: string) {
  const { user, workspace } = await currentWorkspace();

  // Trim, and cap defensively — the column is unbounded `text`, but a sidebar title
  // has no business being longer than this.
  const next = title.trim().slice(0, 200);
  if (!next) {
    return { ok: false, error: "Title cannot be empty." } as const;
  }

  const db = getDb();

  // Guard: only the owning user may rename a session they can actually see.
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

  const txid = await batchWithTxid(
    db
      .update(agentSessions)
      .set({ title: next, updatedAt: new Date() })
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.workspaceId, workspace.id),
          eq(agentSessions.userId, user.id),
          isNull(agentSessions.archivedAt),
        ),
      ),
  );

  return { ok: true, txid } as const;
}

// Record that the current user has viewed this session, clearing its sidebar "unseen"
// blue dot. Writes ONLY last_seen_at — deliberately not updatedAt, so viewing a session
// never reshuffles the sidebar's recency order. Fire-and-forget from the open session
// view; the cleared state streams back to every tab via Electric. Scoped to the owning
// user so it can only ever touch a session the caller can see.
export async function markSessionSeen(sessionId: string) {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  await db
    .update(agentSessions)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.workspaceId, workspace.id),
        eq(agentSessions.userId, user.id),
      ),
    );

  return { ok: true } as const;
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

  const txid = await batchWithTxid(
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

  // The session is permanently archived — the one provably-safe point to close the
  // Durable Stream (EOF). Best-effort; never blocks the archive (Postgres is the
  // system of record).
  await closeSessionStream(sessionId);

  return txid;
}

async function loadAgentForSession(
  idOrPath: string,
  workspaceId: string,
  userId: string,
  db = getDb(),
) {
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

  if (!agent) return null;

  // Default agents are private to a single user (the personal agent). Workspace scoping alone is
  // not enough here: a workspace peer who supplies another user's personal agent id must not be
  // able to start a session against it. Shared (non-default) agents stay workspace-visible.
  if (agent.isDefault && agent.userId !== userId) return null;

  return agent;
}

async function insertAgentSession(input: {
  agent: Agent;
  title: string;
  userId: string;
  workspaceId: string;
  // Per-session model override. Defaults to the agent's configured model when omitted.
  // The agent's saved default (agent.config.model.name) is never changed by this.
  modelName?: string;
}) {
  const db = getDb();
  const sessionId = newAgentSessionId();
  const modelName = input.modelName ?? input.agent.config.model.name;
  const engine = normalizeAgentConfig(input.agent.config).engine;
  const status = engine === "codex" ? "ready" : "created";
  const statusMessage = engine === "codex" ? "Session ready" : "Session created";

  // Return the canonical session row and status-event row so callers can synthesize the
  // session detail payload in-memory (see buildCreatedSessionDetail) instead of issuing a
  // follow-up read on the create path.
  const [sessionRows, statusEventRows] = await db.batch([
    db
      .insert(agentSessions)
      .values({
        id: sessionId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        agentId: input.agent.id,
        title: input.title,
        status,
        engine,
        modelProvider: input.agent.config.model.provider,
        modelName,
      })
      .returning(),
    db
      .insert(agentSessionEvents)
      .values({
        sessionId,
        type: "session.status",
        payload: { status, message: statusMessage },
      })
      .returning({
        id: agentSessionEvents.id,
        type: agentSessionEvents.type,
        messageId: agentSessionEvents.messageId,
        payload: agentSessionEvents.payload,
        createdAt: agentSessionEvents.createdAt,
      }),
  ]);

  const session = sessionRows[0];
  const statusEvent = statusEventRows[0];
  if (!session || !statusEvent) {
    throw new Error("Failed to create agent session.");
  }

  return { session, statusEvent };
}

async function insertAgentSessionWithUserMessage(input: {
  agent: Agent;
  title: string;
  userId: string;
  workspaceId: string;
  modelName: string;
  content: string;
  attachments?: SubmitAttachmentInput[];
}) {
  const db = getDb();
  const sessionId = newAgentSessionId();
  const messageId = newAgentSessionMessageId();
  const now = new Date();
  const engine = normalizeAgentConfig(input.agent.config).engine;
  const payload = { messageId, role: "user", content: input.content, status: "completed" };
  const attachmentRows = buildAttachmentRows({
    messageId,
    sessionId,
    workspaceId: input.workspaceId,
    attachments: input.attachments ?? [],
  });

  // db.batch is variadic-tuple typed, so a conditionally-pushed op fights the result-tuple
  // inference. Branch into two explicit batch literals (with/without the attachment insert).
  const sessionInsert = db
    .insert(agentSessions)
    .values({
      id: sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agent.id,
      title: input.title,
      engine,
      modelProvider: input.agent.config.model.provider,
      modelName: input.modelName,
    })
    .returning();
  const statusEventInsert = db
    .insert(agentSessionEvents)
    .values({
      sessionId,
      type: "session.status",
      payload: { status: "created", message: "Session created" },
    })
    .returning({
      id: agentSessionEvents.id,
      type: agentSessionEvents.type,
      messageId: agentSessionEvents.messageId,
      payload: agentSessionEvents.payload,
      createdAt: agentSessionEvents.createdAt,
    });
  const messageInsert = db
    .insert(agentSessionMessages)
    .values({
      id: messageId,
      sessionId,
      role: "user",
      status: "completed",
      content: input.content,
      modelMessage: { role: "user", content: input.content },
      completedAt: now,
    })
    .returning();
  const createdEventInsert = db
    .insert(agentSessionEvents)
    .values({ sessionId, messageId, type: "message.created", payload })
    .returning({ id: agentSessionEvents.id, createdAt: agentSessionEvents.createdAt });

  const [sessionRows, statusEventRows, messageRows, createdEventRows] =
    attachmentRows.length > 0
      ? await db.batch([
          sessionInsert,
          statusEventInsert,
          messageInsert,
          createdEventInsert,
          db.insert(agentSessionMessageAttachments).values(attachmentRows).returning(),
        ])
      : await db.batch([sessionInsert, statusEventInsert, messageInsert, createdEventInsert]);

  const session = sessionRows[0];
  const statusEvent = statusEventRows[0];
  const message = messageRows[0];
  const createdEventRow = createdEventRows[0];
  if (!session || !statusEvent || !message || !createdEventRow) {
    throw new Error("Failed to create agent session with user message.");
  }

  await appendSessionStreamEvent(sessionId, {
    id: createdEventRow.id,
    type: "message.created",
    messageId,
    payload,
    createdAt: createdEventRow.createdAt.toISOString(),
  });

  return {
    session,
    statusEvent,
    message,
    createdEvent: {
      id: createdEventRow.id,
      type: "message.created" as const,
      messageId,
      payload,
      createdAt: createdEventRow.createdAt,
    },
    // Client-safe attachment metadata for the synthesized detail so the destination session paints
    // the image on first render (served via /api/attachments — the rows above already persisted).
    attachments: attachmentRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      mediaType: row.mediaType,
      filename: row.filename,
    })),
  };
}

async function insertUserMessage(
  sessionId: string,
  content: string,
  options: {
    workspaceId: string;
    attachments: SubmitAttachmentInput[];
    modelContent?: string;
    sendMode?: SendMode | null;
  },
) {
  const db = getDb();
  const messageId = newAgentSessionMessageId();
  const sendMode = options.sendMode ?? null;
  const payload = { messageId, role: "user", content, status: "completed", sendMode };

  // The model message stays TEXT-ONLY — attachment bytes never touch Postgres. The
  // attachment rows here only persist metadata + the private-blob pointers; the runner
  // hydrates the bytes from Blob at run time. `modelContent` lets a caller send the model a
  // richer prompt than the user-visible `content` (e.g. the interrupted-session continuation).
  const modelContent = options.modelContent ?? content;
  const attachmentRows = buildAttachmentRows({
    messageId,
    sessionId,
    workspaceId: options.workspaceId,
    attachments: options.attachments,
  });

  const messageInsert = db
    .insert(agentSessionMessages)
    .values({
      id: messageId,
      sessionId,
      role: "user",
      status: "completed",
      content,
      sendMode,
      modelMessage: { role: "user", content: modelContent },
      completedAt: new Date(),
    })
    .returning();
  const eventInsert = db
    .insert(agentSessionEvents)
    .values({ sessionId, messageId, type: "message.created", payload })
    .returning({ id: agentSessionEvents.id, createdAt: agentSessionEvents.createdAt });

  // db.batch is variadic-tuple typed, so a conditionally-pushed op fights the result-tuple
  // inference. Branch into two explicit batch literals instead of casting.
  const [messageRows, eventRows] =
    attachmentRows.length > 0
      ? await db.batch([
          messageInsert,
          eventInsert,
          db.insert(agentSessionMessageAttachments).values(attachmentRows).returning(),
        ])
      : await db.batch([messageInsert, eventInsert]);

  const message = messageRows[0];
  const eventRow = eventRows[0];
  if (!message || !eventRow) {
    throw new Error("Failed to insert user message.");
  }

  // Mirror the user message onto the session's Durable Stream so it appears in a
  // stream-sourced transcript (the runner never re-emits web-written events).
  // Best-effort.
  await appendSessionStreamEvent(sessionId, {
    id: eventRow.id,
    type: "message.created",
    messageId,
    payload,
    createdAt: eventRow.createdAt.toISOString(),
  });

  return {
    message,
    createdEvent: {
      id: eventRow.id,
      type: "message.created" as const,
      messageId,
      payload,
      createdAt: eventRow.createdAt,
    },
  };
}

// Compose the model-only first message for an onboarding session: the user's task, then the
// background context they gave on the first screen (only the fields they filled in), then the thin
// pointer that tells the agent to run its onboarding skill before tackling the task. None of the
// appended context renders in the transcript — it rides in modelMessage only.
function buildOnboardingModelContent(
  prompt: string,
  context: PersonalOnboardingContext,
  options: PersonalOnboardingOptions = { integrations: [] },
) {
  const facts = [
    context.name.trim() ? `- Name: ${context.name.trim()}` : null,
    context.role.trim() ? `- Role: ${context.role.trim()}` : null,
    context.website.trim() ? `- Website: ${context.website.trim()}` : null,
    context.teamSize?.trim() ? `- Team size: ${context.teamSize.trim()}` : null,
    context.agentExperience?.trim()
      ? `- Experience with agents: ${context.agentExperience.trim()}`
      : null,
    options.setup ? `- Chosen setup: ${options.setup.title} — ${options.setup.intent}` : null,
    options.integrations.length
      ? `- Integrations I enabled: ${options.integrations.join(", ")}`
      : null,
  ].filter(Boolean);

  const contextBlock = facts.length
    ? `\n\nFirst-session background (I gave this during onboarding, not in chat):\n${facts.join("\n")}`
    : "";

  return `${prompt}${contextBlock}\n\n(This is my very first session. Read your \`onboarding\` skill with read_skill and follow it — get set up first, then take on what I asked above.)`;
}

function titleFromPrompt(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? "Untitled session";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

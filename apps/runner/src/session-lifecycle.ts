import {
  type AgentConfig,
  normalizeAgentConfig,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import { DEFAULT_SANDBOX_RESOURCES, type SandboxResourceConfig } from "@opencompany/billing";
import {
  agentSessionAfterSessionRuns,
  agentSessionEvents,
  agentSessionMessages,
  agentSessionQuestions,
  agentSessions,
  agents,
  agentToolApprovals,
  users,
  workspaceRepositories,
  workspaces,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, desc, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { abortActiveRun } from "./active-runs";
import { materializeAgentBundleForSession } from "./agent-bundle";
import { materializeBrainForSession } from "./brain";
import { getDb } from "./db";
import { closeSessionStream } from "./durable-streams";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import {
  armSandboxIdleTimeout,
  createOrConnectSandbox,
  killSandbox,
  prepareWorkspace,
  type SandboxHandle,
  sandboxPreparationErrorFields,
} from "./sandbox";
import { materializeSkillsForSession } from "./skills";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export async function ensureSandbox(row: LoadedSession, env: RunnerEnv) {
  let sandbox: SandboxHandle | null = null;
  const agentConfig = normalizeAgentConfig(row.agent.config);
  try {
    sandbox = await createOrConnectSandbox({
      sandboxId: row.session.e2bSandboxId,
      template: resolveSandboxTemplate(agentConfig, env),
      envs: {
        E2B_API_KEY: env.e2bApiKey,
        VERCEL_AI_GATEWAY_API_KEY: env.vercelAiGatewayApiKey,
      },
      idleTimeoutMs: env.e2bSandboxIdleTimeoutMs,
    });
    await prepareWorkspace({
      sandbox,
      workdir: row.session.workdir,
      agentFile: serializeAgentFile({
        title: agentConfig.title,
        body: agentConfig.instructions,
        model: agentConfig.model.name,
        tools: agentConfig.tools,
        brain: agentConfig.brain,
        integrations: agentConfig.integrations,
        triggers: agentConfig.triggers,
      }),
    });
    await materializeBrainForSession({
      sandbox,
      sessionId: row.session.id,
      workspaceId: row.workspace.id,
      workdir: row.session.workdir,
      references: agentConfig.brain,
    });
    await materializeAgentBundleForSession({
      sandbox,
      sessionId: row.session.id,
      workspaceId: row.workspace.id,
      agentId: row.agent.id,
      workdir: row.session.workdir,
    });
    await materializeSkillsForSession({
      sandbox,
      workdir: row.session.workdir,
      config: agentConfig,
    });
    return sandbox;
  } catch (error) {
    captureException(error, {
      event: "opencompany.runner_sandbox_failed",
      workspace_id: row.workspace.id,
      user_id: row.session.userId,
      agent_id: row.agent.id,
      session_id: row.session.id,
      sandbox_id: sandbox?.sandboxId ?? row.session.e2bSandboxId,
      existing_sandbox: Boolean(row.session.e2bSandboxId),
      ...sandboxPreparationErrorFields(error),
    });
    if (sandbox) {
      await parkSandboxWhenIdle(sandbox, env);
    }
    throw error;
  }
}

// The richer sandbox template (with git, gh, and the coding-agent CLIs installed)
// is used whenever the agent has at least one GitHub repository attached or a
// coding-agent tool enabled; plain chat agents get the lighter default template.
function resolveSandboxTemplate(agentConfig: AgentConfig, env: RunnerEnv) {
  const needsCodingTemplate =
    agentConfig.integrations.github.repositories.length > 0 ||
    agentConfig.tools.some((tool) => tool.id === "amp" || tool.id === "opencode");
  return needsCodingTemplate ? (env.ampE2bTemplate ?? "amp") : env.e2bTemplate;
}

// Per-template resource overrides used to price sandbox compute. Both current templates
// run on E2B's base allocation; add an entry here if a template is ever provisioned with
// a custom vCPU/RAM size so billing tracks the real allocation.
const SANDBOX_TEMPLATE_RESOURCES: Record<string, SandboxResourceConfig> = {};

export type SandboxBillingInfo = {
  template: string | null;
  vcpu: number;
  ramMib: number;
};

// Resolve the template + resource allocation a session's sandbox runs on, for billing.
// Deterministic from the session row + env, so the run lifecycle can compute it without
// touching E2B.
export function resolveSandboxBilling(row: LoadedSession, env: RunnerEnv): SandboxBillingInfo {
  const agentConfig = normalizeAgentConfig(row.agent.config);
  const template = resolveSandboxTemplate(agentConfig, env) ?? null;
  const resources =
    (template ? SANDBOX_TEMPLATE_RESOURCES[template] : undefined) ?? DEFAULT_SANDBOX_RESOURCES;
  return { template, vcpu: resources.vcpu, ramMib: resources.ramMiB };
}

export async function parkSandboxWhenIdle(sandbox: SandboxHandle, env: RunnerEnv) {
  try {
    const armed = await armSandboxIdleTimeout(sandbox, env.e2bSandboxIdleTimeoutMs);
    if (!armed) {
      logger.warn("E2B sandbox was gone before idle timeout could be armed", {
        sandbox_id: sandbox.sandboxId,
      });
    }
  } catch (error) {
    logger.warn("Failed to arm E2B sandbox idle timeout", {
      sandbox_id: sandbox.sandboxId,
      error,
    });
  }
}

export async function loadSession(sessionId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      session: agentSessions,
      agent: agents,
      workspace: workspaces,
      user: users,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .innerJoin(users, eq(agentSessions.userId, users.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const [repository] = await db
    .select()
    .from(workspaceRepositories)
    .where(eq(workspaceRepositories.workspaceId, row.workspace.id))
    .limit(1);

  return { ...row, repository: repository ?? null };
}

export function optionalUserContext(
  user: Pick<typeof users.$inferSelect, "email" | "firstName" | "lastName">,
) {
  const userName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return {
    ...(userName ? { userName } : {}),
    ...(user.firstName ? { userFirstName: user.firstName } : {}),
    ...(user.lastName ? { userLastName: user.lastName } : {}),
    ...(user.email ? { userEmail: user.email } : {}),
  };
}

export type LoadedSession = Awaited<ReturnType<typeof loadSession>>;

export async function loadUserMessage(sessionId: string, messageId: string) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id, createdAt: agentSessionMessages.createdAt })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.id, messageId),
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .limit(1);

  return message ?? null;
}

// The oldest non-internal user message created after `afterCreatedAt` that no
// assistant message has responded to yet. This is how a turn detects a steering
// message the user sent while a run was already in flight. See
// docs/agent-turn-vocabulary.md.
export async function loadNextSteerMessage(input: { sessionId: string; afterCreatedAt: Date }) {
  const responses = alias(agentSessionMessages, "steer_responses");
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      createdAt: agentSessionMessages.createdAt,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, input.sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
        gt(agentSessionMessages.createdAt, input.afterCreatedAt),
        notExists(
          getDb()
            .select({ value: sql`1` })
            .from(responses)
            .where(
              and(
                eq(responses.sessionId, input.sessionId),
                eq(responses.responseToMessageId, agentSessionMessages.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

export async function loadLatestUserMessage(sessionId: string) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .orderBy(desc(agentSessionMessages.createdAt))
    .limit(1);

  return message ?? null;
}

export async function loadAssistantResponseForMessage(sessionId: string, messageId: string) {
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      status: agentSessionMessages.status,
      content: agentSessionMessages.content,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.responseToMessageId, messageId),
      ),
    )
    .limit(1);

  return message ?? null;
}

export async function createAfterSessionRun(input: {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  lastUserMessageId: string;
  agentVersion: number;
  runLeaseId: string;
}) {
  const [run] = await getDb()
    .insert(agentSessionAfterSessionRuns)
    .values({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      lastUserMessageId: input.lastUserMessageId,
      agentVersion: input.agentVersion,
      status: "running",
      runLeaseId: input.runLeaseId,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        agentSessionAfterSessionRuns.sessionId,
        agentSessionAfterSessionRuns.lastUserMessageId,
        agentSessionAfterSessionRuns.agentVersion,
      ],
    })
    .returning({ id: agentSessionAfterSessionRuns.id });

  return run ?? null;
}

export async function completeAfterSessionRun(
  id: number,
  input: { status: "completed" | "skipped" | "failed"; skippedReason?: string; lastError?: string },
) {
  await getDb()
    .update(agentSessionAfterSessionRuns)
    .set({
      status: input.status,
      skippedReason: input.skippedReason ?? null,
      lastError: input.lastError ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentSessionAfterSessionRuns.id, id));
}

export async function appendAfterSessionSkipped(input: {
  sessionId: string;
  messageId: string;
  reason: string;
}) {
  await appendRuntimeEvent(getDb(), {
    sessionId: input.sessionId,
    type: "after_session.skipped",
    payload: { messageId: input.messageId, reason: input.reason },
  });
}

export function buildAfterSessionPrompt(input: { prompt: string }) {
  return `After-session instructions:\n${input.prompt}`;
}

export async function setStatus(sessionId: string, status: "provisioning" | "ready" | "completed") {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        isNull(agentSessions.archivedAt),
        isNull(agentSessions.runLeaseId),
      ),
    )
    .returning({ id: agentSessions.id });

  return Boolean(updated);
}

export async function isSessionArchived(sessionId: string) {
  const [session] = await getDb()
    .select({ archivedAt: agentSessions.archivedAt })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return Boolean(session?.archivedAt);
}

export async function startSession(sessionId: string, env: RunnerEnv) {
  const db = getDb();
  const row = await loadSession(sessionId);
  if (row.session.archivedAt) return;

  if (!(await setStatus(sessionId, "provisioning"))) return;
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "provisioning", message: "Starting sandbox" },
  });

  const sandbox = await ensureSandbox(row, env);
  const [updated] = await db
    .update(agentSessions)
    .set({
      e2bSandboxId: sandbox.sandboxId,
      status: "ready",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        isNull(agentSessions.archivedAt),
        isNull(agentSessions.runLeaseId),
      ),
    )
    .returning({ id: agentSessions.id });
  if (!updated) {
    await killSandbox(sandbox.sandboxId);
    return;
  }

  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "ready", message: "Sandbox ready" },
  });
  logger.info("Runner session ready", {
    event: "opencompany.runner_session_ready",
    workspace_id: row.workspace.id,
    user_id: row.session.userId,
    agent_id: row.agent.id,
    session_id: sessionId,
    sandbox_id: sandbox.sandboxId,
  });
  await parkSandboxWhenIdle(sandbox, env);
}

export async function abortSession(sessionId: string) {
  const db = getDb();
  const [updated] = await db
    .update(agentSessions)
    .set({
      status: "aborting",
      abortRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.archivedAt)))
    .returning({ id: agentSessions.id });
  if (!updated) return;

  abortActiveRun(sessionId);
  // If the session was paused at an "ask" gate there is no active run to abort, and a
  // still-pending approval would later be swept (auto-denied) and resumed — reviving an
  // aborted session. Deny any pending approvals now so no resume can fire. The dangling
  // tool-call in the suspended assistant message is dropped by buildModelMessages, so the
  // history stays valid for any future turn.
  await db
    .update(agentToolApprovals)
    .set({
      status: "denied",
      decisionSource: "abort",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentToolApprovals.sessionId, sessionId), eq(agentToolApprovals.status, "pending")),
    );
  // Same hazard for a session paused on an ask_user_question: cancel any pending question so the
  // backstop can't revive the aborted session via a question resume.
  const cancelledQuestions = await db
    .update(agentSessionQuestions)
    .set({
      status: "cancelled",
      resolutionSource: "abort",
      answeredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionQuestions.sessionId, sessionId),
        eq(agentSessionQuestions.status, "pending"),
      ),
    )
    .returning({
      toolCallId: agentSessionQuestions.toolCallId,
      messageId: agentSessionQuestions.messageId,
    });
  // The web reducer only moves a question card out of its interactive `pending` state on a
  // `question.answered` event, so without this the aborted session would keep rendering a live
  // question card. Emit the resolution event the resume path would have produced.
  for (const question of cancelledQuestions) {
    const messageId = question.messageId ?? "";
    await appendRuntimeEvent(db, {
      sessionId,
      messageId,
      type: "question.answered",
      payload: {
        messageId,
        toolCallId: question.toolCallId,
        answered: false,
        answers: [],
        resolutionSource: "abort",
      },
    });
  }
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "aborting", message: "Abort requested" },
  });
  logger.info("Runner session abort requested", {
    event: "opencompany.runner_session_abort_requested",
    session_id: sessionId,
  });
}

export async function archiveSession(sessionId: string) {
  const db = getDb();
  abortActiveRun(sessionId);

  const [session] = await db
    .select({
      id: agentSessions.id,
      e2bSandboxId: agentSessions.e2bSandboxId,
      archivedAt: agentSessions.archivedAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.archivedAt) return;

  const previousSandboxId = session.e2bSandboxId;
  const sandboxKilled = previousSandboxId ? await killSandbox(previousSandboxId) : false;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
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
      .where(eq(agentSessions.id, sessionId));
    await tx.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "archived", message: "Session archived" },
    });
    await tx.insert(agentSessionEvents).values({
      sessionId,
      type: "session.archived",
      payload: {
        sandboxId: previousSandboxId,
        sandboxKilled,
        sandboxAlreadyStopped: previousSandboxId === null || !sandboxKilled,
      },
    });
  });

  // The session is permanently archived — no future turn can append, so this is the
  // one provably-safe point to close the Durable Stream (EOF). Best-effort; Postgres
  // remains the system of record.
  await closeSessionStream(sessionId);
}

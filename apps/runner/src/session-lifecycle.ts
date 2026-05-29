import {
  type AgentConfig,
  normalizeAgentConfig,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionAfterSessionRuns,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
  users,
  workspaceRepositories,
  workspaces,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, desc, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { abortActiveRun } from "./active-runs";
import { loadGitHubWorkRepository } from "./amp-tool";
import { materializeBrainForSession } from "./brain";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { getGitHubWorkInstallationToken } from "./github";
import {
  armSandboxIdleTimeout,
  createOrConnectSandbox,
  killSandbox,
  prepareWorkspace,
  type SandboxHandle,
  sandboxPreparationErrorFields,
} from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export async function ensureSandbox(row: LoadedSession, env: RunnerEnv) {
  let sandbox: SandboxHandle | null = null;
  let sessionRepository: ReturnType<typeof resolveSessionRepository> = null;
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
    sessionRepository = resolveSessionRepository(agentConfig);
    const githubToken = await resolveGitHubToken(row, sessionRepository);
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
      repositoryFullName: sessionRepository?.fullName,
      repositoryDefaultBranch: sessionRepository?.defaultBranch,
      githubToken,
    });
    await materializeBrainForSession({
      sandbox,
      sessionId: row.session.id,
      workspaceId: row.workspace.id,
      workdir: row.session.workdir,
      references: agentConfig.brain,
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
      repository_full_name: sessionRepository?.fullName,
      repository_default_branch: sessionRepository?.defaultBranch,
      ...sandboxPreparationErrorFields(error),
    });
    if (sandbox) {
      await parkSandboxWhenIdle(sandbox, env);
    }
    throw error;
  }
}

function resolveSandboxTemplate(agentConfig: AgentConfig, env: RunnerEnv) {
  return agentConfig.tools.some(
    (tool) => tool.id === "amp" && typeof tool.repository === "string" && tool.repository,
  )
    ? (env.ampE2bTemplate ?? "amp")
    : env.e2bTemplate;
}

function resolveSessionRepository(agentConfig: AgentConfig) {
  const ampTool = agentConfig.tools.find((tool) => tool.id === "amp");
  if (!ampTool || ampTool.id !== "amp" || !ampTool.repository) return null;
  return (
    agentConfig.integrations.github.repositories.find(
      (repository) => repository.id === ampTool.repository,
    ) ?? null
  );
}

async function resolveGitHubToken(
  row: LoadedSession,
  sessionRepository: ReturnType<typeof resolveSessionRepository>,
) {
  if (!sessionRepository) return null;

  const integrationRepository = await loadGitHubWorkRepository(row.workspace.id, sessionRepository);
  return getGitHubWorkInstallationToken({
    installationId: integrationRepository.installationId,
    repositoryFullName: sessionRepository.fullName,
  });
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

export function optionalUserName(user: Pick<typeof users.$inferSelect, "firstName" | "lastName">) {
  const userName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return userName ? { userName } : {};
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
        sandboxKilled,
        sandboxAlreadyStopped: previousSandboxId === null || !sandboxKilled,
      },
    }),
  ]);
}

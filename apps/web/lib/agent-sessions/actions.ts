"use server";

import {
  newAgentSessionId,
  newAgentSessionMessageId,
  parseAgentFile,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import {
  type Agent,
  agentSessionArtifacts,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSyncJobs,
  agents,
  brainFiles,
} from "@opencompany/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
  OPENCOMPANY_CONFIG_PROPOSAL_KIND,
  type OpenCompanyConfigProposal,
  type OpenCompanyConfigProposalChange,
  parseOpenCompanyConfigProposal,
  proposalMetadata,
} from "@/lib/agent-sessions/config-proposals";
import { loadAgentSessionDetailForWorkspace } from "@/lib/agent-sessions/data";
import {
  dispatchAgentAfterSessionCheck,
  dispatchAgentSessionAbortRequested,
  dispatchAgentSessionStarted,
} from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";
import { sidebarSessionFromDetail } from "@/lib/agent-sessions/payload";
import { callRunner, getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import {
  logAgentSyncJobQueued,
  newAgentId,
  nextAvailableAgentPath,
  prepareAgentSyncJobUpsert,
  scheduleAgentSyncDispatch,
} from "@/lib/agents/create";
import { hashAgentSource } from "@/lib/agents/hash";
import { resolveAgentSyncRename } from "@/lib/agents/sync-job";
import { currentWorkspace } from "@/lib/auth";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";
import { brainSyncJobUpsert } from "@/lib/brain/jobs";
import { isBrainTextFile, MAX_BRAIN_FILE_BYTES, normalizeBrainPath } from "@/lib/brain/paths";
import { dispatchBrainSyncRequested } from "@/lib/brain/sync-events";

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

  await captureServerEvent("session_started", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
    session_id: sessionId,
    model_provider: agent.config.model.provider,
    model_name: agent.config.model.name,
    source: "agent",
  });

  after(async () => {
    await dispatchAgentSessionStarted({ sessionId, workspaceId: workspace.id });
  });

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

  await captureServerEvent("session_started", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
    session_id: sessionId,
    model_provider: agent.config.model.provider,
    model_name: agent.config.model.name,
    source: "prompt",
  });
  await captureServerEvent("session_message_sent", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
    session_id: sessionId,
    message_id: messageId,
    is_initial_message: true,
    message_length: trimmed.length,
  });

  after(async () => {
    await triggerAgentMessageRun({ sessionId, messageId, workspaceId: workspace.id });
    await dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id });
  });

  return loadCreatedSessionResult(sessionId, user.id, workspace.id);
}

export async function submitAgentSessionMessage(sessionId: string, content: string) {
  const { user, workspace } = await currentWorkspace();
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, error: "Message is required." } as const;
  }
  if (!(await hasPositiveWorkspaceBalance({ db: getDb(), workspaceId: workspace.id }))) {
    return { ok: false, error: "Add workspace credits to continue this session." } as const;
  }

  const db = getDb();
  const [session] = await db
    .select({ id: agentSessions.id, agentId: agentSessions.agentId })
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

  await captureServerEvent("session_message_sent", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: session.agentId,
    session_id: sessionId,
    message_id: messageId,
    is_initial_message: false,
    message_length: trimmed.length,
  });

  after(async () => {
    await triggerAgentMessageRun({ sessionId, messageId, workspaceId: workspace.id });
    await dispatchAgentAfterSessionCheck({ sessionId, messageId, workspaceId: workspace.id });
  });

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
    await archiveSessionLocally(sessionId, null);
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

  return { ok: true } as const;
}

export async function applyOpenCompanyConfigProposal(proposalId: number) {
  const { user, workspace } = await currentWorkspace();
  const loaded = await loadProposalForCurrentUser(proposalId, user.id, workspace.id);
  if (!loaded) return { ok: false, error: "Proposal not found." } as const;
  if (loaded.proposal.status !== "pending") {
    return { ok: false, error: "Proposal is no longer pending." } as const;
  }

  try {
    for (const change of loaded.proposal.changes) {
      if (change.targetType === "agent") {
        await applyAgentProposalChange(workspace.id, change);
      } else {
        await applyBrainProposalChange(workspace.id, change);
      }
    }
    await updateProposalStatus(loaded.proposal, "applied");
    revalidatePath("/agents");
    revalidatePath("/brain");
    return { ok: true } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not apply proposal.";
    await updateProposalStatus(loaded.proposal, "failed", message);
    return { ok: false, error: message } as const;
  }
}

export async function dismissOpenCompanyConfigProposal(proposalId: number) {
  const { user, workspace } = await currentWorkspace();
  const loaded = await loadProposalForCurrentUser(proposalId, user.id, workspace.id);
  if (!loaded) return { ok: false, error: "Proposal not found." } as const;
  if (loaded.proposal.status !== "pending") {
    return { ok: false, error: "Proposal is no longer pending." } as const;
  }

  await updateProposalStatus(loaded.proposal, "dismissed");
  return { ok: true } as const;
}

async function loadProposalForCurrentUser(proposalId: number, userId: string, workspaceId: string) {
  const [row] = await getDb()
    .select({
      artifact: agentSessionArtifacts,
      session: agentSessions,
    })
    .from(agentSessionArtifacts)
    .innerJoin(agentSessions, eq(agentSessionArtifacts.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessionArtifacts.id, proposalId),
        eq(agentSessionArtifacts.kind, OPENCOMPANY_CONFIG_PROPOSAL_KIND),
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.userId, userId),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  const proposal = parseOpenCompanyConfigProposal({
    id: row.artifact.id,
    sessionId: row.artifact.sessionId,
    messageId: row.artifact.messageId,
    toolCallId: row.artifact.toolCallId,
    title: row.artifact.title,
    metadata: row.artifact.metadata ?? null,
    createdAt: row.artifact.createdAt,
  });
  return proposal ? { proposal, session: row.session } : null;
}

async function updateProposalStatus(
  proposal: OpenCompanyConfigProposal,
  status: OpenCompanyConfigProposal["status"],
  error: string | null = null,
) {
  await getDb()
    .update(agentSessionArtifacts)
    .set({
      metadata: proposalMetadata({
        status,
        summary: proposal.summary,
        changes: proposal.changes,
        error,
      }),
    })
    .where(eq(agentSessionArtifacts.id, proposal.id));
}

async function applyAgentProposalChange(
  workspaceId: string,
  change: Extract<OpenCompanyConfigProposalChange, { targetType: "agent" }>,
) {
  const parsed = parseAgentFile(change.source);
  const source = serializeAgentFile({
    title: parsed.title,
    body: parsed.body,
    model: parsed.config.model.name,
    tools: parsed.config.tools,
    brain: parsed.config.brain,
    skills: parsed.config.skills,
    integrations: parsed.config.integrations,
    triggers: parsed.config.triggers,
  });
  const contentHash = hashAgentSource(source);
  const db = getDb();

  if (change.operation === "update") {
    const [existing] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          change.id && change.path
            ? or(eq(agents.id, change.id), eq(agents.path, change.path))
            : change.id
              ? eq(agents.id, change.id)
              : eq(agents.path, change.path ?? ""),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Agent no longer exists.");
    if (change.previousHash && existing.contentHash !== change.previousHash) {
      throw new Error("Agent changed after this proposal was created.");
    }

    const path = await nextAvailableAgentPath(db, workspaceId, parsed.title, existing.path);
    const version = existing.version + 1;
    const [existingSyncJob] = await db
      .select({
        previousPath: agentSyncJobs.previousPath,
        previousBlobSha: agentSyncJobs.previousBlobSha,
      })
      .from(agentSyncJobs)
      .where(eq(agentSyncJobs.agentId, existing.id))
      .limit(1);
    const rename = resolveAgentSyncRename({
      existingPreviousPath: existingSyncJob?.previousPath,
      existingPreviousBlobSha: existingSyncJob?.previousBlobSha,
      renamePreviousPath: existing.path && existing.path !== path ? existing.path : null,
      renamePreviousBlobSha:
        existing.path && existing.path !== path ? existing.githubBlobSha : null,
    });
    const syncJob = prepareAgentSyncJobUpsert(db, {
      agentId: existing.id,
      workspaceId,
      path,
      desiredHash: contentHash,
      desiredVersion: version,
      previousPath: rename.previousPath,
      previousBlobSha: rename.previousBlobSha,
    });
    await db.batch([
      db
        .update(agents)
        .set({
          path,
          name: parsed.title,
          body: parsed.body,
          contentHash,
          version,
          config: parsed.config,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, existing.id), eq(agents.workspaceId, workspaceId))),
      syncJob.query,
    ]);
    logAgentSyncJobQueued(syncJob.metadata);
    scheduleAgentSyncDispatch({ id: existing.id, workspaceId, path });
    return;
  }

  const [existingByTitle] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, parsed.title)))
    .limit(1);
  if (existingByTitle) {
    throw new Error("Agent already exists. Create a new proposal as an update.");
  }

  const id = newAgentId();
  const path = change.path ?? (await nextAvailableAgentPath(db, workspaceId, parsed.title));
  const [existingByPath] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.path, path)))
    .limit(1);
  if (existingByPath) {
    throw new Error("Agent already exists. Create a new proposal as an update.");
  }

  const syncJob = prepareAgentSyncJobUpsert(db, {
    agentId: id,
    workspaceId,
    path,
    desiredHash: contentHash,
    desiredVersion: 1,
    previousPath: null,
    previousBlobSha: null,
  });
  await db.batch([
    db.insert(agents).values({
      id,
      workspaceId,
      path,
      name: parsed.title,
      body: parsed.body,
      contentHash,
      version: 1,
      config: parsed.config,
      githubSyncStatus: "pending",
    }),
    syncJob.query,
  ]);
  logAgentSyncJobQueued(syncJob.metadata);
  scheduleAgentSyncDispatch({ id, workspaceId, path });
}

async function applyBrainProposalChange(
  workspaceId: string,
  change: Extract<OpenCompanyConfigProposalChange, { targetType: "brain" }>,
) {
  const path = normalizeBrainPath(change.path);
  if (!isBrainTextFile(path)) throw new Error("Only text Brain files are supported.");
  const sizeBytes = brainContentSize(change.content);
  if (sizeBytes > MAX_BRAIN_FILE_BYTES) throw new Error("Brain files must be 256 KB or smaller.");

  const db = getDb();
  const [existing] = await db
    .select()
    .from(brainFiles)
    .where(and(eq(brainFiles.workspaceId, workspaceId), eq(brainFiles.path, path)))
    .limit(1);
  if (change.operation === "update" && !existing) throw new Error("Brain file no longer exists.");
  if (change.operation === "create" && existing) throw new Error("Brain file already exists.");
  if (change.previousHash && existing?.contentHash !== change.previousHash) {
    throw new Error("Brain file changed after this proposal was created.");
  }

  const contentHash = hashBrainContent(change.content);
  await db.batch([
    db
      .insert(brainFiles)
      .values({
        workspaceId,
        path,
        content: change.content,
        contentHash,
        sizeBytes,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [brainFiles.workspaceId, brainFiles.path],
        set: {
          content: change.content,
          contentHash,
          sizeBytes,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: new Date(),
        },
      }),
    brainSyncJobUpsert(db, {
      workspaceId,
      path,
      operation: "upsert",
      desiredHash: contentHash,
    }),
  ]);
  after(async () => {
    await dispatchBrainSyncRequested({ workspaceId, path });
  });
}

async function loadCreatedSessionResult(sessionId: string, userId: string, workspaceId: string) {
  const detail = await loadAgentSessionDetailForWorkspace(sessionId, userId, workspaceId);
  if (!detail) {
    return { ok: false, error: "Session was created but could not be loaded." } as const;
  }

  return { ok: true, session: sidebarSessionFromDetail(detail), detail } as const;
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

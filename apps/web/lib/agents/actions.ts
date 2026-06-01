"use server";

import {
  type AgentConfigPatch,
  agentBundleDir,
  collectBodyRepositoryMentions,
  deriveAgentConfigFromBody,
  normalizeAgentBody,
  parseAgentFile,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import type { AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import {
  agentFileSyncJobs,
  agentFiles,
  agentSessions,
  agentSyncJobs,
  agents,
  brainFiles,
  workspaceIntegrationResources,
  workspaceIntegrations,
  workspaceRepositories,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, eq, isNotNull, notInArray, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callRunner, getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import { serializeAgentBundleFiles } from "@/lib/agents/bundle-files";
import {
  derivePreviewConfigFromTiptapDoc,
  extractPreferredGitHubRepositoriesFromTiptapDoc,
} from "@/lib/agents/config";
import {
  buildPendingAgent,
  logAgentSyncJobQueued,
  newAgentId,
  nextAvailableAgentPath,
  prepareAgentSyncJobUpsert,
  scheduleAgentSyncDispatch,
} from "@/lib/agents/create";
import { scheduleAgentFileSyncDispatch } from "@/lib/agents/file-sync-dispatch";
import { hashAgentSource } from "@/lib/agents/hash";
import { randomAgentName } from "@/lib/agents/names";
import {
  buildGitHubRepositoryCatalogs,
  type GitHubIntegrationRepositoryPayload,
  normalizeAgentConfig,
  serializeAgentDetail,
} from "@/lib/agents/payload";
import {
  agentFileSyncJobUpsert,
  prepareAgentBundleFileMoves,
  resolveAgentSyncRename,
} from "@/lib/agents/sync-job";
import { sanitizeTiptapDoc } from "@/lib/agents/tiptap";
import { currentWorkspace } from "@/lib/auth";
import {
  GITHUB_INTEGRATION_PROVIDER,
  GITHUB_REPOSITORY_RESOURCE_TYPE,
} from "@/lib/integrations/service";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import {
  deleteWorkspaceFile,
  ensureWorkspaceRepository,
  listWorkspaceAgentFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace-state/github";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Local copy of the helper used in AgentsView.tsx / AgentDetail.tsx — duplicated
// intentionally to avoid pulling client code into the server module. The shared
// extraction is tracked as a follow-up cleanup.
function isNextRedirectError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest: unknown }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
  );
}

export async function createAgent() {
  const trace = startTimingTrace("agents.create");
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const title = randomAgentName();
  const path = await timeAsync(trace, "db.nextAvailableAgentPath", () =>
    nextAvailableAgentPath(db, workspace.id, title),
  );
  const pending = buildPendingAgent({
    workspaceId: workspace.id,
    title,
    body: "",
    path,
  });
  const syncJob = prepareAgentSyncJobUpsert(db, pending.syncJob);

  await timeAsync(trace, "db.createAgentAndSyncJob", () =>
    db.batch([db.insert(agents).values(pending.agent), syncJob.query]),
  );
  logAgentSyncJobQueued(syncJob.metadata);
  const result = { id: pending.id, workspaceId: workspace.id, path };

  await captureServerEvent("agent_created", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: pending.id,
  });

  revalidatePath("/agents");
  scheduleAgentSyncDispatch({
    id: pending.id,
    workspaceId: workspace.id,
    path,
  });
  endTimingTrace(trace, { path: result.path });
  redirect(`/agents/${result.path}`);
}

export async function updateAgent(
  idOrPath: string,
  patch: {
    name?: string;
    body?: string;
    content?: TiptapDoc;
    model?: AgentModelId;
    config?: AgentConfigPatch;
  },
) {
  const trace = startTimingTrace("agents.update", {
    hasName: typeof patch.name === "string",
    hasBody: typeof patch.body === "string",
    hasModel: typeof patch.model === "string",
    hasConfig: Boolean(patch.config),
  });
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const decodedPath = decodeURIComponent(idOrPath);
  const changedFields: Array<"name" | "body" | "model" | "config"> = [];
  if (typeof patch.name === "string") changedFields.push("name");
  if (typeof patch.body === "string") changedFields.push("body");
  if (patch.content && !changedFields.includes("body")) changedFields.push("body");
  if (typeof patch.model === "string") changedFields.push("model");
  if (patch.config) changedFields.push("config");

  const [agent] = await timeAsync(trace, "db.selectAgent", () =>
    db
      .select({
        id: agents.id,
        path: agents.path,
        name: agents.name,
        body: agents.body,
        content: agents.content,
        config: agents.config,
        version: agents.version,
        githubBlobSha: agents.githubBlobSha,
      })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspace.id),
          or(eq(agents.id, idOrPath), eq(agents.path, decodedPath)),
        ),
      )
      .limit(1),
  );

  if (!agent) {
    endTimingTrace(trace, { found: false });
    return null;
  }

  const currentConfig = normalizeAgentConfig(agent.config);
  const title = patch.name ?? agent.name;
  const path =
    typeof patch.name === "string" || !agent.path
      ? await timeAsync(trace, "db.nextAvailableAgentPath", () =>
          nextAvailableAgentPath(db, workspace.id, title, agent.path),
        )
      : agent.path;
  const previousPath = agent.path;
  const pathChanged = Boolean(previousPath && path !== previousPath);
  const sanitizedContent = patch.content ? sanitizeTiptapDoc(patch.content) : null;
  const githubIntegrationRepositories = await timeAsync(
    trace,
    "db.selectGitHubIntegrationRepositories",
    () =>
      db
        .select({
          fullName: workspaceIntegrationResources.name,
          externalId: workspaceIntegrationResources.externalId,
          displayName: workspaceIntegrationResources.displayName,
          status: workspaceIntegrationResources.status,
          statusReason: workspaceIntegrationResources.statusReason,
          lastSyncedAt: workspaceIntegrationResources.lastSyncedAt,
          metadata: workspaceIntegrationResources.metadata,
          connectionExternalId: workspaceIntegrations.externalId,
          connectionLabel: workspaceIntegrations.connectionLabel,
          accountName: workspaceIntegrations.accountName,
          accountType: workspaceIntegrations.accountType,
          connectionStatus: workspaceIntegrations.status,
        })
        .from(workspaceIntegrationResources)
        .innerJoin(
          workspaceIntegrations,
          eq(workspaceIntegrationResources.integrationId, workspaceIntegrations.id),
        )
        .where(
          and(
            eq(workspaceIntegrationResources.workspaceId, workspace.id),
            eq(workspaceIntegrationResources.provider, GITHUB_INTEGRATION_PROVIDER),
            eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
          ),
        )
        .orderBy(asc(workspaceIntegrationResources.name)),
  );
  const githubRepositories: GitHubIntegrationRepositoryPayload[] =
    githubIntegrationRepositories.map((repository) => ({
      fullName: repository.fullName,
      defaultBranch: readGitHubRepositoryDefaultBranch(repository.metadata),
      status: repository.status,
      statusReason: repository.statusReason,
      lastSyncedAt: repository.lastSyncedAt?.toISOString() ?? null,
      connectionStatus: repository.connectionStatus,
      binding: {
        provider: "github",
        resourceType: "repository",
        externalId: repository.externalId,
        displayName: repository.displayName ?? repository.fullName,
        connection: {
          externalId: repository.connectionExternalId,
          label: repository.connectionLabel ?? repository.accountName ?? "GitHub",
          accountName: repository.accountName,
          accountType: repository.accountType,
        },
      },
    }));
  const workspaceAgentReferences = (
    await timeAsync(trace, "db.selectAgentReferences", () =>
      db
        .select({ path: agents.path, name: agents.name })
        .from(agents)
        .where(eq(agents.workspaceId, workspace.id))
        .orderBy(asc(agents.name)),
    )
  ).flatMap((row) => {
    if (!row.path || row.path === agent.path) return [];
    return [{ path: row.path, name: row.name }];
  });
  const savedRepositories = currentConfig.integrations.github.repositories;
  const { derivationRepositories, usableRepositories } = buildGitHubRepositoryCatalogs({
    repositories: githubRepositories,
    savedRepositories,
  });
  const savedPreferredRepositories = savedRepositories.filter((repository) => repository.binding);
  const preferredRepositories = [
    ...savedPreferredRepositories,
    ...(sanitizedContent
      ? extractPreferredGitHubRepositoriesFromTiptapDoc(sanitizedContent, derivationRepositories)
      : []),
  ];
  const derivedFromTiptap = sanitizedContent
    ? derivePreviewConfigFromTiptapDoc({
        title,
        content: sanitizedContent,
        model: patch.model ?? currentConfig.model.name,
        repositories: derivationRepositories,
        agents: workspaceAgentReferences,
        preferredRepositories: savedPreferredRepositories,
        triggers: currentConfig.triggers,
      })
    : null;
  // The .agent body is the product contract and the source for runtime config.
  // Tiptap JSON is an editor presentation cache; it can lag behind or lose
  // mention attrs, so it must not override body mentions during persisted saves.
  const derived =
    typeof patch.body === "string"
      ? deriveAgentConfigFromBody({
          title,
          body: patch.body,
          model: patch.model ?? currentConfig.model.name,
          repositories: derivationRepositories,
          agents: workspaceAgentReferences,
          preferredRepositories,
          triggers: currentConfig.triggers,
        })
      : derivedFromTiptap;
  warnOnBodyTiptapMismatch({
    agentId: agent.id,
    ...(typeof patch.body === "string" ? { body: patch.body } : {}),
    ...(typeof derivedFromTiptap?.body === "string" ? { tiptapBody: derivedFromTiptap.body } : {}),
  });
  const body = typeof patch.body === "string" ? patch.body : (derived?.body ?? agent.body);
  const model = derived?.config.model.name ?? patch.model ?? currentConfig.model.name;
  const nextIntegrations =
    derived?.config.integrations ?? patch.config?.integrations ?? currentConfig.integrations;
  const nextTools = derived?.config.tools ?? patch.config?.tools ?? currentConfig.tools;
  const nextBrain = derived?.config.brain ?? patch.config?.brain ?? currentConfig.brain;
  const nextAgents = derived?.config.agents ?? patch.config?.agents ?? currentConfig.agents;
  const nextTriggers = derived?.config.triggers ?? patch.config?.triggers ?? currentConfig.triggers;
  const source = serializeAgentFile({
    title,
    body,
    model,
    tools: nextTools,
    brain: nextBrain,
    agents: nextAgents ?? [],
    integrations: nextIntegrations,
    triggers: nextTriggers,
  });
  const parsed = parseAgentFile(source);
  const contentHash = hashAgentSource(source);
  const version = agent.version + 1;
  const [existingSyncJob] = await timeAsync(trace, "db.selectExistingSyncJob", () =>
    db
      .select({
        previousPath: agentSyncJobs.previousPath,
        previousBlobSha: agentSyncJobs.previousBlobSha,
      })
      .from(agentSyncJobs)
      .where(eq(agentSyncJobs.agentId, agent.id))
      .limit(1),
  );
  const rename = resolveAgentSyncRename({
    existingPreviousPath: existingSyncJob?.previousPath,
    existingPreviousBlobSha: existingSyncJob?.previousBlobSha,
    renamePreviousPath: pathChanged ? previousPath : null,
    renamePreviousBlobSha: pathChanged ? agent.githubBlobSha : null,
  });
  const bundleFileMoves =
    pathChanged && previousPath
      ? await timeAsync(trace, "db.prepareAgentBundleFileMoves", async () => {
          const oldBundleDir = agentBundleDir(previousPath);
          const newBundleDir = agentBundleDir(path);
          const [files, existingFileSyncJobs] = await Promise.all([
            db
              .select({
                id: agentFiles.id,
                path: agentFiles.path,
                contentHash: agentFiles.contentHash,
                githubBlobSha: agentFiles.githubBlobSha,
              })
              .from(agentFiles)
              .where(eq(agentFiles.workspaceId, workspace.id)),
            db
              .select({
                path: agentFileSyncJobs.path,
                previousPath: agentFileSyncJobs.previousPath,
                previousBlobSha: agentFileSyncJobs.previousBlobSha,
              })
              .from(agentFileSyncJobs)
              .where(eq(agentFileSyncJobs.workspaceId, workspace.id)),
          ]);

          return prepareAgentBundleFileMoves({
            files,
            existingFileSyncJobs,
            oldBundleDir,
            newBundleDir,
          });
        })
      : [];
  const syncJob = prepareAgentSyncJobUpsert(db, {
    agentId: agent.id,
    workspaceId: workspace.id,
    path,
    desiredHash: contentHash,
    desiredVersion: version,
    previousPath: rename.previousPath,
    previousBlobSha: rename.previousBlobSha,
  });

  const now = new Date();
  await timeAsync(trace, "db.updateAgentAndSyncJob", () =>
    db.batch([
      db
        .update(agents)
        .set({
          path,
          name: parsed.title,
          body: parsed.body,
          ...(sanitizedContent ? { content: sanitizedContent } : {}),
          contentHash,
          version,
          config: parsed.config,
          githubSyncStatus: "pending",
          githubSyncError: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id))),
      ...bundleFileMoves.map((move) =>
        db
          .update(agentFiles)
          .set({
            path: move.path,
            githubBlobSha: null,
            githubCommitSha: null,
            githubSyncedHash: null,
            githubSyncedAt: null,
            githubSyncStatus: "pending",
            githubSyncError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentFiles.id, move.fileId),
              eq(agentFiles.workspaceId, workspace.id),
              eq(agentFiles.path, move.previousPath),
            ),
          ),
      ),
      syncJob.query,
      ...bundleFileMoves.map((move) =>
        agentFileSyncJobUpsert(db, {
          workspaceId: workspace.id,
          path: move.path,
          operation: "upsert",
          desiredHash: move.contentHash,
          previousPath: move.rename.previousPath,
          previousBlobSha: move.rename.previousBlobSha,
        }),
      ),
      ...bundleFileMoves.map((move) =>
        db
          .delete(agentFileSyncJobs)
          .where(
            and(
              eq(agentFileSyncJobs.workspaceId, workspace.id),
              eq(agentFileSyncJobs.path, move.previousPath),
            ),
          ),
      ),
    ]),
  );
  logAgentSyncJobQueued(syncJob.metadata);
  const [[updatedAgent], brainPathRows, bundleFileRows, mcpSettings] = await Promise.all([
    timeAsync(trace, "db.selectUpdatedAgent", () =>
      db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id)))
        .limit(1),
    ),
    timeAsync(trace, "db.selectBrainPaths", () =>
      db
        .select({ path: brainFiles.path })
        .from(brainFiles)
        .where(eq(brainFiles.workspaceId, workspace.id))
        .orderBy(asc(brainFiles.path)),
    ),
    timeAsync(trace, "db.selectAgentBundleFiles", () =>
      db
        .select()
        .from(agentFiles)
        .where(and(eq(agentFiles.workspaceId, workspace.id), eq(agentFiles.agentId, agent.id)))
        .orderBy(asc(agentFiles.path)),
    ),
    loadWorkspaceMcpSettingsForWorkspace(workspace.id),
  ]);
  const brainPaths = brainPathRows.map((row) => row.path);
  const bundleFiles = serializeAgentBundleFiles(path, bundleFileRows);

  if (changedFields.length > 0) {
    await captureServerEvent("agent_saved", user.id, {
      user_id: user.id,
      workspace_id: workspace.id,
      agent_id: agent.id,
      changed_fields: changedFields,
    });
  }

  const result = {
    id: agent.id,
    workspaceId: workspace.id,
    path,
    pathChanged,
    agent: updatedAgent
      ? serializeAgentDetail(
          updatedAgent,
          brainPaths,
          derivationRepositories,
          usableRepositories,
          workspaceAgentReferences,
          {
            mcpEnabled: mcpSettings.mcpEnabled,
            linearConfigured: mcpSettings.linear.configured,
            slackConfigured: mcpSettings.slack.configured,
          },
          bundleFiles,
        )
      : null,
  };

  revalidatePath("/agents");
  revalidatePath(`/agents/${result.path}`);
  if (previousPath) revalidatePath(`/agents/${previousPath}`);
  revalidatePath(`/agents/${result.id}`);
  scheduleAgentSyncDispatch({
    id: agent.id,
    workspaceId: workspace.id,
    path,
  });
  for (const move of bundleFileMoves) {
    scheduleAgentFileSyncDispatch({
      workspaceId: workspace.id,
      path: move.path,
    });
  }
  endTimingTrace(trace, { found: true, path: result.path, pathChanged });
  return result;
}

export async function deleteAgent(
  idOrPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Require admin for destructive operations (matches codebase convention).
  // Route the requireAdmin error through the result shape so Next.js production
  // server-action error masking doesn't replace the message with a generic
  // "Server Components" digest string. NEXT_REDIRECT must still bubble.
  let auth: Awaited<ReturnType<typeof currentWorkspace>>;
  try {
    auth = await currentWorkspace({ requireAdmin: true });
  } catch (err) {
    if (isNextRedirectError(err)) throw err;
    return {
      ok: false,
      error:
        err instanceof Error && err.message
          ? err.message
          : "Only workspace admins can delete agents.",
    } as const;
  }
  const { user, workspace } = auth;
  const trace = startTimingTrace("agents.delete");
  const db = getDb();

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(idOrPath);
  } catch {
    // Guard against malformed percent-encoded identifiers.
    endTimingTrace(trace, { found: false });
    return { ok: false, error: "Invalid agent identifier." };
  }

  const [agent] = await timeAsync(trace, "db.selectAgent", () =>
    db
      .select({
        id: agents.id,
        path: agents.path,
        githubBlobSha: agents.githubBlobSha,
      })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspace.id),
          or(eq(agents.id, idOrPath), eq(agents.path, decodedPath)),
        ),
      )
      .limit(1),
  );

  if (!agent) {
    endTimingTrace(trace, { found: false });
    return { ok: false, error: "Agent not found." };
  }

  // GitHub delete first so a transient failure leaves the agent intact rather
  // than orphaning the .agent file (which the next sync would re-import as a
  // fresh agent). `deleteWorkspaceFile` swallows 404s, so a retry after a
  // partial success is idempotent.
  if (agent.path) {
    const [repository] = await timeAsync(trace, "db.selectWorkspaceRepository", () =>
      db
        .select({
          workspaceId: workspaceRepositories.workspaceId,
          githubRepoId: workspaceRepositories.githubRepoId,
          fullName: workspaceRepositories.fullName,
          defaultBranch: workspaceRepositories.defaultBranch,
          latestHeadSha: workspaceRepositories.latestHeadSha,
          createdAt: workspaceRepositories.createdAt,
          updatedAt: workspaceRepositories.updatedAt,
        })
        .from(workspaceRepositories)
        .where(eq(workspaceRepositories.workspaceId, workspace.id))
        .limit(1),
    );

    if (!repository) {
      logger.warn("No workspace repository found; skipping GitHub file deletion", {
        event: "opencompany.agent_delete_no_repository",
        workspace_id: workspace.id,
        agent_id: agent.id,
        path: agent.path,
      });
    } else {
      try {
        await timeAsync(
          trace,
          "github.deleteWorkspaceFile",
          () =>
            deleteWorkspaceFile({
              db,
              repository,
              path: agent.path!,
              message: `Delete ${agent.path}`,
              blobSha: agent.githubBlobSha,
            }),
          { path: agent.path },
        );
      } catch (err) {
        captureException(err, {
          event: "opencompany.agent_delete_github_failed",
          workspace_id: workspace.id,
          agent_id: agent.id,
          path: agent.path,
        });
        logger.error("Failed to delete agent file from GitHub", {
          event: "opencompany.agent_delete_github_failed",
          workspace_id: workspace.id,
          agent_id: agent.id,
          path: agent.path,
          error: err instanceof Error ? err.message : String(err),
        });
        endTimingTrace(trace, {
          found: true,
          path: agent.path,
          githubDeleted: false,
        });
        return {
          ok: false,
          error:
            "Could not delete the agent from the connected GitHub repository. Please try again.",
        } as const;
      }
    }
  }

  // Archive any live e2b sandboxes for this agent before the cascade removes
  // the session rows. The FK on agent_sessions is ON DELETE CASCADE so the
  // rows go away with the agent — but the external sandboxes keep running
  // (and billing) until E2B's idle TTL. Best-effort: don't block the delete
  // on a stuck sandbox; the TTL is the safety net.
  const liveSessions = await timeAsync(trace, "db.selectLiveSessions", () =>
    db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.agentId, agent.id),
          eq(agentSessions.workspaceId, workspace.id),
          isNotNull(agentSessions.e2bSandboxId),
          notInArray(agentSessions.status, ["archived", "errored"]),
        ),
      ),
  );

  if (liveSessions.length > 0) {
    const runnerConfigured = Boolean(getRunnerPublicUrl() && process.env.RUNNER_INTERNAL_TOKEN);
    for (const session of liveSessions) {
      if (!runnerConfigured) {
        logger.warn("Skipping sandbox archive on agent delete: runner not configured", {
          event: "opencompany.agent_delete_sandbox_skipped",
          workspace_id: workspace.id,
          agent_id: agent.id,
          session_id: session.id,
          reason: "runner_not_configured",
        });
        continue;
      }
      try {
        await callRunner(`/internal/sessions/${session.id}/archive`, {
          workspace_id: workspace.id,
          session_id: session.id,
          event: "opencompany.agent_delete_archive_session",
        });
      } catch (err) {
        captureException(err, {
          event: "opencompany.agent_delete_archive_session_failed",
          workspace_id: workspace.id,
          agent_id: agent.id,
          session_id: session.id,
        });
        logger.error("Failed to archive live sandbox during agent delete", {
          event: "opencompany.agent_delete_archive_session_failed",
          workspace_id: workspace.id,
          agent_id: agent.id,
          session_id: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await timeAsync(trace, "db.deleteAgent", () =>
    db.delete(agents).where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id))),
  );

  await captureServerEvent("agent_deleted", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
  });

  revalidatePath("/agents");
  if (agent.path) revalidatePath(`/agents/${agent.path}`);
  revalidatePath(`/agents/${agent.id}`);
  endTimingTrace(trace, { found: true, path: agent.path });
  return { ok: true };
}

function warnOnBodyTiptapMismatch(input: { agentId: string; body?: string; tiptapBody?: string }) {
  if (process.env.NODE_ENV === "production") return;
  if (typeof input.body !== "string" || typeof input.tiptapBody !== "string") return;

  const body = normalizeAgentBody(input.body);
  const tiptapBody = normalizeAgentBody(input.tiptapBody);
  if (body === tiptapBody) return;

  console.warn(
    "[agent-save-body-tiptap-mismatch]",
    JSON.stringify({
      agentId: input.agentId,
      bodyLength: body.length,
      tiptapBodyLength: tiptapBody.length,
      bodyRepositories: collectBodyRepositoryMentions(body),
      tiptapRepositories: collectBodyRepositoryMentions(tiptapBody),
    }),
  );
}

export async function materializeLegacyAgentFiles() {
  const trace = startTimingTrace("agents.materializeLegacy");
  const { workspace } = await currentWorkspace();
  const db = getDb();
  const rows = await timeAsync(trace, "db.selectAgents", () =>
    db
      .select({
        id: agents.id,
        path: agents.path,
        name: agents.name,
        body: agents.body,
        config: agents.config,
      })
      .from(agents)
      .where(eq(agents.workspaceId, workspace.id)),
  );
  const repository = await timeAsync(trace, "github.ensureRepository", () =>
    ensureWorkspaceRepository({ db, workspace }),
  );

  for (const agent of rows) {
    if (agent.path) continue;

    const config = normalizeAgentConfig(agent.config);
    const body = agent.body || config.instructions;
    const source = serializeAgentFile({
      title: agent.name,
      body,
      model: config.model.name,
      tools: config.tools,
      brain: config.brain,
      integrations: config.integrations,
      triggers: config.triggers,
    });
    const parsed = parseAgentFile(source);
    const contentHash = hashAgentSource(source);
    const path = await nextAvailableAgentPath(db, workspace.id, agent.name);
    const { commitSha, blobSha } = await timeAsync(
      trace,
      "github.writeWorkspaceFile",
      () =>
        writeWorkspaceFile({
          db,
          repository,
          path,
          content: source,
          message: `Create ${path}`,
        }),
      { path },
    );

    await timeAsync(
      trace,
      "db.updateAgent",
      () =>
        db
          .update(agents)
          .set({
            path,
            name: parsed.title,
            body: parsed.body,
            commitSha,
            contentHash,
            githubBlobSha: blobSha,
            githubCommitSha: commitSha,
            githubSyncedHash: contentHash,
            githubSyncedAt: new Date(),
            githubSyncStatus: "synced",
            githubSyncError: null,
            config: parsed.config,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id))),
      { path },
    );
  }

  revalidatePath("/agents");
  endTimingTrace(trace, { count: rows.length });
}

export async function syncAgentsFromWorkspaceRepository() {
  const trace = startTimingTrace("agents.syncFromWorkspaceRepository");
  const { workspace } = await currentWorkspace();
  const db = getDb();
  const repository = await timeAsync(trace, "github.ensureRepository", () =>
    ensureWorkspaceRepository({ db, workspace }),
  );
  const files = await timeAsync(trace, "github.listWorkspaceAgentFiles", () =>
    listWorkspaceAgentFiles({ repository }),
  );

  for (const file of files) {
    const { content, sha } = await timeAsync(
      trace,
      "github.readWorkspaceFile",
      () =>
        readWorkspaceFile({
          repository,
          path: file.path,
        }),
      { path: file.path },
    );
    const parsed = parseAgentFile(content);
    const contentHash = hashAgentSource(
      serializeAgentFile({
        title: parsed.title,
        body: parsed.body,
        model: parsed.config.model.name,
        tools: parsed.config.tools,
        brain: parsed.config.brain,
        integrations: parsed.config.integrations,
        triggers: parsed.config.triggers,
      }),
    );
    const [existing] = await timeAsync(
      trace,
      "db.selectAgentByPath",
      () =>
        db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.workspaceId, workspace.id), eq(agents.path, file.path)))
          .limit(1),
      { path: file.path },
    );

    if (existing) {
      await timeAsync(
        trace,
        "db.updateAgent",
        () =>
          db
            .update(agents)
            .set({
              name: parsed.title,
              body: parsed.body,
              commitSha: sha ?? file.sha,
              contentHash,
              githubBlobSha: sha ?? file.sha,
              githubCommitSha: null,
              githubSyncedHash: contentHash,
              githubSyncedAt: new Date(),
              githubSyncStatus: "synced",
              githubSyncError: null,
              config: parsed.config,
              updatedAt: new Date(),
            })
            .where(and(eq(agents.id, existing.id), eq(agents.workspaceId, workspace.id))),
        { path: file.path },
      );
      continue;
    }

    await timeAsync(
      trace,
      "db.insertAgent",
      () =>
        db.insert(agents).values({
          id: newAgentId(),
          workspaceId: workspace.id,
          path: file.path,
          name: parsed.title,
          body: parsed.body,
          commitSha: sha ?? file.sha,
          contentHash,
          githubBlobSha: sha ?? file.sha,
          githubSyncedHash: contentHash,
          githubSyncedAt: new Date(),
          githubSyncStatus: "synced",
          config: parsed.config,
        }),
      { path: file.path },
    );
  }

  revalidatePath("/agents");
  endTimingTrace(trace, { count: files.length });
}

function readGitHubRepositoryDefaultBranch(metadata: Record<string, unknown>) {
  return typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
    ? metadata.defaultBranch.trim()
    : "main";
}

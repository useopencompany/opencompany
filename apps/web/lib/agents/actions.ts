"use server";

import {
  type AgentConfigPatch,
  agentBundleDir,
  agentPathForSlug,
  agentSlugFromPath,
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
  agentFiles,
  agentSessions,
  agents,
  brainFiles,
  workspaceIntegrationResources,
  workspaceIntegrations,
  workspaceSyncJobs,
} from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, eq, isNotNull, ne, notInArray, or } from "drizzle-orm";
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
} from "@/lib/agents/create";
import { hashAgentSource } from "@/lib/agents/hash";
import { randomAgentName } from "@/lib/agents/names";
import { selectCanonicalAgentRepositoryFiles } from "@/lib/agents/paths";
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
  ensureWorkspaceRepository,
  listWorkspaceAgentFiles,
  readWorkspaceFile,
} from "@/lib/workspace-state/github";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-state/sync-dispatch";

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
  scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
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
  // A rename with an empty/whitespace-only name should not override the stored
  // name. Treat blank patch.name the same as a missing name (no rename intent).
  const trimmedName = patch.name?.trim();
  const effectiveName = trimmedName ? trimmedName : undefined;
  const trace = startTimingTrace("agents.update", {
    hasName: effectiveName !== undefined,
    hasBody: typeof patch.body === "string",
    hasModel: typeof patch.model === "string",
    hasConfig: Boolean(patch.config),
  });
  const { user, workspace } = await currentWorkspace();
  const db = getDb();
  const decodedPath = decodeURIComponent(idOrPath);
  const changedFields: Array<"name" | "body" | "model" | "config"> = [];
  if (effectiveName !== undefined) changedFields.push("name");
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
  const title = effectiveName ?? agent.name;
  const currentSlug = agent.path ? agentSlugFromPath(agent.path) : null;
  const canonicalCurrentPath = currentSlug ? agentPathForSlug(currentSlug) : null;
  const path =
    effectiveName !== undefined ||
    !agent.path ||
    Boolean(canonicalCurrentPath && agent.path !== canonicalCurrentPath)
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
  const requestedTriggers = patch.config?.triggers ?? currentConfig.triggers;
  const derivedFromTiptap = sanitizedContent
    ? derivePreviewConfigFromTiptapDoc({
        title,
        content: sanitizedContent,
        model: patch.model ?? currentConfig.model.name,
        repositories: derivationRepositories,
        agents: workspaceAgentReferences,
        preferredRepositories: savedPreferredRepositories,
        triggers: requestedTriggers,
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
          triggers: requestedTriggers,
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
        previousPath: workspaceSyncJobs.previousPath,
        previousBlobSha: workspaceSyncJobs.previousBlobSha,
      })
      .from(workspaceSyncJobs)
      .where(
        and(
          eq(workspaceSyncJobs.workspaceId, workspace.id),
          eq(workspaceSyncJobs.sourceKind, "agent"),
          eq(workspaceSyncJobs.sourceRef, agent.id),
        ),
      )
      .limit(1),
  );
  const rename = resolveAgentSyncRename({
    existingPreviousPath: existingSyncJob?.previousPath,
    existingPreviousBlobSha: existingSyncJob?.previousBlobSha,
    renamePreviousPath: pathChanged ? previousPath : null,
    renamePreviousBlobSha: pathChanged ? agent.githubBlobSha : null,
  });
  // Only plan bundle-file moves when previousPath is a validated bundle path.
  // A legacy single-file path (e.g. "agents/leo.agent") resolves via
  // agentBundleDir to the workspace root ("agents"), which would otherwise
  // re-path unrelated bundle files into the new folder.
  const previousBundleDir =
    previousPath && agentSlugFromPath(previousPath) ? agentBundleDir(previousPath) : null;
  const nextBundleDir = agentBundleDir(path);
  const bundleFileMoves =
    previousBundleDir && previousBundleDir !== nextBundleDir
      ? await timeAsync(trace, "db.prepareAgentBundleFileMoves", async () => {
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
                path: workspaceSyncJobs.repoPath,
                previousPath: workspaceSyncJobs.previousPath,
                previousBlobSha: workspaceSyncJobs.previousBlobSha,
              })
              .from(workspaceSyncJobs)
              .where(
                and(
                  eq(workspaceSyncJobs.workspaceId, workspace.id),
                  eq(workspaceSyncJobs.sourceKind, "agent_file"),
                ),
              ),
          ]);

          return prepareAgentBundleFileMoves({
            files,
            existingFileSyncJobs,
            oldBundleDir: previousBundleDir,
            newBundleDir: nextBundleDir,
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
      // Coalescing is keyed on (workspaceId, repoPath), so a rename enqueues the
      // new-path job without touching the agent's stale job still keyed at the old
      // path. Left behind, that stale job re-upserts the agent's content at the old
      // path during projection and suppresses the rename's delete (project.ts drops
      // deletes whose path is also an upsert), leaving a duplicate .agent file.
      // Delete every other outbox job for this agent so exactly one survives.
      ...(pathChanged
        ? [
            db
              .delete(workspaceSyncJobs)
              .where(
                and(
                  eq(workspaceSyncJobs.workspaceId, workspace.id),
                  eq(workspaceSyncJobs.sourceKind, "agent"),
                  eq(workspaceSyncJobs.sourceRef, agent.id),
                  ne(workspaceSyncJobs.repoPath, path),
                ),
              ),
          ]
        : []),
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
          .delete(workspaceSyncJobs)
          .where(
            and(
              eq(workspaceSyncJobs.workspaceId, workspace.id),
              eq(workspaceSyncJobs.repoPath, move.previousPath),
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
  // One coalesced dispatch covers the agent definition and any bundle-file moves.
  scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
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

  // Enqueue async deletion of the agent's repo files (the .agent definition and
  // any bundle files such as agent/memory.md) through the unified projector. We
  // read the bundle files before the cascade delete below removes the agentFiles
  // rows. NOTE: unlike the previous GitHub-first delete, this is asynchronous —
  // a deleted agent's files linger in the repo until the next projection commit,
  // an accepted trade-off for a single consistent pipeline.
  let deletionSyncQueries: ReturnType<typeof enqueueWorkspaceSync>[] = [];
  if (agent.path) {
    const bundleFiles = await timeAsync(trace, "db.selectAgentBundleFiles", () =>
      db
        .select({ path: agentFiles.path, githubBlobSha: agentFiles.githubBlobSha })
        .from(agentFiles)
        .where(and(eq(agentFiles.agentId, agent.id), eq(agentFiles.workspaceId, workspace.id))),
    );

    deletionSyncQueries = [
      enqueueWorkspaceSync(db, {
        workspaceId: workspace.id,
        repoPath: agent.path,
        sourceKind: "agent",
        sourceRef: agent.id,
        operation: "delete",
        desiredHash: null,
        previousBlobSha: agent.githubBlobSha,
      }),
      ...bundleFiles
        .filter((file) => file.path !== agent.path)
        .map((file) =>
          enqueueWorkspaceSync(db, {
            workspaceId: workspace.id,
            repoPath: file.path,
            sourceKind: "agent_file",
            operation: "delete",
            desiredHash: null,
            previousBlobSha: file.githubBlobSha,
          }),
        ),
    ];
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

  const deleteAgentQuery = db
    .delete(agents)
    .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id)));
  const deleteQueries = [...deletionSyncQueries, deleteAgentQuery];
  await timeAsync(trace, "db.deleteAgent", () =>
    db.batch(
      deleteQueries as [(typeof deleteQueries)[number], ...(typeof deleteQueries)[number][]],
    ),
  );

  await captureServerEvent("agent_deleted", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
  });

  revalidatePath("/agents");
  if (agent.path) revalidatePath(`/agents/${agent.path}`);
  revalidatePath(`/agents/${agent.id}`);
  if (agent.path) scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
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
  const canonicalFiles = selectCanonicalAgentRepositoryFiles(files);
  let canonicalSyncQueued = false;

  for (const file of canonicalFiles) {
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
          .select({ id: agents.id, path: agents.path, version: agents.version })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, workspace.id),
              file.legacyPath
                ? or(eq(agents.path, file.canonicalPath), eq(agents.path, file.legacyPath))
                : eq(agents.path, file.canonicalPath),
            ),
          )
          .limit(1),
      { path: file.canonicalPath },
    );
    const shouldCanonicalize = Boolean(file.previousPath);
    const pathChangedInDb = Boolean(existing && existing.path !== file.canonicalPath);
    const nextVersion = (existing?.version ?? 0) + (shouldCanonicalize || pathChangedInDb ? 1 : 0);

    if (existing) {
      await timeAsync(
        trace,
        "db.updateAgent",
        () =>
          db
            .update(agents)
            .set({
              path: file.canonicalPath,
              name: parsed.title,
              body: parsed.body,
              commitSha: sha ?? file.sha,
              contentHash,
              githubBlobSha: sha ?? file.sha,
              githubCommitSha: null,
              githubSyncedHash: contentHash,
              githubSyncedAt: new Date(),
              githubSyncStatus: shouldCanonicalize ? "pending" : "synced",
              githubSyncError: null,
              config: parsed.config,
              version: nextVersion,
              updatedAt: new Date(),
            })
            .where(and(eq(agents.id, existing.id), eq(agents.workspaceId, workspace.id))),
        { path: file.canonicalPath },
      );
      if (shouldCanonicalize) {
        const syncJob = prepareAgentSyncJobUpsert(db, {
          agentId: existing.id,
          workspaceId: workspace.id,
          path: file.canonicalPath,
          desiredHash: contentHash,
          desiredVersion: nextVersion,
          previousPath: file.previousPath,
          previousBlobSha: sha ?? file.sha,
        });
        await timeAsync(trace, "db.upsertCanonicalAgentSyncJob", () => syncJob.query, {
          path: file.canonicalPath,
        });
        logAgentSyncJobQueued(syncJob.metadata);
        canonicalSyncQueued = true;
      }
      continue;
    }

    const id = newAgentId();
    await timeAsync(
      trace,
      "db.insertAgent",
      () =>
        db.insert(agents).values({
          id,
          workspaceId: workspace.id,
          path: file.canonicalPath,
          name: parsed.title,
          body: parsed.body,
          commitSha: sha ?? file.sha,
          contentHash,
          githubBlobSha: sha ?? file.sha,
          githubSyncedHash: contentHash,
          githubSyncedAt: new Date(),
          githubSyncStatus: shouldCanonicalize ? "pending" : "synced",
          config: parsed.config,
        }),
      { path: file.canonicalPath },
    );
    if (shouldCanonicalize) {
      const syncJob = prepareAgentSyncJobUpsert(db, {
        agentId: id,
        workspaceId: workspace.id,
        path: file.canonicalPath,
        desiredHash: contentHash,
        desiredVersion: 1,
        previousPath: file.previousPath,
        previousBlobSha: sha ?? file.sha,
      });
      await timeAsync(trace, "db.upsertCanonicalAgentSyncJob", () => syncJob.query, {
        path: file.canonicalPath,
      });
      logAgentSyncJobQueued(syncJob.metadata);
      canonicalSyncQueued = true;
    }
  }

  if (canonicalSyncQueued) scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
  revalidatePath("/agents");
  endTimingTrace(trace, { count: canonicalFiles.length });
}

function readGitHubRepositoryDefaultBranch(metadata: Record<string, unknown>) {
  return typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
    ? metadata.defaultBranch.trim()
    : "main";
}

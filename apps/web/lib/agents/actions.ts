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
import { buildPendingAgent, nextAvailableAgentPath } from "@/lib/agents/create";
import { hashAgentSource } from "@/lib/agents/hash";
import { randomAgentName } from "@/lib/agents/names";
import {
  buildGitHubRepositoryCatalogs,
  type GitHubIntegrationRepositoryPayload,
  normalizeAgentConfig,
  serializeAgentDetail,
} from "@/lib/agents/payload";
import { sanitizeTiptapDoc } from "@/lib/agents/tiptap";
import { currentWorkspace } from "@/lib/auth";
import {
  GITHUB_INTEGRATION_PROVIDER,
  GITHUB_REPOSITORY_RESOURCE_TYPE,
} from "@/lib/integrations/service";
import { loadWorkspaceMcpSettingsForWorkspace } from "@/lib/mcp/data";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-sync/dispatch";
import { markWorkspaceDirty } from "@/lib/workspace-sync/jobs";

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

  await timeAsync(trace, "db.createAgentAndMarkDirty", () =>
    db.batch([db.insert(agents).values(pending.agent), markWorkspaceDirty(db, workspace.id)]),
  );
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
  // Only move bundle files when previousPath is a validated bundle path. A
  // legacy single-file path (e.g. "agents/leo.agent") resolves via
  // agentBundleDir to the workspace root ("agents"), which would otherwise
  // re-path unrelated bundle files into the new folder.
  const previousBundleDir =
    previousPath && agentSlugFromPath(previousPath) ? agentBundleDir(previousPath) : null;
  const nextBundleDir = agentBundleDir(path);
  const bundleFileMoves =
    previousBundleDir && previousBundleDir !== nextBundleDir
      ? await timeAsync(trace, "db.prepareAgentBundleFileMoves", async () => {
          const files = await db
            .select({ id: agentFiles.id, path: agentFiles.path })
            .from(agentFiles)
            .where(eq(agentFiles.workspaceId, workspace.id));
          return files
            .filter((file) => file.path.startsWith(`${previousBundleDir}/`))
            .map((file) => ({
              fileId: file.id,
              previousPath: file.path,
              path: `${nextBundleDir}/${file.path.slice(previousBundleDir.length + 1)}`,
            }));
        })
      : [];

  const now = new Date();
  await timeAsync(trace, "db.updateAgentAndMarkDirty", () =>
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
      markWorkspaceDirty(db, workspace.id),
    ]),
  );
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

  // Delete the agent (cascades to its agentFiles) and mark the workspace dirty.
  // The next reconcile removes the agent's files from GitHub as part of the
  // whole-tree diff — no synchronous GitHub writes in the request path.
  await timeAsync(trace, "db.deleteAgentAndMarkDirty", () =>
    db.batch([
      db.delete(agents).where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id))),
      markWorkspaceDirty(db, workspace.id),
    ]),
  );

  await captureServerEvent("agent_deleted", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
  });

  revalidatePath("/agents");
  if (agent.path) revalidatePath(`/agents/${agent.path}`);
  revalidatePath(`/agents/${agent.id}`);
  scheduleWorkspaceSyncDispatch({ workspaceId: workspace.id });
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

function readGitHubRepositoryDefaultBranch(metadata: Record<string, unknown>) {
  return typeof metadata.defaultBranch === "string" && metadata.defaultBranch.trim()
    ? metadata.defaultBranch.trim()
    : "main";
}

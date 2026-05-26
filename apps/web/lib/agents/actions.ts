"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import {
  agentSyncJobs,
  agents,
  brainFiles,
  workspaceGitHubIntegrationRepositories,
} from "@opencompany/db/schema";
import { and, asc, eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type AgentConfigPatch, parseAgentFile, serializeAgentFile } from "@/lib/agents/agent-file";
import { derivePreviewConfigFromTiptapDoc } from "@/lib/agents/config";
import {
  buildPendingAgent,
  logAgentSyncJobQueued,
  newAgentId,
  nextAvailableAgentPath,
  prepareAgentSyncJobUpsert,
  scheduleAgentSyncDispatch,
} from "@/lib/agents/create";
import { hashAgentSource } from "@/lib/agents/hash";
import {
  collectBodyRepositoryMentions,
  deriveAgentConfigFromBody,
  normalizeAgentBody,
} from "@/lib/agents/mentions";
import { randomAgentName } from "@/lib/agents/names";
import { serializeAgent } from "@/lib/agents/payload";
import { resolveAgentSyncRename } from "@/lib/agents/sync-job";
import { sanitizeTiptapDoc } from "@/lib/agents/tiptap";
import type { AgentModelId, TiptapDoc } from "@/lib/agents/types";
import { getCurrentWorkspace } from "@/lib/auth";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import {
  ensureWorkspaceRepository,
  listWorkspaceAgentFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace-state/github";

export async function createAgent() {
  const trace = startTimingTrace("agents.create");
  const { user, workspace } = await getCurrentWorkspace();
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
  const { user, workspace } = await getCurrentWorkspace();
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
          fullName: workspaceGitHubIntegrationRepositories.fullName,
          defaultBranch: workspaceGitHubIntegrationRepositories.defaultBranch,
        })
        .from(workspaceGitHubIntegrationRepositories)
        .where(eq(workspaceGitHubIntegrationRepositories.workspaceId, workspace.id))
        .orderBy(asc(workspaceGitHubIntegrationRepositories.fullName)),
  );
  const derivedFromTiptap = sanitizedContent
    ? derivePreviewConfigFromTiptapDoc({
        title,
        content: sanitizedContent,
        model: patch.model ?? agent.config.model.name,
        repositories: githubIntegrationRepositories,
        triggers: agent.config.triggers,
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
          model: patch.model ?? agent.config.model.name,
          repositories: githubIntegrationRepositories,
          triggers: agent.config.triggers,
        })
      : derivedFromTiptap;
  warnOnBodyTiptapMismatch({
    agentId: agent.id,
    ...(typeof patch.body === "string" ? { body: patch.body } : {}),
    ...(typeof derivedFromTiptap?.body === "string" ? { tiptapBody: derivedFromTiptap.body } : {}),
  });
  const body = typeof patch.body === "string" ? patch.body : (derived?.body ?? agent.body);
  const model = derived?.config.model.name ?? patch.model ?? agent.config.model.name;
  const nextIntegrations =
    derived?.config.integrations ?? patch.config?.integrations ?? agent.config.integrations;
  const nextTools = derived?.config.tools ?? patch.config?.tools ?? agent.config.tools;
  const nextBrain = derived?.config.brain ?? patch.config?.brain ?? agent.config.brain;
  const nextTriggers = derived?.config.triggers ?? patch.config?.triggers ?? agent.config.triggers;
  const source = serializeAgentFile({
    title,
    body,
    model,
    tools: nextTools,
    brain: nextBrain,
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
  const syncJob = prepareAgentSyncJobUpsert(db, {
    agentId: agent.id,
    workspaceId: workspace.id,
    path,
    desiredHash: contentHash,
    desiredVersion: version,
    previousPath: rename.previousPath,
    previousBlobSha: rename.previousBlobSha,
  });

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
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id))),
      syncJob.query,
    ]),
  );
  logAgentSyncJobQueued(syncJob.metadata);
  const [[updatedAgent], brainPathRows] = await Promise.all([
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
  ]);
  const brainPaths = brainPathRows.map((row) => row.path);

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
      ? serializeAgent(updatedAgent, brainPaths, githubIntegrationRepositories)
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
  endTimingTrace(trace, { found: true, path: result.path, pathChanged });
  return result;
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
  const { workspace } = await getCurrentWorkspace();
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

    const body = agent.body || agent.config.instructions;
    const source = serializeAgentFile({
      title: agent.name,
      body,
      model: agent.config.model.name,
      tools: agent.config.tools,
      brain: agent.config.brain,
      integrations: agent.config.integrations,
      triggers: agent.config.triggers,
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
  const { workspace } = await getCurrentWorkspace();
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

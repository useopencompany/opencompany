"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, agents } from "@opencompany/db/schema";
import { and, eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { parseAgentFile, serializeAgentFile } from "@/lib/agents/agent-file";
import { hashAgentSource } from "@/lib/agents/hash";
import { randomAgentName } from "@/lib/agents/names";
import { resolveAgentPath } from "@/lib/agents/paths";
import { dispatchAgentSyncRequested } from "@/lib/agents/sync-events";
import { resolveAgentSyncRename } from "@/lib/agents/sync-job";
import type { AgentModelId } from "@/lib/agents/types";
import { getCurrentWorkspace } from "@/lib/auth";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import {
  ensureWorkspaceRepository,
  listWorkspaceAgentFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/workspace-state/github";

function newAgentId() {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `agt_${raw}`;
}

export async function createAgent() {
  const trace = startTimingTrace("agents.create");
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const id = newAgentId();
  const title = randomAgentName();
  const body = "";
  const path = await timeAsync(trace, "db.nextAvailableAgentPath", () =>
    nextAvailableAgentPath(db, workspace.id, title),
  );
  const source = serializeAgentFile({ title, body });
  const parsed = parseAgentFile(source);
  const contentHash = hashAgentSource(source);
  const version = 1;

  await timeAsync(trace, "db.createAgentAndSyncJob", () =>
    db.batch([
      db.insert(agents).values({
        id,
        workspaceId: workspace.id,
        path,
        name: parsed.title,
        body: parsed.body,
        contentHash,
        version,
        config: parsed.config,
        githubSyncStatus: "pending",
      }),
      agentSyncJobUpsert(db, {
        agentId: id,
        workspaceId: workspace.id,
        path,
        desiredHash: contentHash,
        desiredVersion: version,
        previousPath: null,
        previousBlobSha: null,
      }),
    ]),
  );
  const result = { id, workspaceId: workspace.id, path };

  await captureServerEvent("agent_created", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: id,
  });

  revalidatePath("/agents");
  scheduleAgentSyncDispatch(result);
  endTimingTrace(trace, { path: result.path });
  redirect(`/agents/${result.path}`);
}

export async function updateAgent(
  idOrPath: string,
  patch: { name?: string; body?: string; model?: AgentModelId },
) {
  const trace = startTimingTrace("agents.update", {
    hasName: typeof patch.name === "string",
    hasBody: typeof patch.body === "string",
    hasModel: typeof patch.model === "string",
  });
  const { user, workspace } = await getCurrentWorkspace();
  const db = getDb();
  const decodedPath = decodeURIComponent(idOrPath);
  const changedFields: Array<"name" | "body" | "model"> = [];
  if (typeof patch.name === "string") changedFields.push("name");
  if (typeof patch.body === "string") changedFields.push("body");
  if (typeof patch.model === "string") changedFields.push("model");

  const [agent] = await timeAsync(trace, "db.selectAgent", () =>
    db
      .select({
        id: agents.id,
        path: agents.path,
        name: agents.name,
        body: agents.body,
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
  const body = patch.body ?? agent.body;
  const model = patch.model ?? agent.config.model.name;
  const source = serializeAgentFile({ title, body, model });
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

  await timeAsync(trace, "db.updateAgentAndSyncJob", () =>
    db.batch([
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
        .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id))),
      agentSyncJobUpsert(db, {
        agentId: agent.id,
        workspaceId: workspace.id,
        path,
        desiredHash: contentHash,
        desiredVersion: version,
        previousPath: rename.previousPath,
        previousBlobSha: rename.previousBlobSha,
      }),
    ]),
  );

  if (changedFields.length > 0) {
    await captureServerEvent("agent_saved", user.id, {
      user_id: user.id,
      workspace_id: workspace.id,
      agent_id: agent.id,
      changed_fields: changedFields,
    });
  }

  const result = { id: agent.id, workspaceId: workspace.id, path, pathChanged };

  revalidatePath("/agents");
  revalidatePath(`/agents/${result.path}`);
  if (previousPath) revalidatePath(`/agents/${previousPath}`);
  revalidatePath(`/agents/${result.id}`);
  scheduleAgentSyncDispatch(result);
  endTimingTrace(trace, { found: true, path: result.path, pathChanged });
  return result;
}

async function nextAvailableAgentPath(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  title: string,
  currentPath?: string | null,
) {
  const rows = await db
    .select({ path: agents.path })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  return resolveAgentPath({
    title,
    currentPath,
    existingPaths: rows.flatMap((row) => (row.path ? [row.path] : [])),
  });
}

function agentSyncJobUpsert(
  db: Pick<ReturnType<typeof getDb>, "insert">,
  input: {
    agentId: string;
    workspaceId: string;
    path: string;
    desiredHash: string;
    desiredVersion: number;
    previousPath: string | null;
    previousBlobSha: string | null;
  },
) {
  const now = new Date();
  return db
    .insert(agentSyncJobs)
    .values({
      ...input,
      status: "pending",
      attempts: 0,
      nextRunAt: new Date(now.getTime() + 10_000),
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentSyncJobs.agentId,
      set: {
        path: input.path,
        desiredHash: input.desiredHash,
        desiredVersion: input.desiredVersion,
        previousPath: input.previousPath,
        previousBlobSha: input.previousBlobSha,
        status: "pending",
        attempts: 0,
        nextRunAt: new Date(now.getTime() + 10_000),
        lastError: null,
        updatedAt: now,
      },
    });
}

function scheduleAgentSyncDispatch(input: { id: string; workspaceId: string }) {
  after(async () => {
    try {
      await dispatchAgentSyncRequested({
        agentId: input.id,
        workspaceId: input.workspaceId,
      });
    } catch (error) {
      console.error("Failed to dispatch agent GitHub sync event", error);
    }
  });
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

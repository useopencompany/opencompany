"use server";

import {
  agentBundleDir,
  agentDefinitionFileNameForPath,
  deriveAgentConfigFromBody,
  isExternalSkillReference,
  parseAgentFile,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import type { AgentConfig, TiptapDoc } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  type AgentBundleFilePayload,
  isAgentBundleTextFile,
  normalizeAgentBundleRelativePath,
  serializeAgentBundleFiles,
} from "@/lib/agents/bundle-files";
import { hashAgentSource } from "@/lib/agents/hash";
import { sanitizeTiptapDoc } from "@/lib/agents/tiptap";
import { currentWorkspace } from "@/lib/auth";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";
import { MAX_BRAIN_FILE_BYTES } from "@/lib/brain/paths";

type UpdateBehaviorResult = { ok: true; config: AgentConfig } | { ok: false; error: string };

/**
 * Save the /personal agent's behavior (its `.agent` body + Tiptap presentation cache).
 *
 * Unlike `updateAgent`, this deliberately does NOT enqueue a GitHub sync job: the personal
 * agent is local-only (see `ensurePersonalAgent`), so the projector must never receive
 * outbox work for it. We re-derive the runtime config from the edited body — so @-mentioned
 * tools, skills, and repositories flow straight into `config` — and persist in place.
 *
 * Scoped to the caller's own default agent (workspace + user + isDefault) so this can only
 * ever touch the personal agent.
 */
export async function updatePersonalAgentBehavior(
  agentId: string,
  patch: { body: string; content: TiptapDoc },
): Promise<UpdateBehaviorResult> {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      config: agents.config,
      version: agents.version,
    })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.workspaceId, workspace.id),
        eq(agents.userId, user.id),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);

  if (!agent) {
    return { ok: false, error: "Personal agent not found." };
  }

  const currentConfig = agent.config;
  const repositories = currentConfig.integrations.github.repositories.map((repository) => ({
    fullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
    ...(repository.binding ? { binding: repository.binding } : {}),
  }));
  const skills = (currentConfig.skills ?? []).filter(isExternalSkillReference);

  const derived = deriveAgentConfigFromBody({
    title: agent.name,
    body: patch.body,
    model: currentConfig.model.name,
    repositories,
    skills,
    preferredRepositories: repositories.filter((repository) => repository.binding),
    triggers: currentConfig.triggers,
  });

  const source = serializeAgentFile({
    title: agent.name,
    body: derived.body,
    model: derived.config.model.name,
    tools: derived.config.tools,
    brain: derived.config.brain,
    agents: derived.config.agents ?? [],
    skills: derived.config.skills ?? [],
    integrations: derived.config.integrations,
    triggers: derived.config.triggers,
  });
  const parsed = parseAgentFile(source);
  const contentHash = hashAgentSource(source);
  const sanitizedContent = sanitizeTiptapDoc(patch.content);

  await db
    .update(agents)
    .set({
      name: parsed.title,
      body: parsed.body,
      content: sanitizedContent,
      contentHash,
      version: agent.version + 1,
      config: parsed.config,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id)));

  await captureServerEvent("agent_saved", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
    changed_fields: ["body"],
  });

  return { ok: true, config: parsed.config };
}

type ContextFileResult = { ok: true; file: AgentBundleFilePayload } | { ok: false; error: string };

// Resolve the caller's own personal agent (workspace + user + isDefault) and validate that
// `relativePath` is a writable bundle path. Returns the normalized full path so callers can
// read/write the agent_files row without re-checking ownership. All /personal context writes
// go through this so they can only ever touch the caller's own default agent.
async function resolvePersonalBundlePath(
  agentId: string,
  relativePathInput: string,
): Promise<
  | { ok: true; agentId: string; agentPath: string; workspaceId: string; normalizedPath: string }
  | { ok: false; error: string }
> {
  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select({ id: agents.id, path: agents.path })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.workspaceId, workspace.id),
        eq(agents.userId, user.id),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);

  if (!agent?.path) return { ok: false, error: "Personal agent not found." };

  const bundleDir = agentBundleDir(agent.path);
  const relativePath = normalizeAgentBundleRelativePath(relativePathInput);
  const definitionFileName = agentDefinitionFileNameForPath(agent.path);
  if (!relativePath || relativePath === "agent.agent" || relativePath === definitionFileName) {
    return { ok: false, error: "That file path isn't editable here." };
  }
  if (!isAgentBundleTextFile(relativePath)) {
    return { ok: false, error: "Only text files can be edited here." };
  }

  return {
    ok: true,
    agentId: agent.id,
    agentPath: agent.path,
    workspaceId: workspace.id,
    normalizedPath: `${bundleDir}/${relativePath}`,
  };
}

/**
 * Overwrite a single file in the personal agent's bundle (its context folder).
 *
 * Like {@link updatePersonalAgentBehavior}, this is deliberately local-only: the personal
 * agent is never projected to GitHub, so we leave `githubSyncStatus` as "synced" and never
 * enqueue a workspace_sync_job. The runner reads agent_files directly when materializing the
 * bundle, so edits show up in the next session regardless of sync state.
 */
export async function updatePersonalAgentContextFile(
  agentId: string,
  relativePath: string,
  content: string,
): Promise<ContextFileResult> {
  try {
    const resolved = await resolvePersonalBundlePath(agentId, relativePath);
    if (!resolved.ok) return resolved;

    const sizeBytes = brainContentSize(content);
    if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
      return { ok: false, error: "Files must be 256 KB or smaller." };
    }

    const db = getDb();
    const [existing] = await db
      .select()
      .from(agentFiles)
      .where(
        and(
          eq(agentFiles.workspaceId, resolved.workspaceId),
          eq(agentFiles.agentId, resolved.agentId),
          eq(agentFiles.path, resolved.normalizedPath),
        ),
      )
      .limit(1);
    if (!existing) return { ok: false, error: "File not found." };

    await db
      .update(agentFiles)
      .set({
        content,
        contentHash: hashBrainContent(content),
        sizeBytes,
        githubSyncStatus: "synced",
        githubSyncError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentFiles.workspaceId, resolved.workspaceId),
          eq(agentFiles.agentId, resolved.agentId),
          eq(agentFiles.path, resolved.normalizedPath),
        ),
      );

    const [updated] = await db
      .select()
      .from(agentFiles)
      .where(
        and(
          eq(agentFiles.workspaceId, resolved.workspaceId),
          eq(agentFiles.agentId, resolved.agentId),
          eq(agentFiles.path, resolved.normalizedPath),
        ),
      )
      .limit(1);
    const [file] = serializeAgentBundleFiles(resolved.agentPath, updated ? [updated] : []);
    if (!file) return { ok: false, error: "File not found after save." };
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Save failed." };
  }
}

/**
 * Create a new file in the personal agent's bundle. Local-only (see
 * {@link updatePersonalAgentContextFile}). Fails if a file already exists at the path.
 */
export async function createPersonalAgentContextFile(
  agentId: string,
  relativePath: string,
  content = "",
): Promise<ContextFileResult> {
  try {
    const resolved = await resolvePersonalBundlePath(agentId, relativePath);
    if (!resolved.ok) return resolved;

    const sizeBytes = brainContentSize(content);
    if (sizeBytes > MAX_BRAIN_FILE_BYTES) {
      return { ok: false, error: "Files must be 256 KB or smaller." };
    }

    const db = getDb();
    const [existing] = await db
      .select({ id: agentFiles.id })
      .from(agentFiles)
      .where(
        and(
          eq(agentFiles.workspaceId, resolved.workspaceId),
          eq(agentFiles.agentId, resolved.agentId),
          eq(agentFiles.path, resolved.normalizedPath),
        ),
      )
      .limit(1);
    if (existing) return { ok: false, error: "A file with that name already exists." };

    await db.insert(agentFiles).values({
      workspaceId: resolved.workspaceId,
      agentId: resolved.agentId,
      path: resolved.normalizedPath,
      content,
      contentHash: hashBrainContent(content),
      sizeBytes,
      githubSyncStatus: "synced",
    });

    const [created] = await db
      .select()
      .from(agentFiles)
      .where(
        and(
          eq(agentFiles.workspaceId, resolved.workspaceId),
          eq(agentFiles.agentId, resolved.agentId),
          eq(agentFiles.path, resolved.normalizedPath),
        ),
      )
      .orderBy(asc(agentFiles.path))
      .limit(1);
    const [file] = serializeAgentBundleFiles(resolved.agentPath, created ? [created] : []);
    if (!file) return { ok: false, error: "File not found after creation." };
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Create failed." };
  }
}

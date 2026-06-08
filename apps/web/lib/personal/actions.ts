"use server";

import {
  agentBundleDir,
  agentDefinitionFileNameForPath,
  buildAgentTiptapDoc,
  buildConfigMentionResolver,
  deriveAgentConfigFromBody,
  extractMentionIds,
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
import { listWorkspaceSkillSnapshots, toExternalSkillReference } from "@/lib/skills/snapshots";

type UpdateBehaviorResult = { ok: true; config: AgentConfig } | { ok: false; error: string };

// The personal agent's `.agent` body is the single source of truth: @-mentioned tools, skills,
// repositories, and integrations are re-derived from it on every save. This re-runs that canonical
// derivation for a given body — resolving the workspace's repositories and external skills so their
// mentions bind — and returns the parsed title/body/config plus the serialized source (for hashing).
// Both the Behavior editor and the manual "Add integration" path go through here so neither can
// diverge from what the body actually says.
async function derivePersonalAgentSave(
  agent: { name: string; config: AgentConfig },
  workspaceId: string,
  body: string,
): Promise<{ title: string; body: string; config: AgentConfig; source: string }> {
  const currentConfig = agent.config;
  const repositories = currentConfig.integrations.github.repositories.map((repository) => ({
    fullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
    ...(repository.binding ? { binding: repository.binding } : {}),
  }));
  const skillsById = new Map(
    (currentConfig.skills ?? [])
      .filter(isExternalSkillReference)
      .map((skill) => [skill.id, skill] as const),
  );
  const workspaceSkillReferences = (await listWorkspaceSkillSnapshots(workspaceId)).map(
    toExternalSkillReference,
  );
  for (const skill of workspaceSkillReferences) {
    skillsById.set(skill.id, skill);
  }
  const skills = [...skillsById.values()];

  const derived = deriveAgentConfigFromBody({
    title: agent.name,
    body,
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
  return { title: parsed.title, body: parsed.body, config: parsed.config, source };
}

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

  const saved = await derivePersonalAgentSave(agent, workspace.id, patch.body);
  const contentHash = hashAgentSource(saved.source);
  const sanitizedContent = sanitizeTiptapDoc(patch.content);

  await db
    .update(agents)
    .set({
      name: saved.title,
      body: saved.body,
      content: sanitizedContent,
      contentHash,
      version: agent.version + 1,
      config: saved.config,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id)));

  await captureServerEvent("agent_saved", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
    changed_fields: ["body"],
  });

  return { ok: true, config: saved.config };
}

// The integrations the manual "Add integration" button can append, keyed by the @-mention token it
// writes into the body. Today only the workspace GitHub integration is mentionable this way; new
// providers slot in here as they become first-class personal integrations.
const PERSONAL_INTEGRATION_MENTIONS = {
  github: "@github",
} as const;

export type PersonalIntegrationId = keyof typeof PERSONAL_INTEGRATION_MENTIONS;

type AddIntegrationResult =
  | { ok: true; config: AgentConfig; body: string; content: TiptapDoc }
  | { ok: false; error: string };

/**
 * Manually attach an integration to the /personal agent from the Integrations tab.
 *
 * This is deliberately NOT a separate store: it appends the integration's @-mention to the bottom
 * of the agent's `.agent` body and re-derives everything from that text — exactly as if the user
 * had typed the mention in Behavior. The body stays the single source of truth, so the mention is
 * visible and removable in the Behavior editor, and the manual path can never drift from the
 * @-mention path. We rebuild the Tiptap presentation cache from the canonical body so the editor
 * reseeds with the appended mention pill instead of a stale doc. Local-only, like
 * {@link updatePersonalAgentBehavior}.
 */
export async function addPersonalAgentIntegration(
  agentId: string,
  integration: PersonalIntegrationId,
): Promise<AddIntegrationResult> {
  const mention = PERSONAL_INTEGRATION_MENTIONS[integration];
  if (!mention) return { ok: false, error: "Unknown integration." };

  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      body: agents.body,
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

  // The mention token is what the runtime keys on (e.g. `@github` -> id "github"); skip the append
  // if it's already in the body so re-adding is a no-op rather than a duplicate pill.
  const mentionToken = mention.replace(/^@/, "").toLowerCase();
  const alreadyPresent = extractMentionIds(agent.body).some(
    (id) => id.toLowerCase() === mentionToken,
  );
  const trimmedBody = agent.body.replace(/\s+$/g, "");
  const nextBody = alreadyPresent
    ? agent.body
    : trimmedBody.length === 0
      ? mention
      : `${trimmedBody}\n\n${mention}`;

  const saved = await derivePersonalAgentSave(agent, workspace.id, nextBody);
  const content = buildAgentTiptapDoc(saved.body, buildConfigMentionResolver(saved.config));
  const contentHash = hashAgentSource(saved.source);

  await db
    .update(agents)
    .set({
      name: saved.title,
      body: saved.body,
      content,
      contentHash,
      version: agent.version + 1,
      config: saved.config,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id)));

  await captureServerEvent("agent_saved", user.id, {
    user_id: user.id,
    workspace_id: workspace.id,
    agent_id: agent.id,
    changed_fields: ["body"],
  });

  return { ok: true, config: saved.config, body: saved.body, content };
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

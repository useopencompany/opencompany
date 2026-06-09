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
import { agentFiles, agents, inboxItems } from "@opencompany/db/schema";
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

type ResetPersonalAgentResult = { ok: true } | { ok: false; error: string };

/**
 * Dev-only full reset of the caller's personal agent — wipes it to a clean slate so the V2
 * onboarding surface (`/onboarding/personal`) can be tested repeatedly.
 *
 * Deletes the agent row (scoped to the caller's own default agent): FK cascades remove all of
 * its sessions (→ messages, chunks, events, usage, run jobs, sandbox usage, stars), its bundle
 * files, and its messaging channels. Inbox items aren't FK-tied to the agent (they're scoped to
 * the user), so they're cleared separately.
 *
 * On the next `/onboarding/personal` (or `/personal`) load, `ensurePersonalAgent` provisions a
 * fresh agent with a new id/path and the default behavior. We intentionally do NOT reuse
 * `deleteAgent` — it requires admin role and enqueues GitHub sync jobs + E2B sandbox archival,
 * none of which apply to the local-only personal agent. Any live E2B sandbox for a deleted
 * session is simply left to expire on its own; acceptable for a dev reset.
 */
export async function resetPersonalAgent(): Promise<ResetPersonalAgentResult> {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, error: "Reset is disabled in production." };
  }

  const { user, workspace } = await currentWorkspace();
  const db = getDb();

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspace.id),
        eq(agents.userId, user.id),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);

  // Clear the user's inbox regardless — items survive the agent's FK cascade.
  await db
    .delete(inboxItems)
    .where(and(eq(inboxItems.workspaceId, workspace.id), eq(inboxItems.userId, user.id)));

  if (agent) {
    await db
      .delete(agents)
      .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, workspace.id)));
  }

  return { ok: true };
}

// The integrations the manual "Add integration" button and the onboarding integrations step can
// append, keyed by the @-mention token written into the body. Each mention maps to an entry in the
// runtime AGENT_TOOL_CATALOG, so enabling here is identical to the user typing the mention in
// Behavior. MCP providers (linear/slack/posthog/betterstack) are enabled per-agent via the mention
// but connected at the workspace level via OAuth; the runner renders a graceful "enabled but not connected"
// placeholder until that's done, so writing the mention early is safe.
const PERSONAL_INTEGRATION_MENTIONS = {
  github: "@github",
  gmail: "@gmail",
  google_calendar: "@google_calendar",
  linear: "@linear",
  slack: "@slack",
  posthog: "@posthog",
  betterstack: "@betterstack",
  braintrust: "@braintrust",
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

type EnableIntegrationsResult = { ok: true; config: AgentConfig } | { ok: false; error: string };

/**
 * Enable several integrations on the /personal agent in a single write — used by the onboarding
 * integrations step (and the chosen setup pack, which pre-selects some).
 *
 * Like {@link addPersonalAgentIntegration}, this is not a separate store: it appends each missing
 * integration's @-mention to the agent's `.agent` body and re-derives the config from that text, so
 * the mentions stay visible/removable in Behavior and the manual, onboarding, and @-mention paths
 * can never diverge. Batching keeps it to one load + one save (vs. N round-trips) and means an
 * abandoned onboarding never leaves the agent half-configured. Local-only and idempotent: mentions
 * already present are skipped, and an empty/all-present set is a no-op that returns the current
 * config.
 */
export async function enablePersonalAgentIntegrations(
  agentId: string,
  integrations: PersonalIntegrationId[],
): Promise<EnableIntegrationsResult> {
  const mentions = integrations
    .map((id) => PERSONAL_INTEGRATION_MENTIONS[id])
    .filter((mention): mention is (typeof PERSONAL_INTEGRATION_MENTIONS)[PersonalIntegrationId] =>
      Boolean(mention),
    );

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

  if (mentions.length === 0) {
    return { ok: true, config: agent.config };
  }

  // Only append mentions not already in the body so re-enabling is a no-op rather than a duplicate.
  const present = new Set(extractMentionIds(agent.body).map((id) => id.toLowerCase()));
  const toAppend = mentions.filter(
    (mention) => !present.has(mention.replace(/^@/, "").toLowerCase()),
  );
  if (toAppend.length === 0) {
    return { ok: true, config: agent.config };
  }

  const trimmedBody = agent.body.replace(/\s+$/g, "");
  const appended = toAppend.join("\n\n");
  const nextBody = trimmedBody.length === 0 ? appended : `${trimmedBody}\n\n${appended}`;

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

  return { ok: true, config: saved.config };
}

type SetNameResult = { ok: true; config: AgentConfig } | { ok: false; error: string };

/**
 * Rename the caller's /personal agent — used by the onboarding agent-setup step, where the user
 * names their agent before the first session.
 *
 * The `.agent` source title and the `agents.name` column are kept in lockstep everywhere else (see
 * {@link derivePersonalAgentSave}, which serializes the source using `agent.name`), so we re-derive
 * and re-serialize with the new name rather than poking `agents.name` alone — otherwise the stored
 * source/hash would drift from the displayed name. Local-only and scoped to the caller's own default
 * agent, like {@link updatePersonalAgentBehavior}.
 */
export async function setPersonalAgentName(agentId: string, name: string): Promise<SetNameResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Enter a name for your agent." };
  if (trimmed.length > 60) return { ok: false, error: "Keep the agent name under 60 characters." };

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

  const saved = await derivePersonalAgentSave(
    { name: trimmed, config: agent.config },
    workspace.id,
    agent.body,
  );
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

  return { ok: true, config: saved.config };
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

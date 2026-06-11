import {
  agentBundleDir,
  agentPathForSlug,
  buildAgentTiptapDoc,
  buildConfigMentionResolver,
  deriveAgentConfigFromBody,
  FIXED_PERSONAL_AGENT_NAME,
  ONBOARDING_SKILL_ID,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import type { AgentConfig, AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { buildPendingAgent, newAgentId } from "@/lib/agents/create";
import { hashAgentSource } from "@/lib/agents/hash";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";

// The /personal experiment agent defaults to Kimi for long-horizon coding and agent workflows.
const PERSONAL_AGENT_MODEL: AgentModelId = "moonshotai/kimi-k2.6";

// Self-contained starter instructions. The /personal agent's richer operating guidance lives in
// agent/soul.md (seeded at creation, see DEFAULT_PERSONAL_SOUL_MD). It has no @brain/ mounts, so
// the body must NOT reference those — none exist for it. The @-mentions below are the source of
// truth for the default capability set: deriveAgentConfigFromBody turns the tool mentions
// (@exa/@youtube/@instagram research, @gmail/@google_calendar/@slack integrations) and the
// @skill/ mentions (first-principles, humanizer) into the runtime config.
const PERSONAL_AGENT_BODY = `You are ${FIXED_PERSONAL_AGENT_NAME}, {{userName}}'s personal agent.

Before doing any work, read agent/soul.md — it's how you operate and who you serve. Keep it current as you learn.

Be concise and bias to action. Research before you assert and cite what you find. Confirm before anything destructive or outward-facing.

Your reach:

- Research: search the web and fetch pages with @exa, pull video transcripts and channel context with @youtube, and read public profiles, posts, and comments with @instagram.
- {{userName}}'s world: read their mail with @gmail, manage their schedule with @google_calendar, and work their team's channels with @slack. Everything you see there is private — never quote or forward it outward without asking first. If a connection isn't set up yet, say so and point them to settings instead of guessing.

How you think and write:

- For hard or high-stakes decisions, reason with @skill/first-principles instead of pattern-matching the conventional answer.
- Anything written for a person — an email draft, a post, a summary, a doc — goes through @skill/humanizer: plain words, varied rhythm, no AI gloss.

You have a personal inbox for {{userName}}. When you produce something they should see but should not be interrupted for synchronously — a finding, a finished result, a heads-up, or something that needs their decision — post it with inbox_add (a short, action-oriented title; detail in body; the steps you took in steps). This is how scheduled or background runs reach them. Call inbox_list first and reuse a stable dedup_key so repeated runs don't post duplicates, and call inbox_update to mark an item done once you've resolved it. Use the inbox for asynchronous attention; use ask_user_question only when you must block on their answer to continue right now.`;

// Default operating doc seeded into the /personal agent's private folder (agent/soul.md). Tailored
// to the personal agent: no @brain/ mounts (it has none), and it leans on the personal inbox. The
// angle-bracket placeholders are the agent's to fill in and evolve as it learns. {{userName}} is
// substituted at creation. Keep it short; it's the agent's to evolve via edit_file.
export const DEFAULT_PERSONAL_SOUL_MD = `# ${FIXED_PERSONAL_AGENT_NAME} - soul

This is how I, ${FIXED_PERSONAL_AGENT_NAME}, operate for {{userName}}. I read it before any work and keep it current as I learn.

## Who I serve

{{userName}}. <what they care about - I keep this current as I learn>

## How I work

- I am direct, sharp, and relentlessly honest. I say what I mean without padding it.
- I push back when the user is wrong, wrong-headed, or avoiding the real problem.
- I do not perform helpfulness; I practice it.
- I am a builder. I care about things that work, not things that sound good.
- I move fast, bias to action, and expect clear momentum from the people around me.
- I am warm without being soft. I show care through precision, not reassurance.
- When the user is stuck, I reframe the question. When they are spiraling, I ground them in the next move.
- I optimize for substance over polish, action over alignment, and truth over comfort.
- I write like a person: plain words, varied rhythm, no AI gloss.
- I research before I assert and cite what I find.
- I confirm before anything destructive or outward-facing.

## How I reach {{userName}}

- For things {{userName}} should see but shouldn't be interrupted for, I post to the inbox (inbox_add) with a short title, detail, and the steps I took; I reuse a stable dedup_key and mark items done with inbox_update.
- I use ask_user_question only when I must block on an answer to continue right now.

## What good looks like

<tuned to {{userName}}'s focus as I learn>
`;

// Starter note for the personal agent's Personal Brain (personal-brain/README.md). Personal Brain is
// the user's own knowledge space, distinct from Memory (the agent's distilled understanding). Kept
// short — it's the user's to edit and grow.
export const DEFAULT_PERSONAL_BRAIN_README = `# {{userName}}'s Personal Brain

This is your private knowledge space. Save notes, research, decisions, and reference material here — it persists across sessions and your agent can read from it.

This is different from Memory: Personal Brain holds your own files; Memory is what your agent distills about you over time.
`;

const EMPTY_TIPTAP_DOC: TiptapDoc = { type: "doc", content: [] };

function personalAgentBodyForUser(userName: string) {
  return PERSONAL_AGENT_BODY.replaceAll("{{userName}}", userName);
}

function personalizeTemplate(template: string, userName: string) {
  return template.replaceAll("{{userName}}", userName);
}

function ensureFixedPersonalAgentIdentity(body: string, userName: string) {
  const identity = `You are ${FIXED_PERSONAL_AGENT_NAME}, ${userName}'s personal agent.`;
  const trimmedStart = body.trimStart();
  if (trimmedStart.startsWith(`You are ${FIXED_PERSONAL_AGENT_NAME},`)) return body;
  if (/^You are .+?'s personal agent\./.test(trimmedStart)) {
    return body.replace(/^(\s*)You are .+?'s personal agent\./, `$1${identity}`);
  }
  return `${identity}\n\n${trimmedStart}`;
}

function ensureFixedPersonalSoulIdentity(content: string, userName: string) {
  let next = content.replaceAll("{{name}}", userName).replaceAll("{{userName}}", userName);
  next = next.replace(
    /^# .+?'s personal agent [—-] soul/m,
    `# ${FIXED_PERSONAL_AGENT_NAME} - soul`,
  );
  next = next.replace(
    /^This is how I operate for .+?\. I read it before any work and keep it current as I learn\./m,
    `This is how I, ${FIXED_PERSONAL_AGENT_NAME}, operate for ${userName}. I read it before any work and keep it current as I learn.`,
  );
  if (next.includes(FIXED_PERSONAL_AGENT_NAME)) return next;
  return `# ${FIXED_PERSONAL_AGENT_NAME} - soul\n\nThis is how I, ${FIXED_PERSONAL_AGENT_NAME}, operate for ${userName}. I read it before any work and keep it current as I learn.\n\n${next.trimStart()}`;
}

function buildFixedPersonalAgentSource(config: AgentConfig, body: string) {
  return serializeAgentFile({
    title: FIXED_PERSONAL_AGENT_NAME,
    body,
    model: config.model.name,
    tools: config.tools,
    brain: config.brain,
    agents: config.agents ?? [],
    skills: config.skills ?? [],
    integrations: config.integrations,
    triggers: config.triggers,
  });
}

export type PersonalAgentRef = {
  id: string;
  name: string;
  defaultModel: string;
  path: string | null;
  // The full resolved `.agent` config (tools, skills, integrations, triggers) plus the
  // editable behavior — surfaced by the /personal sidebar and the behavior editor.
  config: AgentConfig;
  body: string;
  content: TiptapDoc;
};

/**
 * Ensure the caller has a private default agent for the /personal experiment.
 *
 * Idempotent per (workspace, user) — backed by the partial unique index
 * `agents_workspace_user_default_idx`.
 *
 * The agent is local-only in the sense that it is never projected to GitHub: we deliberately
 * skip enqueuing a workspace_sync_job, and the projector drains only the sync outbox, so an
 * agent with no job is never committed. It still gets a per-user-unique `path` because the
 * runner's bundle materialization (materializeAgentBundleForSession → loadAgentBundle) throws
 * on a null path; the path is an internal bundle identifier, not a synced repo file.
 */
export async function ensurePersonalAgent(input: {
  userId: string;
  workspaceId: string;
  userName: string;
}): Promise<PersonalAgentRef> {
  const db = getDb();

  const [existing] = await db
    .select({
      id: agents.id,
      name: agents.name,
      path: agents.path,
      body: agents.body,
      content: agents.content,
      config: agents.config,
      version: agents.version,
    })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, input.workspaceId),
        eq(agents.userId, input.userId),
        eq(agents.isDefault, true),
      ),
    )
    .limit(1);

  if (existing) {
    const userName = input.userName.trim() || "you";
    const normalizedBody = ensureFixedPersonalAgentIdentity(existing.body, userName);
    const normalizedConfig: AgentConfig = {
      ...existing.config,
      title: FIXED_PERSONAL_AGENT_NAME,
      instructions: normalizedBody,
    };
    const normalizedSource = buildFixedPersonalAgentSource(normalizedConfig, normalizedBody);
    const needsIdentityUpdate =
      existing.name !== FIXED_PERSONAL_AGENT_NAME ||
      existing.config.title !== FIXED_PERSONAL_AGENT_NAME ||
      existing.body !== normalizedBody;

    if (needsIdentityUpdate) {
      const content = buildAgentTiptapDoc(
        normalizedBody,
        buildConfigMentionResolver(normalizedConfig),
      );
      await db
        .update(agents)
        .set({
          name: FIXED_PERSONAL_AGENT_NAME,
          body: normalizedBody,
          content,
          contentHash: hashAgentSource(normalizedSource),
          version: existing.version + 1,
          config: normalizedConfig,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, existing.id), eq(agents.workspaceId, input.workspaceId)));
    }

    if (existing.path) {
      const soulPath = `${agentBundleDir(existing.path)}/soul.md`;
      const [soulFile] = await db
        .select({ content: agentFiles.content })
        .from(agentFiles)
        .where(
          and(
            eq(agentFiles.workspaceId, input.workspaceId),
            eq(agentFiles.agentId, existing.id),
            eq(agentFiles.path, soulPath),
          ),
        )
        .limit(1);

      if (soulFile) {
        const normalizedSoul = ensureFixedPersonalSoulIdentity(soulFile.content, userName);
        if (normalizedSoul !== soulFile.content) {
          await db
            .update(agentFiles)
            .set({
              content: normalizedSoul,
              contentHash: hashBrainContent(normalizedSoul),
              sizeBytes: brainContentSize(normalizedSoul),
              githubSyncStatus: "synced",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(agentFiles.workspaceId, input.workspaceId),
                eq(agentFiles.agentId, existing.id),
                eq(agentFiles.path, soulPath),
              ),
            );
        }
      }
    }

    return {
      id: existing.id,
      name: FIXED_PERSONAL_AGENT_NAME,
      defaultModel: normalizedConfig.model.name,
      path: existing.path,
      config: normalizedConfig,
      body: normalizedBody,
      content: needsIdentityUpdate
        ? buildAgentTiptapDoc(normalizedBody, buildConfigMentionResolver(normalizedConfig))
        : (existing.content ?? EMPTY_TIPTAP_DOC),
    };
  }

  // Per-user-unique path derived from the agent id keeps the (workspace, path) unique index
  // satisfied across multiple users' personal agents and gives the runner a bundle dir.
  const id = newAgentId();
  const path = agentPathForSlug(`personal-${id.replace(/[^a-z0-9]/g, "")}`);

  // Reuse buildPendingAgent so id/path/version/hash stay well-formed; we keep pending.agent but
  // discard pending.syncJob (never enqueued).
  const pending = buildPendingAgent({
    id,
    workspaceId: input.workspaceId,
    title: FIXED_PERSONAL_AGENT_NAME,
    body: personalAgentBodyForUser(input.userName),
    path,
    model: PERSONAL_AGENT_MODEL,
  });

  // Derive the runtime config from the body so the `@exa` mention becomes a well-formed web tool
  // (web_fetch/exa_search), then enable the dormant onboarding skill. The skill is
  // defaultEnabled:false, so it is present only because we list it here, and only read when the
  // onboarding session explicitly points the agent at it (see createPersonalOnboardingSession).
  const { body, config } = deriveAgentConfigFromBody({
    title: FIXED_PERSONAL_AGENT_NAME,
    body: pending.agent.body,
    model: PERSONAL_AGENT_MODEL,
    repositories: [],
  });
  config.skills = [...(config.skills ?? []), { id: ONBOARDING_SKILL_ID }];

  // Seed the agent's private operating doc (agent/soul.md) in the same batch as the agent row,
  // so a brand-new personal agent always mounts a soul.md into ./agent on its first session.
  const soul = personalizeTemplate(DEFAULT_PERSONAL_SOUL_MD, input.userName);
  const soulPath = `${agentBundleDir(path)}/soul.md`;
  const soulHash = hashBrainContent(soul);

  // Seed a starter Personal Brain note. Personal Brain is the user's private, persistent knowledge
  // space — stored in the bundle under personal-brain/ and surfaced by /personal/brain. Local-only,
  // like the rest of the personal agent.
  const personalBrainReadme = personalizeTemplate(DEFAULT_PERSONAL_BRAIN_README, input.userName);
  const personalBrainReadmePath = `${agentBundleDir(path)}/personal-brain/README.md`;
  const personalBrainReadmeHash = hashBrainContent(personalBrainReadme);

  await db.batch([
    db.insert(agents).values({
      ...pending.agent,
      body,
      config,
      userId: input.userId,
      isDefault: true,
      // Local-only: no GitHub sync lifecycle, so no pending work. Nothing enqueues from this
      // field; the projector keys off the sync outbox, which we intentionally leave empty.
      githubSyncStatus: "synced",
    }),
    // Local-only too: we deliberately skip the agent_file sync job (unlike leo's onboarding seed),
    // so soul.md is never projected to GitHub — consistent with the personal agent itself.
    db.insert(agentFiles).values({
      workspaceId: input.workspaceId,
      agentId: id,
      path: soulPath,
      content: soul,
      contentHash: soulHash,
      sizeBytes: brainContentSize(soul),
      githubSyncStatus: "synced",
    }),
    db.insert(agentFiles).values({
      workspaceId: input.workspaceId,
      agentId: id,
      path: personalBrainReadmePath,
      content: personalBrainReadme,
      contentHash: personalBrainReadmeHash,
      sizeBytes: brainContentSize(personalBrainReadme),
      githubSyncStatus: "synced",
    }),
  ]);

  await captureServerEvent("agent_created", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: pending.id,
  });

  return {
    id: pending.id,
    name: config.title,
    defaultModel: config.model.name,
    path: pending.agent.path,
    config,
    body,
    content: EMPTY_TIPTAP_DOC,
  };
}

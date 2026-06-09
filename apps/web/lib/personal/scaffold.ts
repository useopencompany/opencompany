import {
  agentBundleDir,
  agentPathForSlug,
  deriveAgentConfigFromBody,
  ONBOARDING_SKILL_ID,
} from "@opencompany/agent-runtime";
import type { AgentConfig, AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { buildPendingAgent, newAgentId } from "@/lib/agents/create";
import { brainContentSize, hashBrainContent } from "@/lib/brain/hash";

// The /personal experiment agent is a low-latency, capable default. Mirrors leo's choice.
const PERSONAL_AGENT_MODEL: AgentModelId = "minimax/minimax-m2.7-highspeed";

// Self-contained starter instructions. The /personal agent's richer operating guidance lives in
// agent/soul.md (seeded at creation, see DEFAULT_PERSONAL_SOUL_MD). It has no @brain/ mounts, so
// the body must NOT reference those — none exist for it.
const PERSONAL_AGENT_BODY = `You are {{name}}'s personal agent.

Before doing any work, read agent/soul.md — it's how you operate and who you serve. Keep it current as you learn.

Be concise and bias to action. Research before you assert and cite what you find — you can search the web and fetch pages with @exa. Confirm before anything destructive or outward-facing.

You have a personal inbox for {{name}}. When you produce something they should see but should not be interrupted for synchronously — a finding, a finished result, a heads-up, or something that needs their decision — post it with inbox_add (a short, action-oriented title; detail in body; the steps you took in steps). This is how scheduled or background runs reach them. Call inbox_list first and reuse a stable dedup_key so repeated runs don't post duplicates, and call inbox_update to mark an item done once you've resolved it. Use the inbox for asynchronous attention; use ask_user_question only when you must block on their answer to continue right now.`;

// Default operating doc seeded into the /personal agent's private folder (agent/soul.md). Tailored
// to the personal agent: no @brain/ mounts (it has none), and it leans on the personal inbox. The
// angle-bracket placeholders are the agent's to fill in and evolve as it learns. {{name}} is
// substituted at creation. Keep it short; it's the agent's to evolve via edit_file.
export const DEFAULT_PERSONAL_SOUL_MD = `# {{name}}'s personal agent — soul

This is how I operate for {{name}}. I read it before any work and keep it current as I learn.

## Who I serve

{{name}}. <what they care about — I keep this current as I learn>

## How I work

- I'm concise and bias to action.
- I research before I assert and cite what I find.
- I confirm before anything destructive or outward-facing.

## How I reach {{name}}

- For things {{name}} should see but shouldn't be interrupted for, I post to the inbox (inbox_add) with a short title, detail, and the steps I took; I reuse a stable dedup_key and mark items done with inbox_update.
- I use ask_user_question only when I must block on an answer to continue right now.

## What good looks like

<tuned to {{name}}'s focus as I learn>
`;

const EMPTY_TIPTAP_DOC: TiptapDoc = { type: "doc", content: [] };

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
  name: string;
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
    return {
      id: existing.id,
      name: existing.name,
      defaultModel: existing.config.model.name,
      path: existing.path,
      config: existing.config,
      body: existing.body,
      content: existing.content ?? EMPTY_TIPTAP_DOC,
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
    title: input.name,
    body: PERSONAL_AGENT_BODY.replaceAll("{{name}}", input.name),
    path,
    model: PERSONAL_AGENT_MODEL,
  });

  // Derive the runtime config from the body so the `@exa` mention becomes a well-formed web tool
  // (web_fetch/exa_search), then enable the dormant onboarding skill. The skill is
  // defaultEnabled:false, so it is present only because we list it here, and only read when the
  // onboarding session explicitly points the agent at it (see createPersonalOnboardingSession).
  const { body, config } = deriveAgentConfigFromBody({
    title: input.name,
    body: pending.agent.body,
    model: PERSONAL_AGENT_MODEL,
    repositories: [],
  });
  config.skills = [...(config.skills ?? []), { id: ONBOARDING_SKILL_ID }];

  // Seed the agent's private operating doc (agent/soul.md) in the same batch as the agent row,
  // so a brand-new personal agent always mounts a soul.md into ./agent on its first session.
  const soul = DEFAULT_PERSONAL_SOUL_MD.replaceAll("{{name}}", input.name);
  const soulPath = `${agentBundleDir(path)}/soul.md`;
  const soulHash = hashBrainContent(soul);

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

import { createHash } from "node:crypto";
import {
  AGENT_SCHEDULE_TRIGGER_TYPE,
  type AgentConfig,
  type AgentExternalSkillReference,
  type AgentModelId,
  type AgentScheduleTriggerConfig,
  buildAgentTiptapDoc,
  buildConfigMentionResolver,
  collectBuiltinSkillMentions,
  extractMentionIds,
  FIXED_PERSONAL_AGENT_NAME,
  getAgentModelDefinition,
  isKnownAgentSkillId,
  isRemoteSkillReference,
  isSupportedScheduleCron,
  normalizeAgentConfig,
  normalizeScheduleTimezone,
  serializeAgentFile,
  validateAgentFileSource,
  workspaceSkillSourcePath,
} from "@opencompany/agent-runtime";
import { agentSessions, agents, workspaceSkills } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEventForLease, requireLeaseWrite } from "./lease-writes";

export type AgentSelfUpdateResult =
  | { ok: true; version: number; changedFields: string[]; summary?: string; appliesTo: string }
  | { ok: false; errors: string[] };

// Cap so a self-chosen name can't blow past the agent name column / UI; matches the practical
// limit elsewhere for agent titles.
const MAX_AGENT_TITLE_LENGTH = 80;

type ParsedArgs = {
  body: string;
  title?: string;
  model?: AgentModelId;
  summary?: string;
  // Present only when the caller passed `triggers`. Undefined means "keep current schedules";
  // an empty array means "remove all schedules". Holds only schedule triggers — GitHub PR
  // triggers are preserved separately and cannot be set through self-edit.
  scheduleTriggers?: AgentScheduleTriggerConfig[];
};

// Apply an agent's self-edit of its own .agent definition. Validates synchronously, persists
// to the authoritative DB row with an optimistic version guard, queues the async GitHub sync
// (the sync-outbox sweeper commits it), and emits an `agent.self_updated` event. On any
// validation/contention failure it returns { ok: false, errors } and nothing is written, so
// the model can fix the input and retry.
export async function applyAgentSelfUpdate(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  args: unknown;
}): Promise<AgentSelfUpdateResult> {
  const parsed = parseArgs(input.args);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const { body, title, model, summary, scheduleTriggers } = parsed.value;

  const db = getDb();
  const [row] = await db
    .select({
      agentId: agents.id,
      workspaceId: agents.workspaceId,
      path: agents.path,
      name: agents.name,
      isDefault: agents.isDefault,
      version: agents.version,
      config: agents.config,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(eq(agentSessions.id, input.sessionId))
    .limit(1);

  if (!row) {
    return { ok: false, errors: ["Could not load the current agent definition for this session."] };
  }

  const current = normalizeAgentConfig(row.config);
  if (row.isDefault && title && title !== FIXED_PERSONAL_AGENT_NAME) {
    return {
      ok: false,
      errors: [
        `The personal agent has a fixed identity. Keep the title "${FIXED_PERSONAL_AGENT_NAME}" and update the body instead.`,
      ],
    };
  }

  // The body is the source of truth: tools and brain follow its @mentions. The title changes only
  // when an explicit `title` is passed (otherwise the current name is kept); path, delegated
  // agents, and repositories are preserved — they cannot be changed through self-edit in this
  // version. Built-in and workspace-authored skills follow the body's `@skill/<id>` mentions
  // (add by mentioning, remove by dropping the mention); remote GitHub/skills.sh skills are
  // preserved as-is because adding/removing those remains editor-managed. The model changes only
  // via the explicit `model` argument; otherwise the current model is kept. Schedule triggers are
  // replaced wholesale when `triggers` is provided (omitted = keep current); GitHub PR triggers are
  // always preserved, since they reference repositories the agent cannot manage here.
  const preservedNonScheduleTriggers = current.triggers.filter(
    (trigger) => trigger.type !== AGENT_SCHEDULE_TRIGGER_TYPE,
  );
  const nextTriggers =
    scheduleTriggers === undefined
      ? current.triggers
      : [...scheduleTriggers, ...preservedNonScheduleTriggers];

  const preservedRemoteSkills = (current.skills ?? []).filter(isRemoteSkillReference);
  const workspaceSkillMentions = await resolveWorkspaceSkillMentions({
    db,
    workspaceId: row.workspaceId,
    body,
  });
  const nextSkills = [
    ...collectBuiltinSkillMentions(body),
    ...preservedRemoteSkills,
    ...workspaceSkillMentions,
  ];

  const source = serializeAgentFile({
    title: row.isDefault ? FIXED_PERSONAL_AGENT_NAME : (title ?? row.name),
    body,
    engine: current.engine,
    model: model ?? current.model.name,
    agents: current.agents ?? [],
    skills: nextSkills,
    integrations: current.integrations,
    triggers: nextTriggers,
  });

  const validation = validateAgentFileSource(source);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const nextConfig = validation.parsed.config;

  // Rebuild the Tiptap "pill" doc the agent detail page renders, mirroring what
  // the web editor persists. Built from the normalized parsed body (the value
  // we store below) so it round-trips and the detail page renders these pills
  // instead of falling back to a lossy text-only rebuild that drops mentions.
  const content = buildAgentTiptapDoc(
    validation.parsed.body,
    buildConfigMentionResolver(nextConfig),
  );

  const contentHash = hashAgentSource(source);
  const nextVersion = row.version + 1;
  const now = new Date();

  // Optimistic concurrency: only write if the version is still what we read, so a
  // simultaneous editor save isn't silently clobbered.
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(agents)
      .set({
        name: validation.parsed.title,
        body: validation.parsed.body,
        content,
        config: nextConfig,
        contentHash,
        version: nextVersion,
        githubSyncStatus: "pending",
        githubSyncError: null,
        updatedAt: now,
      })
      .where(and(eq(agents.id, row.agentId), eq(agents.version, row.version)))
      .returning({ id: agents.id });

    // Enqueue the unified workspace projection; the sync-outbox sweeper (runs every
    // minute) commits the .agent file along with any other pending workspace
    // changes in one commit. Only possible once the agent has a path.
    if (rows.length > 0 && row.path) {
      await enqueueWorkspaceSync(tx, {
        workspaceId: row.workspaceId,
        repoPath: row.path,
        sourceKind: "agent",
        sourceRef: row.agentId,
        operation: "upsert",
        desiredHash: contentHash,
        delayMs: 0,
      });
    }

    return rows;
  });

  if (updated.length === 0) {
    return {
      ok: false,
      errors: [
        "The agent definition changed while you were editing it. Re-read your current definition and try again.",
      ],
    };
  }

  const changedFields = diffChangedFields(current, nextConfig);
  // Title isn't part of AgentConfig, so diffChangedFields can't see it — surface a rename here.
  if (!row.isDefault && title && title !== row.name) changedFields.push("name");

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "agent.self_updated",
      payload: {
        version: nextVersion,
        changedFields,
        ...(summary ? { summary } : {}),
      },
    }),
  );

  return {
    ok: true,
    version: nextVersion,
    changedFields,
    ...(summary ? { summary } : {}),
    appliesTo: `Saved (version ${nextVersion}). This is live from your next turn in this same session — your next reply (or the user's next message) uses the updated tools, instructions, skills, model, and schedules. No new session needed; only the reply you're finishing now keeps the previous configuration.`,
  };
}

async function resolveWorkspaceSkillMentions(input: {
  db: ReturnType<typeof getDb>;
  workspaceId: string;
  body: string;
}): Promise<AgentExternalSkillReference[]> {
  const ids = collectMentionedWorkspaceSkillIds(input.body);
  if (ids.length === 0) return [];

  const rows = await input.db
    .select({
      skillId: workspaceSkills.skillId,
      name: workspaceSkills.name,
      description: workspaceSkills.description,
    })
    .from(workspaceSkills)
    .where(
      and(
        eq(workspaceSkills.workspaceId, input.workspaceId),
        inArray(workspaceSkills.skillId, ids),
      ),
    );
  const byId = new Map(rows.map((row) => [row.skillId, row]));

  return ids.flatMap((id) => {
    const skill = byId.get(id);
    if (!skill) return [];
    return [
      {
        id: skill.skillId,
        name: skill.name,
        description: skill.description,
        source: {
          type: "workspace" as const,
          path: workspaceSkillSourcePath(skill.skillId),
        },
      },
    ];
  });
}

function collectMentionedWorkspaceSkillIds(body: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const rawId of extractMentionIds(body)) {
    if (!rawId.toLowerCase().startsWith("skill/")) continue;
    const id = rawId.slice("skill/".length).toLowerCase();
    if (!id || isKnownAgentSkillId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function parseArgs(
  value: unknown,
): { ok: true; value: ParsedArgs } | { ok: false; errors: string[] } {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const errors: string[] = [];

  const body = typeof record.body === "string" ? record.body : "";
  if (!body.trim()) {
    errors.push("`body` is required and must be a non-empty string.");
  }

  let title: string | undefined;
  if (record.title !== undefined) {
    if (typeof record.title !== "string" || !record.title.trim()) {
      errors.push("`title` must be a non-empty string when provided.");
    } else if (record.title.trim().length > MAX_AGENT_TITLE_LENGTH) {
      errors.push(`\`title\` must be ${MAX_AGENT_TITLE_LENGTH} characters or fewer.`);
    } else {
      title = record.title.trim();
    }
  }

  let model: AgentModelId | undefined;
  if (record.model !== undefined) {
    if (typeof record.model !== "string" || !getAgentModelDefinition(record.model)) {
      errors.push(`Unknown model "${String(record.model)}". Use one of the supported model ids.`);
    } else {
      model = record.model as AgentModelId;
    }
  }

  const summary =
    typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : undefined;

  let scheduleTriggers: AgentScheduleTriggerConfig[] | undefined;
  if (record.triggers !== undefined) {
    const result = parseScheduleTriggers(record.triggers);
    if (result.ok) scheduleTriggers = result.value;
    else errors.push(...result.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      body,
      ...(title ? { title } : {}),
      ...(model ? { model } : {}),
      ...(summary ? { summary } : {}),
      ...(scheduleTriggers ? { scheduleTriggers } : {}),
    },
  };
}

const CRON_SHAPES_HINT =
  "Supported shapes: '*/N * * * *' (every N minutes, N=1-59), '0 */N * * *' (every N hours, N in {1,2,3,4,6,8,12}), 'M H * * *' (daily), 'M H * * 1-5' (weekdays), or 'M H * * D' (weekly, D=0-6).";

// Validate the caller's `triggers` argument into schedule triggers, reporting errors instead
// of silently dropping malformed entries (serializeAgentFile's normalizeTriggers would drop
// them). Returns an array (possibly empty) so the caller can distinguish "clear all" from the
// "keep current" case, which is signaled by `triggers` being absent entirely.
function parseScheduleTriggers(
  value: unknown,
): { ok: true; value: AgentScheduleTriggerConfig[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      errors: [
        "`triggers` must be an array of schedule triggers, or omit it to keep your current schedules.",
      ],
    };
  }

  const errors: string[] = [];
  const triggers: AgentScheduleTriggerConfig[] = [];
  const seenIds = new Set<string>();

  value.forEach((item, index) => {
    const label = `triggers[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${label} must be an object with \`cron\` and \`prompt\`.`);
      return;
    }
    const record = item as Record<string, unknown>;

    const cron = typeof record.cron === "string" ? record.cron.trim() : "";
    if (!cron) {
      errors.push(`${label}: \`cron\` is required.`);
    } else if (!isSupportedScheduleCron(cron)) {
      errors.push(`${label}: unsupported cron "${cron}". ${CRON_SHAPES_HINT}`);
    }

    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) {
      errors.push(`${label}: \`prompt\` is required and must be a non-empty string.`);
    }

    let id = `schedule-${index + 1}`;
    if (record.id !== undefined) {
      if (typeof record.id !== "string" || !record.id.trim()) {
        errors.push(`${label}: \`id\` must be a non-empty string when provided.`);
      } else {
        id = record.id.trim();
      }
    }
    if (seenIds.has(id)) {
      errors.push(`${label}: duplicate trigger id "${id}".`);
    } else {
      seenIds.add(id);
    }

    if (cron && isSupportedScheduleCron(cron) && prompt) {
      triggers.push({
        id,
        type: AGENT_SCHEDULE_TRIGGER_TYPE,
        cron,
        timezone: normalizeScheduleTimezone(
          typeof record.timezone === "string" ? record.timezone : undefined,
        ),
        prompt,
        enabled: record.enabled === true,
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: triggers };
}

function diffChangedFields(previous: AgentConfig, next: AgentConfig): string[] {
  const changed: string[] = [];
  if (previous.instructions !== next.instructions) changed.push("instructions");
  if (previous.model.name !== next.model.name) changed.push("model");
  if (toolIdSignature(previous) !== toolIdSignature(next)) changed.push("tools");
  if (brainSignature(previous) !== brainSignature(next)) changed.push("brain");
  if (skillIdSignature(previous) !== skillIdSignature(next)) changed.push("skills");
  if (triggerSignature(previous) !== triggerSignature(next)) changed.push("triggers");
  return changed;
}

function skillIdSignature(config: AgentConfig) {
  return [...(config.skills ?? []).map((skill) => skill.id)].sort().join(",");
}

function triggerSignature(config: AgentConfig) {
  return [...config.triggers]
    .map((trigger) =>
      trigger.type === AGENT_SCHEDULE_TRIGGER_TYPE
        ? `schedule:${trigger.id}|${trigger.cron}|${trigger.timezone}|${trigger.enabled}|${trigger.prompt}`
        : `${trigger.type}:${trigger.id}`,
    )
    .sort()
    .join(",");
}

function toolIdSignature(config: AgentConfig) {
  return [...config.tools.map((tool) => tool.id)].sort().join(",");
}

function brainSignature(config: AgentConfig) {
  return [...config.brain.map((reference) => `${reference.type}:${reference.path}`)]
    .sort()
    .join(",");
}

function hashAgentSource(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

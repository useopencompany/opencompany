import { createHash } from "node:crypto";
import {
  type AgentConfig,
  type AgentModelId,
  getAgentModelDefinition,
  normalizeAgentConfig,
  serializeAgentFile,
  validateAgentFileSource,
} from "@opencompany/agent-runtime";
import { agentSessions, agentSyncJobs, agents } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEventForLease, requireLeaseWrite } from "./lease-writes";

export type AgentSelfUpdateResult =
  | { ok: true; version: number; changedFields: string[]; summary?: string; appliesTo: string }
  | { ok: false; errors: string[] };

type ParsedArgs = { body: string; model?: AgentModelId; summary?: string };

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
  const { body, model, summary } = parsed.value;

  const db = getDb();
  const [row] = await db
    .select({
      agentId: agents.id,
      workspaceId: agents.workspaceId,
      path: agents.path,
      name: agents.name,
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

  // The body is the source of truth: tools and brain follow its @mentions. Title/path,
  // delegated agents, repositories, triggers, and skills are preserved — they cannot be
  // changed through self-edit in this version. The model changes only via the explicit
  // `model` argument; otherwise the current model is kept.
  const source = serializeAgentFile({
    title: row.name,
    body,
    model: model ?? current.model.name,
    agents: current.agents ?? [],
    skills: current.skills ?? [],
    integrations: current.integrations,
    triggers: current.triggers,
  });

  const validation = validateAgentFileSource(source);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const nextConfig = validation.parsed.config;

  const contentHash = hashAgentSource(source);
  const nextVersion = row.version + 1;
  const now = new Date();

  // Optimistic concurrency: only write if the version is still what we read, so a
  // simultaneous editor save isn't silently clobbered.
  const updated = await db
    .update(agents)
    .set({
      name: validation.parsed.title,
      body: validation.parsed.body,
      config: nextConfig,
      contentHash,
      version: nextVersion,
      githubSyncStatus: "pending",
      githubSyncError: null,
      updatedAt: now,
    })
    .where(and(eq(agents.id, row.agentId), eq(agents.version, row.version)))
    .returning({ id: agents.id });

  if (updated.length === 0) {
    return {
      ok: false,
      errors: [
        "The agent definition changed while you were editing it. Re-read your current definition and try again.",
      ],
    };
  }

  // Queue the GitHub sync the same way the web editor does; the sync-outbox sweeper
  // (runs every minute) commits the .agent file. Only possible once the agent has a path.
  if (row.path) {
    await db
      .insert(agentSyncJobs)
      .values({
        agentId: row.agentId,
        workspaceId: row.workspaceId,
        path: row.path,
        desiredHash: contentHash,
        desiredVersion: nextVersion,
        previousPath: null,
        previousBlobSha: null,
        status: "pending",
        attempts: 0,
        nextRunAt: now,
        lastError: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentSyncJobs.agentId,
        set: {
          path: row.path,
          desiredHash: contentHash,
          desiredVersion: nextVersion,
          previousPath: null,
          previousBlobSha: null,
          status: "pending",
          attempts: 0,
          nextRunAt: now,
          lastError: null,
          updatedAt: now,
        },
      });
  }

  const changedFields = diffChangedFields(current, nextConfig);

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
    appliesTo:
      "Saved. This takes effect on your next session — the current session keeps its existing configuration.",
  };
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

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { body, ...(model ? { model } : {}), ...(summary ? { summary } : {}) },
  };
}

function diffChangedFields(previous: AgentConfig, next: AgentConfig): string[] {
  const changed: string[] = [];
  if (previous.instructions !== next.instructions) changed.push("instructions");
  if (previous.model.name !== next.model.name) changed.push("model");
  if (toolIdSignature(previous) !== toolIdSignature(next)) changed.push("tools");
  if (brainSignature(previous) !== brainSignature(next)) changed.push("brain");
  return changed;
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

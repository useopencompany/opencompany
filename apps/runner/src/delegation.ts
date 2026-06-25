import {
  agentMentionIdForPath,
  newAgentSessionId,
  newAgentSessionMessageId,
  normalizeAgentConfig,
} from "@opencompany/agent-runtime";
import type { AgentEngine, AgentReference } from "@opencompany/agent-runtime/types";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
} from "@opencompany/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { emitDelegatedUsageRollup } from "./delegation-usage";
import { appendRuntimeEvent } from "./events";
import { enqueueRunnerJob } from "./jobs";
import {
  appendRuntimeEventForLease,
  insertToolMessageForLease,
  requireLeaseWrite,
} from "./lease-writes";
import {
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";
import { rowsFromExecute } from "./sql-exec";

export const MAX_AGENT_DELEGATION_DEPTH = 2;

// A child session counts as "still working" (the parent must keep waiting) for any status that is
// pre-run, actively running, or parked awaiting its OWN delegated children (it will auto-resume on
// its own, so the parent should keep waiting on it). Terminal-for-parent = it finished, failed, was
// archived, or parked for a HUMAN decision (approval/input) — there the parent resumes with whatever
// the child produced rather than block on a human who may never answer.
const CHILD_ACTIVE_STATUSES = new Set([
  "created",
  "ready",
  "provisioning",
  "running",
  "aborting",
  "archiving",
  "awaiting_delegation",
]);

export function isDelegatedChildActive(input: {
  status: string;
  runLeaseId: string | null;
}): boolean {
  return Boolean(input.runLeaseId) || CHILD_ACTIVE_STATUSES.has(input.status);
}

type DelegationFailure = {
  ok: false;
  status: "failed";
  error: string;
  childSessionId?: string;
  agentName?: string;
  agentPath?: string;
};

type DelegationSpawnSuccess = {
  ok: true;
  status: "running";
  childSessionId: string;
  childMessageId: string;
  agentName: string;
  agentPath: string;
  engine: AgentEngine;
  resumed: boolean;
};

// The delegate_to_agent tool execute() body for the async (wait:false) path: spawn a new child or
// continue an existing one, enqueue its run on the TARGET agent's own engine, and return its
// sessionId immediately. It never blocks — the parent coordinates with await_agents (wait:true is
// intercepted earlier, in model-stream-runner, so execute() only sees the async path).
export function createAgentDelegationHandler(input: {
  parentSessionId: string;
  parentMessageId: string;
  workspaceId: string;
  userId: string;
  depth: number;
  agentReferences: AgentReference[];
}) {
  return async ({
    agent,
    sessionId,
    prompt,
    toolCallId,
  }: {
    agent?: string;
    sessionId?: string;
    prompt: string;
    wait?: boolean;
    toolCallId: string;
  }): Promise<DelegationSpawnSuccess | DelegationFailure> => {
    const spawned = await spawnOrResumeDelegatedChild({
      agent,
      sessionId,
      prompt,
      toolCallId,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      depth: input.depth,
      agentReferences: input.agentReferences,
    });
    return spawned;
  };
}

// The await_agents tool execute() body (only reached when no child is still running, so the
// model-stream-runner let it through instead of suspending): report each targeted child's current
// state and final answer. Also the "poll" mode return.
export function createAwaitAgentsHandler(input: {
  parentSessionId: string;
  workspaceId: string;
  userId: string;
}) {
  return async ({ sessionIds }: { sessionIds?: string[]; mode?: string }) => {
    const targets = await resolveAwaitTargets({
      parentSessionId: input.parentSessionId,
      explicitSessionIds: sessionIds,
    });
    const states = await loadDelegatedChildrenStates(input.parentSessionId, targets);
    const agentsResult = states.map(toAwaitAgentResult);
    return {
      agents: agentsResult,
      pending: agentsResult.filter((agent) => agent.status === "running").length,
    };
  };
}

// Shared spawn/resume used by both the async execute() body and the wait:true suspension path.
// Validation (which references only existing rows) runs BEFORE any side effect, so the wait:true
// path can safely fall back to execute() on a validation failure without double-spawning.
export async function spawnOrResumeDelegatedChild(input: {
  agent?: string | undefined;
  sessionId?: string | undefined;
  prompt: string;
  toolCallId: string;
  parentSessionId: string;
  parentMessageId: string;
  workspaceId: string;
  userId: string;
  depth: number;
  agentReferences: AgentReference[];
}): Promise<DelegationSpawnSuccess | DelegationFailure> {
  if (input.depth >= MAX_AGENT_DELEGATION_DEPTH) {
    return {
      ok: false,
      status: "failed",
      error: `Agent delegation depth limit of ${MAX_AGENT_DELEGATION_DEPTH} was reached.`,
    };
  }

  if (input.sessionId) {
    return resumeDelegatedChild({
      childSessionId: input.sessionId,
      prompt: input.prompt,
      parentSessionId: input.parentSessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
  }

  if (!input.agent) {
    return {
      ok: false,
      status: "failed",
      error: "Agent is required when starting a delegated session.",
    };
  }

  const targetReference = resolveDelegatedAgentReference(input.agent, input.agentReferences);
  if (!targetReference) {
    return {
      ok: false,
      status: "failed",
      error: `Agent ${input.agent} is not configured for delegation in this agent.`,
    };
  }

  const target = await loadDelegatedAgent(input.workspaceId, targetReference.path);
  if (!target) {
    return {
      ok: false,
      status: "failed",
      agentPath: targetReference.path,
      error: `Agent ${targetReference.path} was not found in this workspace.`,
    };
  }

  const childSessionId = newAgentSessionId();
  const childMessageId = newAgentSessionMessageId();
  const engine = target.config.engine;
  await createDelegatedAgentSession({
    sessionId: childSessionId,
    messageId: childMessageId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentId: target.id,
    agentName: target.name,
    engine,
    modelProvider: engine === "codex" ? "openai" : target.config.model.provider,
    modelName: target.config.model.name,
    delegationDepth: input.depth + 1,
    prompt: input.prompt,
    parentSessionId: input.parentSessionId,
    parentMessageId: input.parentMessageId,
    toolCallId: input.toolCallId,
  });

  await enqueueDelegatedChildRun({ childSessionId, childMessageId, engine });

  return {
    ok: true,
    status: "running",
    childSessionId,
    childMessageId,
    agentName: target.name,
    agentPath: target.path ?? "",
    engine,
    resumed: false,
  };
}

async function resumeDelegatedChild(input: {
  childSessionId: string;
  prompt: string;
  parentSessionId: string;
  workspaceId: string;
  userId: string;
}): Promise<DelegationSpawnSuccess | DelegationFailure> {
  const child = await loadDelegatedChildSession({
    sessionId: input.childSessionId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!child) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      error: `Delegated child session ${input.childSessionId} was not found.`,
    };
  }
  if (child.parentSessionId !== input.parentSessionId) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      error: `Session ${input.childSessionId} is not a child session of this agent session.`,
    };
  }
  if (child.archivedAt) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath ?? "",
      error: `Delegated child session ${input.childSessionId} is archived.`,
    };
  }
  if (isDelegatedChildActive({ status: child.status, runLeaseId: child.runLeaseId })) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath ?? "",
      error: `Delegated child session ${input.childSessionId} is already running.`,
    };
  }

  const childMessageId = await appendDelegatedChildUserMessage({
    sessionId: input.childSessionId,
    prompt: input.prompt,
  });
  await enqueueDelegatedChildRun({
    childSessionId: input.childSessionId,
    childMessageId,
    engine: child.engine,
  });

  return {
    ok: true,
    status: "running",
    childSessionId: input.childSessionId,
    childMessageId,
    agentName: child.agentName,
    agentPath: child.agentPath ?? "",
    engine: child.engine,
    resumed: true,
  };
}

async function enqueueDelegatedChildRun(input: {
  childSessionId: string;
  childMessageId: string;
  engine: AgentEngine;
}) {
  await enqueueRunnerJob({
    kind: input.engine === "codex" ? "codex_turn" : "message",
    sessionId: input.childSessionId,
    messageId: input.childMessageId,
  });
}

// ---------------------------------------------------------------------------
// Suspension marker: written by the parent at suspend time (lease held), read back by the
// resume_delegation handler and the child-finish wake. One per (parentSessionId, toolCallId).
// ---------------------------------------------------------------------------

// Threaded into the model stream: at tool-start for await_agents / delegate_to_agent(wait) the
// stream runner asks whether the parent must suspend (and which children it awaits). Returning
// "proceed" lets the tool's execute() body run (async spawn / poll) instead.
export type DelegationSuspensionCheck = (input: {
  toolName: "delegate_to_agent" | "await_agents";
  toolInput: unknown;
  toolCallId: string;
  assistantMessageId: string;
}) => Promise<{ action: "suspend" } | { action: "proceed" }>;

export type DelegationAwaitMode = "all" | "any" | "poll";

type DelegationAwaitMarker = {
  toolCallId: string;
  toolName: "delegate_to_agent" | "await_agents";
  mode: DelegationAwaitMode;
  childSessionIds: string[];
  assistantMessageId: string;
};

// Decide whether the parent's await_agents / delegate_to_agent(wait) call must suspend, and if so
// record the marker that the resume + child-finish paths key off. Called at tool-start in
// model-stream-runner with the parent lease held.
//   - await_agents: targets pre-exist; suspend only if any is still running.
//   - delegate_to_agent(wait): spawn/resume first (the side effect commits only on success); on
//     success suspend waiting on the new child, on validation failure return "proceed" so the tool
//     execute() body re-runs the (idempotent, side-effect-free) validation and returns the error.
export async function prepareDelegationSuspension(input: {
  toolName: "delegate_to_agent" | "await_agents";
  toolInput: unknown;
  toolCallId: string;
  assistantMessageId: string;
  parentSessionId: string;
  parentMessageId: string;
  workspaceId: string;
  userId: string;
  depth: number;
  agentReferences: AgentReference[];
  leaseId: string;
  leaseOwner: string;
}): Promise<{ action: "suspend" } | { action: "proceed" }> {
  const args = readToolArgsObject(input.toolInput);

  if (input.toolName === "await_agents") {
    const explicit = readStringArray(args.sessionIds);
    const mode = normalizeAwaitMode(args.mode);
    const targets = await resolveAwaitTargets({
      parentSessionId: input.parentSessionId,
      explicitSessionIds: explicit.length > 0 ? explicit : undefined,
    });
    if (mode === "poll") return { action: "proceed" };
    const states = await loadDelegatedChildrenStates(input.parentSessionId, targets);
    if (delegationConditionMet(states, mode)) return { action: "proceed" };
    await writeDelegationAwaitMarker(input, {
      toolCallId: input.toolCallId,
      toolName: "await_agents",
      mode,
      childSessionIds: targets,
      assistantMessageId: input.assistantMessageId,
    });
    return { action: "suspend" };
  }

  // delegate_to_agent with wait:true — spawn/resume now, then suspend on the resulting child.
  const spawned = await spawnOrResumeDelegatedChild({
    agent: typeof args.agent === "string" ? args.agent : undefined,
    sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
    prompt: typeof args.prompt === "string" ? args.prompt : "",
    toolCallId: input.toolCallId,
    parentSessionId: input.parentSessionId,
    parentMessageId: input.parentMessageId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    depth: input.depth,
    agentReferences: input.agentReferences,
  });
  if (!spawned.ok) {
    // No side effect committed — let execute() re-run validation and surface the error to the model.
    return { action: "proceed" };
  }
  await writeDelegationAwaitMarker(input, {
    toolCallId: input.toolCallId,
    toolName: "delegate_to_agent",
    mode: "all",
    childSessionIds: [spawned.childSessionId],
    assistantMessageId: input.assistantMessageId,
  });
  return { action: "suspend" };
}

async function writeDelegationAwaitMarker(
  lease: { parentSessionId: string; parentMessageId: string; leaseId: string; leaseOwner: string },
  marker: DelegationAwaitMarker,
) {
  await appendRuntimeEvent(getDb(), {
    sessionId: lease.parentSessionId,
    messageId: marker.assistantMessageId,
    type: "delegation.awaiting",
    payload: {
      toolCallId: marker.toolCallId,
      toolName: marker.toolName,
      mode: marker.mode,
      childSessionIds: marker.childSessionIds,
      assistantMessageId: marker.assistantMessageId,
    },
  });
}

async function loadActiveDelegationAwaitMarker(
  parentSessionId: string,
): Promise<DelegationAwaitMarker | null> {
  const [row] = await getDb()
    .select({ payload: agentSessionEvents.payload })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, parentSessionId),
        eq(agentSessionEvents.type, "delegation.awaiting"),
      ),
    )
    .orderBy(desc(agentSessionEvents.id))
    .limit(1);
  if (!row) return null;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const toolName = payload.toolName === "await_agents" ? "await_agents" : "delegate_to_agent";
  return {
    toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
    toolName,
    mode: normalizeAwaitMode(payload.mode),
    childSessionIds: readStringArray(payload.childSessionIds),
    assistantMessageId:
      typeof payload.assistantMessageId === "string" ? payload.assistantMessageId : "",
  };
}

// ---------------------------------------------------------------------------
// Resume: a resume_delegation job runs this to decide whether the parent can continue yet.
// ---------------------------------------------------------------------------

export type DelegationResumeResolution =
  | { ready: false }
  | {
      ready: true;
      toolCallId: string;
      toolName: string;
      assistantMessageId: string;
      result: unknown;
    };

export async function resolveDelegationResume(input: {
  parentSessionId: string;
}): Promise<DelegationResumeResolution> {
  const marker = await loadActiveDelegationAwaitMarker(input.parentSessionId);
  if (!marker || !marker.toolCallId) return { ready: false };

  const states = await loadDelegatedChildrenStates(input.parentSessionId, marker.childSessionIds);
  if (!delegationConditionMet(states, marker.mode)) return { ready: false };

  const result =
    marker.toolName === "await_agents"
      ? {
          agents: states.map(toAwaitAgentResult),
          pending: 0,
        }
      : buildDelegateWaitResult(states[0]);

  return {
    ready: true,
    toolCallId: marker.toolCallId,
    toolName: marker.toolName,
    assistantMessageId: marker.assistantMessageId,
    result,
  };
}

function buildDelegateWaitResult(state: DelegatedChildState | undefined) {
  if (!state) {
    return {
      ok: false,
      status: "failed" as const,
      error: "Delegated child session was not found when resuming.",
    };
  }
  const result = toAwaitAgentResult(state);
  return {
    ok: result.status === "completed",
    status: result.status,
    childSessionId: state.id,
    agent: { name: state.agentName, path: state.agentPath },
    ...(result.answer !== undefined ? { answer: result.answer } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

// Build + persist the synthesized tool-result for the suspended delegation tool call, then the
// caller (resumeDelegation in agent-loop) continues the turn. Mirrors persistDeniedToolResult's tail.
export async function persistDelegationToolResult(input: {
  sessionId: string;
  assistantMessageId: string;
  leaseId: string;
  leaseOwner: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
}) {
  const toolMessageId = newAgentSessionMessageId();
  await requireLeaseWrite(
    insertToolMessageForLease({
      id: toolMessageId,
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      content: serializeToolOutputForStorage(input.result),
      modelMessage: toPersistedModelMessage(
        buildToolModelMessage({
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          output: input.result,
        }),
      ),
      toolName: input.toolName,
      toolCallId: input.toolCallId,
    }),
  );
  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      type: "tool.completed",
      payload: {
        messageId: input.assistantMessageId,
        toolCallId: input.toolCallId,
        name: input.toolName,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Child-finish hook: a delegated child reaching a terminal point rolls its usage up to the parent
// and wakes the parent if it is parked awaiting delegation. Mirrors the memory-keeper hook.
// ---------------------------------------------------------------------------

export async function completeDelegatedChildRunForParent(input: {
  childSessionId: string;
}): Promise<void> {
  const [child] = await getDb()
    .select({
      parentSessionId: agentSessions.parentSessionId,
      parentMessageId: agentSessions.parentMessageId,
      parentToolCallId: agentSessions.parentToolCallId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, input.childSessionId))
    .limit(1);
  if (!child?.parentSessionId) return;

  // Roll up this child's (sub)tree usage onto the parent. No parent lease is held now, so use the
  // non-lease variant; the delta/already-emitted dedup keeps it idempotent across retries/resumes.
  await emitDelegatedUsageRollup({
    parentSessionId: child.parentSessionId,
    parentMessageId: child.parentMessageId ?? null,
    childSessionId: input.childSessionId,
    parentToolCallId: child.parentToolCallId ?? "",
  });

  // Wake the parent only if it is currently parked awaiting delegation. Otherwise the parent has
  // not suspended yet (it may still be spawning siblings) — the backstop sweep wakes it once it
  // parks and all targets are terminal, so we never race ahead of the suspend.
  const [parent] = await getDb()
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, child.parentSessionId))
    .limit(1);
  if (parent?.status !== "awaiting_delegation") return;

  const marker = await loadActiveDelegationAwaitMarker(child.parentSessionId);
  if (!marker?.toolCallId) return;
  await enqueueRunnerJob({
    kind: "resume_delegation",
    sessionId: child.parentSessionId,
    messageId: marker.toolCallId,
  });
}

// ---------------------------------------------------------------------------
// Sweeps (wired into the runner's stale-run sweep).
// ---------------------------------------------------------------------------

// Lost-wake backstop: re-enqueue a resume for any parent parked awaiting delegation whose targeted
// children are all terminal (e.g. the final child finished before the parent suspended, or a wake
// enqueue was lost). Returns the number of parents re-woken.
export async function sweepDelegationBackstop(): Promise<number> {
  const parents = await getDb()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.status, "awaiting_delegation"))
    .limit(100);
  let rewoken = 0;
  for (const parent of parents) {
    const marker = await loadActiveDelegationAwaitMarker(parent.id);
    if (!marker?.toolCallId) continue;
    const states = await loadDelegatedChildrenStates(parent.id, marker.childSessionIds);
    if (!delegationConditionMet(states, marker.mode)) continue;
    await enqueueRunnerJob({
      kind: "resume_delegation",
      sessionId: parent.id,
      messageId: marker.toolCallId,
    });
    rewoken += 1;
  }
  return rewoken;
}

// Abort running children whose parent is no longer alive (archived/failed): there is no point
// finishing work for a dead parent. Returns the number of children marked for abort.
export async function sweepDeadParentDelegatedChildren(): Promise<number> {
  const result = await getDb().execute(sql`
    UPDATE agent_sessions AS child
    SET abort_requested_at = now(), updated_at = now()
    FROM agent_sessions AS parent
    WHERE child.parent_session_id = parent.id
      AND child.source = 'agent'
      AND child.abort_requested_at IS NULL
      AND child.status IN ('running', 'provisioning', 'aborting', 'created', 'ready')
      AND (parent.archived_at IS NOT NULL OR parent.status IN ('failed', 'archived'))
    RETURNING child.id
  `);
  return rowsFromExecute<{ id: string }>(result).length;
}

// ---------------------------------------------------------------------------
// Child state loading + result shaping
// ---------------------------------------------------------------------------

type DelegatedChildState = {
  id: string;
  status: string;
  runLeaseId: string | null;
  lastError: string | null;
  agentName: string;
  agentPath: string;
  answer: string | null;
};

async function loadDelegatedChildrenStates(
  parentSessionId: string,
  childSessionIds: string[],
): Promise<DelegatedChildState[]> {
  if (childSessionIds.length === 0) return [];
  const rows = await getDb()
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      runLeaseId: agentSessions.runLeaseId,
      lastError: agentSessions.lastError,
      agentName: agents.name,
      agentPath: agents.path,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        eq(agentSessions.parentSessionId, parentSessionId),
        inArray(agentSessions.id, childSessionIds),
      ),
    );
  const states: DelegatedChildState[] = [];
  for (const row of rows) {
    const answer = isDelegatedChildActive({ status: row.status, runLeaseId: row.runLeaseId })
      ? null
      : await loadLatestChildAnswer(row.id);
    states.push({ ...row, agentPath: row.agentPath ?? "", answer });
  }
  // Preserve the requested order so a delegate(wait) result reads states[0] deterministically.
  const byId = new Map(states.map((state) => [state.id, state]));
  return childSessionIds
    .map((id) => byId.get(id))
    .filter((state): state is DelegatedChildState => Boolean(state));
}

async function loadLatestChildAnswer(childSessionId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ content: agentSessionMessages.content })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, childSessionId),
        eq(agentSessionMessages.role, "assistant"),
        eq(agentSessionMessages.status, "completed"),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .orderBy(desc(agentSessionMessages.createdAt))
    .limit(1);
  const content = row?.content?.trim();
  return content ? content : null;
}

function toAwaitAgentResult(state: DelegatedChildState) {
  const active = isDelegatedChildActive({ status: state.status, runLeaseId: state.runLeaseId });
  if (active) {
    return {
      childSessionId: state.id,
      agent: { name: state.agentName, path: state.agentPath },
      status: "running" as const,
    };
  }
  if (state.answer) {
    return {
      childSessionId: state.id,
      agent: { name: state.agentName, path: state.agentPath },
      status: "completed" as const,
      answer: state.answer,
    };
  }
  return {
    childSessionId: state.id,
    agent: { name: state.agentName, path: state.agentPath },
    status: "failed" as const,
    error: state.lastError ?? "Delegated agent completed without a final answer.",
  };
}

function delegationConditionMet(states: DelegatedChildState[], mode: DelegationAwaitMode): boolean {
  if (states.length === 0) return true;
  const terminal = states.filter(
    (state) => !isDelegatedChildActive({ status: state.status, runLeaseId: state.runLeaseId }),
  );
  if (mode === "any") return terminal.length > 0;
  return terminal.length === states.length;
}

async function resolveAwaitTargets(input: {
  parentSessionId: string;
  explicitSessionIds?: string[] | undefined;
}): Promise<string[]> {
  if (input.explicitSessionIds && input.explicitSessionIds.length > 0) {
    return input.explicitSessionIds;
  }
  const rows = await getDb()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.parentSessionId, input.parentSessionId),
        eq(agentSessions.source, "agent"),
      ),
    );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Agent reference resolution + child session creation (mostly unchanged)
// ---------------------------------------------------------------------------

function resolveDelegatedAgentReference(agent: string, references: AgentReference[]) {
  const normalized = normalizeDelegatedAgentKey(agent);
  return references.find((reference) => {
    const path = reference.path;
    const mention = agentMentionIdForPath(path) ?? "";
    const slug = mention.startsWith("agent/") ? mention.slice("agent/".length) : "";
    return (
      normalizeDelegatedAgentKey(path) === normalized ||
      normalizeDelegatedAgentKey(mention) === normalized ||
      normalizeDelegatedAgentKey(slug) === normalized ||
      normalizeDelegatedAgentKey(reference.name) === normalized
    );
  });
}

function normalizeDelegatedAgentKey(value: string) {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/^agents\//, "agent/")
    .replace(/\/agent\.agent$/i, "")
    .toLowerCase();
}

async function loadDelegatedAgent(workspaceId: string, path: string) {
  const [agent] = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      path: agents.path,
      config: agents.config,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.path, path)))
    .limit(1);

  return agent ? { ...agent, config: normalizeAgentConfig(agent.config) } : null;
}

async function loadDelegatedChildSession(input: {
  sessionId: string;
  workspaceId: string;
  userId: string;
}) {
  const [session] = await getDb()
    .select({
      id: agentSessions.id,
      workspaceId: agentSessions.workspaceId,
      userId: agentSessions.userId,
      agentId: agentSessions.agentId,
      agentName: agents.name,
      agentPath: agents.path,
      status: agentSessions.status,
      engine: agentSessions.engine,
      source: agentSessions.source,
      parentSessionId: agentSessions.parentSessionId,
      runLeaseId: agentSessions.runLeaseId,
      archivedAt: agentSessions.archivedAt,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.workspaceId, input.workspaceId),
        eq(agentSessions.userId, input.userId),
        eq(agentSessions.source, "agent"),
      ),
    )
    .limit(1);

  return session ?? null;
}

async function appendDelegatedChildUserMessage(input: { sessionId: string; prompt: string }) {
  const now = new Date();
  const messageId = newAgentSessionMessageId();

  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessionMessages).values({
      id: messageId,
      sessionId: input.sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      messageId,
      type: "message.created",
      payload: {
        messageId,
        role: "user",
        content: input.prompt,
        status: "completed",
      },
    });
  });

  return messageId;
}

async function createDelegatedAgentSession(input: {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  agentName: string;
  engine: AgentEngine;
  modelProvider: string;
  modelName: string;
  delegationDepth: number;
  prompt: string;
  parentSessionId: string;
  parentMessageId: string;
  toolCallId: string;
}) {
  const now = new Date();
  // Codex sessions are created "ready" (they run their first turn on demand); opencompany
  // sessions are created "created" and provisioned by their first run. Mirrors web's
  // insertAgentSession engine split.
  const initialStatus = input.engine === "codex" ? "ready" : "created";
  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      title: delegationSessionTitle(input.agentName, input.prompt),
      status: initialStatus,
      source: "agent",
      engine: input.engine,
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      delegationDepth: input.delegationDepth,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentToolCallId: input.toolCallId,
    });
    await tx.insert(agentSessionMessages).values({
      id: input.messageId,
      sessionId: input.sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      type: "session.status",
      payload: {
        status: initialStatus,
        message: "Delegated agent session created",
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        toolCallId: input.toolCallId,
      },
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: "message.created",
      payload: {
        messageId: input.messageId,
        role: "user",
        content: input.prompt,
        status: "completed",
      },
    });
  });
}

function delegationSessionTitle(agentName: string, prompt: string) {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const suffix = firstLine ? `: ${firstLine}` : "";
  const title = `${agentName}${suffix}`;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

// ---------------------------------------------------------------------------
// Small input readers
// ---------------------------------------------------------------------------

function readToolArgsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeAwaitMode(value: unknown): DelegationAwaitMode {
  return value === "any" || value === "poll" ? value : "all";
}

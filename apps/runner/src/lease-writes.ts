import type { AgentRuntimeEvent, AgentSessionQuestionPrompt } from "@opencompany/agent-runtime";
import { agentSessions } from "@opencompany/db/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import {
  claimRunLease as claimDbRunLease,
  finishRunLease as finishDbRunLease,
} from "./run-control";
import { rowsFromExecute } from "./sql-exec";

// Session-execution lease helpers. See `jobs.ts` for the separate job-delivery lease;
// this layer owns in-flight model/tool execution and gates every persisted write so
// that a stale runner cannot stomp on a session that was reclaimed elsewhere.
//
// The guard is *enforced by the database*, not advisory: every lease-guarded write is
// a single conditional statement that only writes while the lease row is still ours
// (`WHERE EXISTS (lease current)`). There is no separate check-then-write window for a
// concurrent reclaim to slip through, and each guarded write costs one round-trip
// instead of two. Zero rows affected means the lease was lost. The DB writes live
// behind {@link LeaseWriteStore} so the behaviour is testable without a database; the
// durable event append carries the same guard inside `appendRuntimeEvent`.

export type LeaseIdentity = {
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
};

type AssistantMessageInsert = {
  id: string;
  sessionId: string;
  internal: boolean;
  responseToMessageId: string | null;
};

/**
 * Outcome of a lease-guarded assistant-message insert. `null` means the lease was
 * lost (no write). `"conflict"` means the row already existed (idempotent re-entry,
 * not a lease problem) — the caller decides whether that counts as success.
 */
export type AssistantInsertOutcome = "inserted" | "conflict";

type ExistingMessage = { id: string; status: string };

type CompleteAssistantMessageInput = {
  sessionId: string;
  assistantMessageId: string;
  content: string;
  modelMessage: Record<string, unknown>;
};

type ToolMessageInsert = {
  id: string;
  sessionId: string;
  internal: boolean;
  content: string;
  modelMessage: Record<string, unknown>;
  toolName: string;
  toolCallId: string;
};

export type ModelUsageInsert = {
  sessionId: string;
  messageId: string;
  runLeaseId: string;
  stepIndex: number;
  modelProvider: string;
  modelName: string;
  responseId: string | null;
  responseModelId: string | null;
  finishReason: string;
  rawFinishReason: string | null;
  inputTokens: number;
  inputNoCacheTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputReasoningTokens: number;
  totalTokens: number;
  rawUsage: Record<string, unknown>;
  providerCreatedAt: Date | null;
};

type ToolApprovalInsert = {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  providerKey: string;
  permissionGroup: "read" | "post" | "modify" | "admin";
  inputPreview: string | null;
};

type SessionQuestionInsert = {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  questions: AgentSessionQuestionPrompt[];
};

export type ToolUsageInsert = {
  sessionId: string;
  messageId: string;
  runLeaseId: string;
  toolCallId: string;
  toolName: string;
  provider: string;
  operation: string;
  providerRequestId: string | null;
  costUsdMicros: number;
  rawUsage: Record<string, unknown>;
};

export type SandboxUsageInsert = {
  sessionId: string;
  messageId: string;
  runLeaseId: string;
  sandboxId: string;
  template: string | null;
  vcpu: number | null;
  ramMib: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  activeMs: number;
  costUsdMicros: number;
  rawMetrics: Record<string, unknown>;
};

/**
 * The atomic, lease-guarded durable writes. Each method writes only while the lease
 * is still current and reports "no write" so the caller can map it to lease loss.
 */
export type LeaseWriteStore = {
  insertAssistantMessage(
    input: AssistantMessageInsert,
    lease: LeaseIdentity,
  ): Promise<AssistantInsertOutcome | null>;
  findResponseMessage(
    sessionId: string,
    responseToMessageId: string,
  ): Promise<ExistingMessage | null>;
  completeAssistantMessage(
    input: CompleteAssistantMessageInput,
    lease: LeaseIdentity,
  ): Promise<boolean>;
  insertToolMessage(input: ToolMessageInsert, lease: LeaseIdentity): Promise<boolean>;
  insertToolApproval(
    input: ToolApprovalInsert,
    lease: LeaseIdentity,
  ): Promise<AssistantInsertOutcome | null>;
  insertSessionQuestion(
    input: SessionQuestionInsert,
    lease: LeaseIdentity,
  ): Promise<AssistantInsertOutcome | null>;
  insertModelUsage(input: ModelUsageInsert, lease: LeaseIdentity): Promise<{ id: number } | null>;
  insertToolUsage(input: ToolUsageInsert, lease: LeaseIdentity): Promise<{ id: number } | null>;
  insertSandboxUsage(
    input: SandboxUsageInsert,
    lease: LeaseIdentity,
  ): Promise<{ id: number } | null>;
};

// `EXISTS (lease current)` predicate shared by every guarded statement. The lease row
// is matched by id + lease id + owner and must not be archived. Because it lives in
// the same statement as the write, the check and the write commit atomically.
function leaseIsCurrent(lease: LeaseIdentity): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM agent_sessions s
    WHERE s.id = ${lease.sessionId}
      AND s.run_lease_id = ${lease.leaseId}
      AND s.run_lease_owner = ${lease.leaseOwner}
      AND s.archived_at IS NULL
  )`;
}

export function createDbLeaseWriteStore(): LeaseWriteStore {
  return {
    async insertAssistantMessage(input, lease) {
      // Regular assistant responses are idempotent by response_to_message_id; internal
      // messages have no response target, so they carry no conflict clause. The CTE
      // reports the lease state and the insert result together so the caller can tell
      // "lease lost" (no row at all) apart from "row already existed" (idempotent).
      const conflictClause = input.responseToMessageId
        ? sql`ON CONFLICT (response_to_message_id) DO NOTHING`
        : sql``;
      const result = await getDb().execute(sql`
        WITH lease AS (
          SELECT 1
          FROM agent_sessions s
          WHERE s.id = ${lease.sessionId}
            AND s.run_lease_id = ${lease.leaseId}
            AND s.run_lease_owner = ${lease.leaseOwner}
            AND s.archived_at IS NULL
        ),
        ins AS (
          INSERT INTO agent_session_messages (id, session_id, role, status, internal, response_to_message_id)
          SELECT ${input.id}, ${input.sessionId}, 'assistant', 'running', ${input.internal}, ${input.responseToMessageId}
          WHERE EXISTS (SELECT 1 FROM lease)
          ${conflictClause}
          RETURNING id
        )
        SELECT
          EXISTS (SELECT 1 FROM lease) AS lease_current,
          (SELECT id FROM ins) AS inserted_id
      `);
      const row = rowsFromExecute<{ lease_current: boolean; inserted_id: string | null }>(
        result,
      )[0];
      if (!row || !row.lease_current) return null;
      return row.inserted_id ? "inserted" : "conflict";
    },

    async findResponseMessage(sessionId, responseToMessageId) {
      const result = await getDb().execute(sql`
        SELECT id, status
        FROM agent_session_messages
        WHERE session_id = ${sessionId}
          AND response_to_message_id = ${responseToMessageId}
        LIMIT 1
      `);
      return rowsFromExecute<ExistingMessage>(result)[0] ?? null;
    },

    async completeAssistantMessage(input, lease) {
      const result = await getDb().execute(sql`
        UPDATE agent_session_messages AS m
        SET status = 'completed',
            content = ${input.content},
            model_message = ${JSON.stringify(input.modelMessage)}::jsonb,
            completed_at = ${new Date()}
        WHERE m.id = ${input.assistantMessageId}
          AND m.session_id = ${input.sessionId}
          AND ${leaseIsCurrent(lease)}
        RETURNING m.id
      `);
      return rowsFromExecute(result).length > 0;
    },

    async insertToolMessage(input, lease) {
      const result = await getDb().execute(sql`
        INSERT INTO agent_session_messages (
          id, session_id, role, status, internal, content, model_message, tool_name, tool_call_id, completed_at
        )
        SELECT
          ${input.id}, ${input.sessionId}, 'tool', 'completed', ${input.internal}, ${input.content},
          ${JSON.stringify(input.modelMessage)}::jsonb, ${input.toolName}, ${input.toolCallId}, ${new Date()}
        WHERE ${leaseIsCurrent(lease)}
        RETURNING id
      `);
      return rowsFromExecute(result).length > 0;
    },

    async insertToolApproval(input, lease) {
      // Idempotent on (session_id, tool_call_id): a crash-recovery re-run resumes the
      // existing approval row (and its decided status) rather than resetting it to
      // pending. The CTE reports lease state and insert result together so the caller
      // tells "lease lost" (no row) apart from "row already existed" (conflict).
      const result = await getDb().execute(sql`
        WITH lease AS (
          SELECT 1
          FROM agent_sessions s
          WHERE s.id = ${lease.sessionId}
            AND s.run_lease_id = ${lease.leaseId}
            AND s.run_lease_owner = ${lease.leaseOwner}
            AND s.archived_at IS NULL
        ),
        ins AS (
          INSERT INTO agent_tool_approvals (
            session_id, message_id, tool_call_id, tool_name, provider_key, permission_group, status, input_preview
          )
          SELECT
            ${input.sessionId}, ${input.messageId}, ${input.toolCallId}, ${input.toolName},
            ${input.providerKey}, ${input.permissionGroup}, 'pending', ${input.inputPreview}
          WHERE EXISTS (SELECT 1 FROM lease)
          ON CONFLICT (session_id, tool_call_id) DO NOTHING
          RETURNING id
        )
        SELECT
          EXISTS (SELECT 1 FROM lease) AS lease_current,
          (SELECT id FROM ins) AS inserted_id
      `);
      const row = rowsFromExecute<{ lease_current: boolean; inserted_id: number | null }>(
        result,
      )[0];
      if (!row || !row.lease_current) return null;
      return row.inserted_id ? "inserted" : "conflict";
    },

    async insertSessionQuestion(input, lease) {
      // Idempotent on (session_id, tool_call_id), exactly like insertToolApproval: a
      // crash-recovery re-run resumes the existing question row (and its decided status)
      // rather than resetting it to pending.
      const result = await getDb().execute(sql`
        WITH lease AS (
          SELECT 1
          FROM agent_sessions s
          WHERE s.id = ${lease.sessionId}
            AND s.run_lease_id = ${lease.leaseId}
            AND s.run_lease_owner = ${lease.leaseOwner}
            AND s.archived_at IS NULL
        ),
        ins AS (
          INSERT INTO agent_session_questions (
            session_id, message_id, tool_call_id, questions, status
          )
          SELECT
            ${input.sessionId}, ${input.messageId}, ${input.toolCallId},
            ${JSON.stringify(input.questions)}::jsonb, 'pending'
          WHERE EXISTS (SELECT 1 FROM lease)
          ON CONFLICT (session_id, tool_call_id) DO NOTHING
          RETURNING id
        )
        SELECT
          EXISTS (SELECT 1 FROM lease) AS lease_current,
          (SELECT id FROM ins) AS inserted_id
      `);
      const row = rowsFromExecute<{ lease_current: boolean; inserted_id: number | null }>(
        result,
      )[0];
      if (!row || !row.lease_current) return null;
      return row.inserted_id ? "inserted" : "conflict";
    },

    async insertModelUsage(input, lease) {
      const result = await getDb().execute(sql`
        INSERT INTO agent_session_usage (
          session_id, message_id, run_lease_id, step_index, model_provider, model_name,
          response_id, response_model_id, finish_reason, raw_finish_reason,
          input_tokens, input_no_cache_tokens, input_cache_read_tokens, input_cache_write_tokens,
          output_tokens, output_text_tokens, output_reasoning_tokens, total_tokens,
          raw_usage, provider_created_at
        )
        SELECT
          ${input.sessionId}, ${input.messageId}, ${input.runLeaseId}, ${input.stepIndex},
          ${input.modelProvider}, ${input.modelName}, ${input.responseId}, ${input.responseModelId},
          ${input.finishReason}, ${input.rawFinishReason},
          ${input.inputTokens}, ${input.inputNoCacheTokens}, ${input.inputCacheReadTokens}, ${input.inputCacheWriteTokens},
          ${input.outputTokens}, ${input.outputTextTokens}, ${input.outputReasoningTokens}, ${input.totalTokens},
          ${JSON.stringify(input.rawUsage)}::jsonb, ${input.providerCreatedAt}
        WHERE ${leaseIsCurrent(lease)}
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result)[0] ?? null;
    },

    async insertToolUsage(input, lease) {
      const result = await getDb().execute(sql`
        INSERT INTO agent_session_tool_usage (
          session_id, message_id, run_lease_id, tool_call_id, tool_name,
          provider, operation, provider_request_id, cost_usd_micros, raw_usage
        )
        SELECT
          ${input.sessionId}, ${input.messageId}, ${input.runLeaseId}, ${input.toolCallId}, ${input.toolName},
          ${input.provider}, ${input.operation}, ${input.providerRequestId}, ${input.costUsdMicros},
          ${JSON.stringify(input.rawUsage)}::jsonb
        WHERE ${leaseIsCurrent(lease)}
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result)[0] ?? null;
    },

    async insertSandboxUsage(input, lease) {
      const result = await getDb().execute(sql`
        INSERT INTO agent_session_sandbox_usage (
          session_id, message_id, run_lease_id, sandbox_id, template,
          vcpu, ram_mib, started_at, ended_at, active_ms, cost_usd_micros, raw_metrics
        )
        SELECT
          ${input.sessionId}, ${input.messageId}, ${input.runLeaseId}, ${input.sandboxId}, ${input.template},
          ${input.vcpu}, ${input.ramMib}, ${input.startedAt}, ${input.endedAt}, ${input.activeMs},
          ${input.costUsdMicros}, ${JSON.stringify(input.rawMetrics)}::jsonb
        WHERE ${leaseIsCurrent(lease)}
        RETURNING id
      `);
      return rowsFromExecute<{ id: number }>(result)[0] ?? null;
    },
  };
}

// Tests that drive whole runs (agent-loop) cannot thread a store through every helper,
// so they install an in-memory store here. Production never sets this and always gets
// the real DB-backed store.
let leaseWriteStoreOverride: LeaseWriteStore | undefined;

export function setLeaseWriteStoreForTests(store: LeaseWriteStore | undefined) {
  leaseWriteStoreOverride = store;
}

export function defaultLeaseWriteStore(): LeaseWriteStore {
  return leaseWriteStoreOverride ?? createDbLeaseWriteStore();
}

export async function acquireRunLease(input: {
  sessionId: string;
  messageId: string;
  leaseId: string;
  leaseOwner: string;
  modelProvider: string;
  modelName: string;
}) {
  return claimDbRunLease(input);
}

/**
 * Advisory lease probe. Use only to gate *external* side effects (a sandbox command,
 * a git push, a GitHub API call) that cannot be folded into a single DB statement, so
 * the best we can do is check first and accept the residual race. Durable DB writes
 * must use the atomic {@link LeaseWriteStore} helpers below instead, where the lease
 * guard is enforced in the same statement as the write.
 */
export async function isRunLeaseCurrent(sessionId: string, leaseId: string, leaseOwner: string) {
  const [session] = await getDb()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.runLeaseId, leaseId),
        eq(agentSessions.runLeaseOwner, leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  return Boolean(session);
}

export async function updateSandboxForLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  sandboxId: string,
) {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ e2bSandboxId: sandboxId, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.runLeaseId, leaseId),
        eq(agentSessions.runLeaseOwner, leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .returning({ id: agentSessions.id });

  return Boolean(updated);
}

export async function createAssistantMessageForLease(
  input: {
    id: string;
    sessionId: string;
    responseToMessageId?: string;
    leaseId: string;
    leaseOwner: string;
    internal?: boolean;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const lease = {
    sessionId: input.sessionId,
    leaseId: input.leaseId,
    leaseOwner: input.leaseOwner,
  };
  const outcome = await store.insertAssistantMessage(
    {
      id: input.id,
      sessionId: input.sessionId,
      internal: input.internal ?? false,
      responseToMessageId: input.responseToMessageId ?? null,
    },
    lease,
  );

  // Lease lost between the caller's intent and this write — the guard rejected it.
  // Throw (rather than return false) so callers don't mistake it for the idempotent
  // "assistant already exists" skip below.
  if (outcome === null) {
    throw new StaleRunLeaseError();
  }

  if (outcome === "conflict") {
    if (!input.responseToMessageId) return false;

    // Idempotent re-entry: a row already responds to this user message. Treat a
    // retry of the SAME in-flight assistant message as success; a different or
    // already-completed response is a genuine duplicate to skip.
    const existing = await store.findResponseMessage(input.sessionId, input.responseToMessageId);
    return Boolean(existing && existing.id === input.id && existing.status !== "completed");
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.id,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      type: "message.created",
      payload: { messageId: input.id, role: "assistant", internal: input.internal ?? false },
    }),
  );
  return true;
}

export async function completeAssistantMessageForLease(
  input: {
    sessionId: string;
    assistantMessageId: string;
    leaseId: string;
    leaseOwner: string;
    content: string;
    modelMessage: Record<string, unknown>;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const updated = await store.completeAssistantMessage(
    {
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      content: input.content,
      modelMessage: input.modelMessage,
    },
    { sessionId: input.sessionId, leaseId: input.leaseId, leaseOwner: input.leaseOwner },
  );
  // No row updated means the lease was lost (or the message vanished); either way the
  // guard rejected the write. Throw so the caller does not treat it as completed.
  if (!updated) {
    throw new StaleRunLeaseError();
  }
  return true;
}

export async function insertToolMessageForLease(
  input: {
    id: string;
    sessionId: string;
    leaseId: string;
    leaseOwner: string;
    content: string;
    modelMessage: Record<string, unknown>;
    toolName: string;
    toolCallId: string;
    internal?: boolean;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  return store.insertToolMessage(
    {
      id: input.id,
      sessionId: input.sessionId,
      internal: input.internal ?? false,
      content: input.content,
      modelMessage: input.modelMessage,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
    },
    { sessionId: input.sessionId, leaseId: input.leaseId, leaseOwner: input.leaseOwner },
  );
}

export async function insertToolApprovalForLease(
  input: {
    sessionId: string;
    messageId: string;
    toolCallId: string;
    toolName: string;
    providerKey: string;
    permissionGroup: "read" | "post" | "modify" | "admin";
    inputPreview?: string | null;
    leaseId: string;
    leaseOwner: string;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const outcome = await store.insertToolApproval(
    {
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      providerKey: input.providerKey,
      permissionGroup: input.permissionGroup,
      inputPreview: input.inputPreview ?? null,
    },
    { sessionId: input.sessionId, leaseId: input.leaseId, leaseOwner: input.leaseOwner },
  );
  // Lease lost — the guard rejected the write. Throw so the run aborts cleanly rather
  // than waiting on an approval row that was never created. A conflict (idempotent
  // re-entry) is success: the row already exists with whatever status it holds.
  if (outcome === null) {
    throw new StaleRunLeaseError();
  }
  return outcome;
}

export async function insertSessionQuestionForLease(
  input: {
    sessionId: string;
    messageId: string;
    toolCallId: string;
    questions: AgentSessionQuestionPrompt[];
    leaseId: string;
    leaseOwner: string;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const outcome = await store.insertSessionQuestion(
    {
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      questions: input.questions,
    },
    { sessionId: input.sessionId, leaseId: input.leaseId, leaseOwner: input.leaseOwner },
  );
  // Lease lost — the guard rejected the write. Throw so the run aborts cleanly rather than
  // suspending on a question row that was never created. A conflict (idempotent re-entry) is
  // success: the row already exists with whatever status it holds.
  if (outcome === null) {
    throw new StaleRunLeaseError();
  }
  return outcome;
}

export async function appendRuntimeEventForLease(
  input: {
    sessionId: string;
    messageId?: string | null;
    leaseId: string;
    leaseOwner: string;
  } & AgentRuntimeEvent,
) {
  // `appendRuntimeEvent` performs the lease-guarded insert in a single statement and
  // returns null when the lease is no longer current (no row written, nothing
  // published). Map that to a rejected lease write.
  const event = await appendRuntimeEvent(getDb(), input);
  return event !== null;
}

export async function releaseRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "completed" | "ready",
) {
  return finishDbRunLease({ sessionId, leaseId, leaseOwner, status, lastError: null });
}

export async function failRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "aborting" | "failed",
  message: string,
) {
  return finishDbRunLease({ sessionId, leaseId, leaseOwner, status, lastError: message });
}

// Park the run for a human decision: set the paused status (`awaiting_approval` for a tool
// approval, `awaiting_input` for an ask_user_question) and release the lease (clears lease fields)
// so no runner sits idle holding a stream. The session resumes in a fresh resume run once the
// approval/question row is decided.
export async function suspendRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "awaiting_approval" | "awaiting_input" = "awaiting_approval",
) {
  return finishDbRunLease({
    sessionId,
    leaseId,
    leaseOwner,
    status,
    lastError: null,
  });
}

export async function requireLeaseWrite(write: Promise<boolean> | boolean) {
  if (!(await write)) {
    throw new StaleRunLeaseError();
  }
}

export class StaleRunLeaseError extends Error {
  constructor() {
    super("Run lease is no longer current.");
  }
}

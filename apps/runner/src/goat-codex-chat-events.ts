import { randomUUID } from "node:crypto";
import {
  applyCodexEventToUiMessageParts,
  type CodexAppServerNormalizedEvent,
  type CodexUiMessagePart,
  createCodexCommandOutputAccumulator,
  finalizeCodexUiMessageParts,
  normalizeCodexAppServerEvent,
  offerCodexPlanImplementation,
  parseCodexUiMessageParts,
  resolveCodexUiInteraction,
} from "@opencompany/agent-runtime";
import {
  GOAT_CODEX_CHAT_EVENT_TYPES,
  type GoatChatMessageDebugTrace,
  type GoatCodexChatEventType,
  type GoatCodexChatSessionStatus,
  goatChatMessages,
} from "@opencompany/db/goat-schema";
import { captureException } from "@opencompany/observability";
import { and, eq, sql } from "drizzle-orm";
import type { CodexAppServerRequest, CodexAppServerSummary } from "./codex-app-server";
import { getDb } from "./db";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { rowsFromExecute } from "./sql-exec";

const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1" as const;

// Event types that are persisted to goat.codex_chat_events. Deltas are volume, not chunks:
// they never land in the audit log or the message row.
const PERSISTED_EVENT_TYPES = new Set<GoatCodexChatEventType>(
  GOAT_CODEX_CHAT_EVENT_TYPES.filter((eventType) => eventType !== "unknown"),
);

export type GoatCodexChatProjectorTarget = {
  userWorkosId: string;
  codexChatSessionId: string;
  chatSessionId: string;
  turnId: string;
  assistantMessageId: string;
  model: string;
  leaseId: string;
  leaseOwner: string;
  planMode: boolean;
  turnCreatedAt?: Date;
};

// Folds normalized Codex app-server events into the turn's assistant chat_messages row (the
// Electric-synced streaming surface), the codex_chat_events audit log, and turn/session status.
// One message UPDATE per logical chunk; Electric ships the full row so the client is always
// consistent, including across reloads.
export function createGoatCodexChatProjector(input: {
  target: GoatCodexChatProjectorTarget;
  redact: (value: string) => string;
  initialParts?: CodexUiMessagePart[];
}) {
  const { target, redact } = input;
  let parts: CodexUiMessagePart[] = input.initialParts ?? [];
  let turnError: string | null = null;
  let auditFailureReported = false;
  const outputAccumulator = createCodexCommandOutputAccumulator();

  const writeAssistantMessage = async (
    options: {
      error?: string | null;
      aborted?: boolean;
      usage?: GoatChatMessageDebugTrace["usage"];
      durationMs?: number | undefined;
    } = {},
  ) => {
    const redactedParts = redactJson(parts, redact) as unknown[];
    const content = redact(
      parts
        .filter(
          (part): part is Extract<CodexUiMessagePart, { type: "text" }> => part.type === "text",
        )
        .map((part) => part.text)
        .filter((text) => text.trim())
        .join("\n\n"),
    );
    const debugTrace: GoatChatMessageDebugTrace = {
      schemaVersion: CODEX_CHAT_DEBUG_SCHEMA_VERSION,
      model: target.model,
      uiMessageParts: redactedParts,
      ...(options.error ? { error: redact(options.error) } : {}),
      ...(options.aborted ? { aborted: true } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(typeof options.durationMs === "number" ? { durationMs: options.durationMs } : {}),
    };
    assertRowsChanged(
      await getDb().execute(sql`
        UPDATE goat.chat_messages AS message
        SET content = ${content},
            debug_trace = ${JSON.stringify(debugTrace)}::jsonb,
            updated_at = ${new Date()}
        WHERE message.id = ${target.assistantMessageId}
          AND message.role = 'assistant'
          AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        RETURNING message.id
      `),
    );
  };

  const insertEventRow = async (event: CodexAppServerNormalizedEvent) => {
    if (!PERSISTED_EVENT_TYPES.has(event.type as GoatCodexChatEventType)) return true;
    const eventKey = codexChatEventKey(event);
    try {
      const result = await getDb().execute(sql`
          INSERT INTO goat.codex_chat_events (
            user_workos_id,
            codex_chat_session_id,
            codex_chat_turn_id,
            event_key,
            type,
            payload,
            raw_event,
            created_at
          )
          SELECT ${target.userWorkosId},
                 ${target.codexChatSessionId},
                 ${target.turnId},
                 ${eventKey},
                 ${event.type},
                 ${JSON.stringify(redactJson(event.payload, redact))}::jsonb,
                 ${JSON.stringify(redactJson(event.rawEvent, redact))}::jsonb,
                 ${new Date()}
          WHERE EXISTS (${turnLeaseSubquery({ runningOnly: true })})
          ON CONFLICT (codex_chat_turn_id, event_key)
            WHERE event_key IS NOT NULL
            DO NOTHING
          RETURNING id
        `);
      if (rowsFromExecute(result).length > 0) return true;
      if (eventKey) {
        const duplicate = await getDb().execute(sql`
          SELECT id
          FROM goat.codex_chat_events
          WHERE codex_chat_turn_id = ${target.turnId}
            AND event_key = ${eventKey}
            AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
          LIMIT 1
        `);
        if (rowsFromExecute(duplicate).length > 0) return false;
      }
      throw new GoatCodexChatLeaseLostError();
    } catch (error) {
      if (error instanceof GoatCodexChatLeaseLostError) throw error;
      if (auditFailureReported) return true;
      auditFailureReported = true;
      const persistenceError = new Error("Goat Codex chat audit event persistence failed.");
      persistenceError.name = "GoatCodexChatEventPersistenceError";
      captureException(persistenceError, {
        event: "opencompany.goat_codex_chat_event_persist_failed",
        turn_id: target.turnId,
        event_type: event.type,
        original_error_name: error instanceof Error ? error.name : typeof error,
        original_error_code: databaseErrorCode(error),
      });
      return true;
    }
  };

  const markTurnRunning = async (codexTurnId: string | null) => {
    const now = new Date();
    assertRowsChanged(
      await getDb().execute(sql`
        UPDATE goat.codex_chat_turns AS turn
        SET codex_turn_id = COALESCE(${codexTurnId}, turn.codex_turn_id),
            status = 'running',
            updated_at = ${now}
        WHERE turn.id = ${target.turnId}
          AND turn.user_workos_id = ${target.userWorkosId}
          AND turn.lease_id = ${target.leaseId}
          AND turn.lease_owner = ${target.leaseOwner}
          AND turn.status = 'running'
        RETURNING turn.id
      `),
    );
    assertRowsChanged(
      await getDb().execute(sql`
        UPDATE goat.codex_chat_sessions AS session
        SET status = 'running',
            active_turn_id = ${target.turnId},
            error = NULL,
            updated_at = ${now}
        WHERE session.id = ${target.codexChatSessionId}
          AND session.user_workos_id = ${target.userWorkosId}
          AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        RETURNING session.id
      `),
    );
  };

  const handleEvent = async (event: CodexAppServerNormalizedEvent) => {
    if (event.type === "command.output") {
      outputAccumulator.push(event);
      return;
    }
    if (event.type === "assistant.delta" || event.type === "unknown") return;

    const isNewEvent = await insertEventRow(event);

    if (event.type === "turn.started") {
      const codexTurnId = typeof event.payload.turnId === "string" ? event.payload.turnId : null;
      await markTurnRunning(codexTurnId);
      return;
    }
    if (event.type === "turn.completed" || event.type === "usage.updated") {
      // Terminal transitions and usage land in finalize() with the full summary.
      return;
    }
    if (!isNewEvent) return;

    const commandOutputPreview =
      event.type === "command.completed" || event.type === "command.failed"
        ? outputAccumulator.take(
            typeof event.payload.itemId === "string" ? event.payload.itemId : null,
          )
        : null;
    const projection = applyCodexEventToUiMessageParts(parts, event, { commandOutputPreview });
    if (!projection.changed) return;
    parts = projection.parts;
    if (projection.error) turnError = projection.error;
    await writeAssistantMessage({ error: turnError });
  };

  const cancelPendingInteractions = async () => {
    const now = new Date();
    const result = await getDb().execute(sql`
      WITH canceled AS (
        UPDATE goat.codex_chat_interactions AS interaction
        SET status = 'canceled',
            resolved_at = ${now},
            updated_at = ${now}
        WHERE interaction.codex_chat_turn_id = ${target.turnId}
          AND interaction.user_workos_id = ${target.userWorkosId}
          AND interaction.status = 'pending'
          AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        RETURNING interaction.id
      ), resolved AS (
        SELECT interaction.id, interaction.response
        FROM goat.codex_chat_interactions AS interaction
        WHERE interaction.codex_chat_turn_id = ${target.turnId}
          AND interaction.user_workos_id = ${target.userWorkosId}
          AND interaction.status = 'resolved'
          AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        FOR UPDATE
      ), cleared_resolved AS (
        UPDATE goat.codex_chat_interactions AS interaction
        SET response = NULL,
            updated_at = ${now}
        FROM resolved
        WHERE interaction.id = resolved.id
        RETURNING resolved.id, resolved.response
      )
      SELECT canceled.id, 'canceled'::text AS status
      FROM canceled
      UNION ALL
      SELECT interaction.id,
             CASE
               WHEN interaction.response -> 'answers' = '{}'::jsonb THEN 'auto-resolved'
               ELSE 'resolved'
             END AS status
      FROM cleared_resolved AS interaction
    `);
    let didChange = false;
    for (const row of rowsFromExecute<{
      id: string;
      status: "auto-resolved" | "canceled" | "resolved";
    }>(result)) {
      const projection = resolveCodexUiInteraction(parts, {
        interactionId: row.id,
        status:
          row.status === "resolved"
            ? "answered"
            : row.status === "auto-resolved"
              ? "auto-resolved"
              : "canceled",
      });
      if (!projection.changed) continue;
      parts = projection.parts;
      didChange = true;
    }
    return didChange;
  };

  const settleTurn = async (options: {
    turnStatus: "completed" | "failed" | "interrupted";
    sessionStatus: GoatCodexChatSessionStatus;
    error: string | null;
    completedAt?: Date;
  }) => {
    const now = options.completedAt ?? new Date();
    assertRowsChanged(
      await getDb().execute(sql`
        WITH settled_turn AS (
          UPDATE goat.codex_chat_turns AS turn
          SET status = ${options.turnStatus},
              error = ${options.error},
              completed_at = ${now},
              updated_at = ${now}
          WHERE turn.id = ${target.turnId}
            AND turn.user_workos_id = ${target.userWorkosId}
            AND turn.lease_id = ${target.leaseId}
            AND turn.lease_owner = ${target.leaseOwner}
            AND turn.status = 'running'
          RETURNING turn.id
        ),
        next_queued_turn AS (
          SELECT queued.id
          FROM goat.codex_chat_turns AS queued
          WHERE queued.codex_chat_session_id = ${target.codexChatSessionId}
            AND queued.user_workos_id = ${target.userWorkosId}
            AND queued.status = 'queued'
            AND EXISTS (SELECT 1 FROM settled_turn)
          ORDER BY queued.created_at ASC, queued.id ASC
          LIMIT 1
        )
        UPDATE goat.codex_chat_sessions AS session
        SET active_turn_id = (SELECT id FROM next_queued_turn),
            status = CASE
              WHEN EXISTS (SELECT 1 FROM next_queued_turn) THEN 'queued'
              ELSE ${options.sessionStatus}
            END,
            error = ${options.error},
            updated_at = ${now}
        WHERE session.id = ${target.codexChatSessionId}
          AND session.user_workos_id = ${target.userWorkosId}
          AND (session.active_turn_id IS NULL OR session.active_turn_id = ${target.turnId})
          AND EXISTS (SELECT 1 FROM settled_turn)
        RETURNING session.id
      `),
    );
    assertRowsChanged(
      await getDb().execute(sql`
        UPDATE goat.chat_sessions AS session
        SET updated_at = ${now}
        WHERE session.id = ${target.chatSessionId}
          AND session.user_workos_id = ${target.userWorkosId}
          AND EXISTS (${turnLeaseSubquery({ runningOnly: false })})
        RETURNING session.id
      `),
    );
  };

  const turnLeaseSubquery = (options: { runningOnly: boolean }) => sql`
    SELECT 1
    FROM goat.codex_chat_turns AS lease_turn
    WHERE lease_turn.id = ${target.turnId}
      AND lease_turn.user_workos_id = ${target.userWorkosId}
      AND lease_turn.codex_chat_session_id = ${target.codexChatSessionId}
      AND lease_turn.lease_id = ${target.leaseId}
      AND lease_turn.lease_owner = ${target.leaseOwner}
      ${options.runningOnly ? sql`AND lease_turn.status = 'running'` : sql``}
  `;

  // Notifications are already batched serially, but app-server requests are handled on a
  // separate async path. Serialize every projection mutation so concurrent question/event writes
  // cannot land out of order and overwrite newer message parts.
  let projectionChain: Promise<void> = Promise.resolve();
  const serializeProjection = <T>(operation: () => Promise<T>) => {
    const result = projectionChain.then(operation, operation);
    projectionChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    push(rawEvents: Record<string, unknown>[]) {
      return serializeProjection(async () => {
        for (const raw of rawEvents) {
          for (const event of normalizeCodexAppServerEvent(raw)) {
            await handleEvent(event);
          }
        }
      });
    },

    requestUserInput(request: CodexAppServerRequest) {
      return serializeProjection(async () => {
        if (request.method !== "item/tool/requestUserInput") {
          throw new Error(`Unsupported Codex app-server request: ${request.method}`);
        }
        if (!isValidCodexUserInputRequest(request.params)) {
          throw new Error("Codex sent an invalid user-input request.");
        }
        const interactionId = `goat_codex_chat_interaction_${randomUUID()}`;
        const rawEvent: Record<string, unknown> = { ...request, interactionId };
        const [event] = normalizeCodexAppServerEvent(rawEvent);
        if (!event || event.type !== "question.requested") {
          throw new Error("Codex sent an invalid user-input request.");
        }
        const now = new Date();
        assertRowsChanged(
          await getDb().execute(sql`
          INSERT INTO goat.codex_chat_interactions (
            id,
            user_workos_id,
            codex_chat_session_id,
            codex_chat_turn_id,
            lease_id,
            request_id,
            item_id,
            method,
            status,
            request,
            created_at,
            updated_at
          )
          SELECT ${interactionId},
                 ${target.userWorkosId},
                 ${target.codexChatSessionId},
                 ${target.turnId},
                 ${target.leaseId},
                 ${String(request.id)},
                 ${typeof request.params.itemId === "string" ? request.params.itemId : null},
                 ${request.method},
                 'pending',
                 ${JSON.stringify(redactJson(request.params, redact))}::jsonb,
                 ${now},
                 ${now}
          WHERE EXISTS (${turnLeaseSubquery({ runningOnly: true })})
          RETURNING id
        `),
        );
        await insertEventRow(event);
        const projection = applyCodexEventToUiMessageParts(parts, event);
        if (projection.changed) {
          parts = projection.parts;
          await writeAssistantMessage({ error: turnError });
        }
        return { interactionId };
      });
    },

    resolveInteraction(interactionId: string, status: "answered" | "auto-resolved" | "canceled") {
      return serializeProjection(async () => {
        const projection = resolveCodexUiInteraction(parts, { interactionId, status });
        if (!projection.changed) return;
        parts = projection.parts;
        await writeAssistantMessage({ error: turnError });
      });
    },

    cancelPendingInteractions() {
      return serializeProjection(async () => {
        const didCancel = await cancelPendingInteractions();
        if (didCancel) await writeAssistantMessage({ error: turnError });
        return didCancel;
      });
    },

    finalize(summary: CodexAppServerSummary) {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        const usage = summary.usage
          ? {
              inputTokens: summary.usage.input_tokens,
              outputTokens: summary.usage.output_tokens,
              totalTokens: summary.usage.input_tokens + summary.usage.output_tokens,
            }
          : undefined;
        if (summary.status === "success") {
          // Safety net: if no assistant.completed event produced a text part, fall back to the
          // accumulator's result so the turn never ends visually empty.
          if (!parts.some((part) => part.type === "text" && part.text.trim()) && summary.result) {
            parts = [...parts, { type: "text", text: summary.result }];
          }
          // Settle any still-waiting question/approval/status parts; the turn is over.
          parts = finalizeCodexUiMessageParts(parts, "completed").parts;
          if (target.planMode) {
            parts = offerCodexPlanImplementation(parts).parts;
          }
          await writeAssistantMessage({
            error: null,
            usage,
            durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
          });
          await settleTurn({
            turnStatus: "completed",
            sessionStatus: "idle",
            error: null,
            completedAt,
          });
          return;
        }
        const error =
          summary.error ?? turnError ?? `Codex finished with status: ${summary.status}.`;
        parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
        await writeAssistantMessage({
          error,
          usage,
          durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
        });
        await settleTurn({ turnStatus: "failed", sessionStatus: "idle", error, completedAt });
      });
    },

    interrupted() {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        parts = finalizeCodexUiMessageParts(parts, "interrupted").parts;
        await writeAssistantMessage({
          aborted: true,
          durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
        });
        await settleTurn({
          turnStatus: "interrupted",
          sessionStatus: "interrupted",
          error: null,
          completedAt,
        });
      });
    },

    fail(error: string, options: { sessionStatus?: GoatCodexChatSessionStatus } = {}) {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
        await writeAssistantMessage({
          error,
          durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
        });
        await settleTurn({
          turnStatus: "failed",
          sessionStatus: options.sessionStatus ?? "idle",
          error,
          completedAt,
        });
      });
    },
  };
}

function assertRowsChanged(result: unknown) {
  if (rowsFromExecute(result).length === 0) {
    throw new GoatCodexChatLeaseLostError();
  }
}

function elapsedTurnDurationMs(startedAt: Date | undefined, completedAt: Date) {
  if (!startedAt || Number.isNaN(startedAt.getTime())) return undefined;
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function codexChatEventKey(event: CodexAppServerNormalizedEvent) {
  const itemId = typeof event.payload.itemId === "string" ? event.payload.itemId : null;
  if (itemId && ITEM_LIFECYCLE_EVENT_TYPES.has(event.type)) return `${event.type}:${itemId}`;
  const turnId = typeof event.payload.turnId === "string" ? event.payload.turnId : null;
  if (turnId && (event.type === "turn.started" || event.type === "turn.completed")) {
    return `${event.type}:${turnId}`;
  }
  return null;
}

const ITEM_LIFECYCLE_EVENT_TYPES = new Set<CodexAppServerNormalizedEvent["type"]>([
  "assistant.completed",
  "reasoning.completed",
  "command.started",
  "command.completed",
  "command.failed",
  "file_change.started",
  "file_change.completed",
  "mcp_tool.started",
  "mcp_tool.completed",
  "web_search.started",
  "web_search.completed",
]);

function databaseErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function isValidCodexUserInputRequest(params: Record<string, unknown>) {
  if (
    typeof params.threadId !== "string" ||
    !params.threadId ||
    typeof params.turnId !== "string" ||
    !params.turnId ||
    typeof params.itemId !== "string" ||
    !params.itemId ||
    !Array.isArray(params.questions) ||
    params.questions.length === 0 ||
    params.questions.length > 3
  ) {
    return false;
  }
  if (
    params.autoResolutionMs != null &&
    (typeof params.autoResolutionMs !== "number" ||
      !Number.isSafeInteger(params.autoResolutionMs) ||
      params.autoResolutionMs < 0)
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const value of params.questions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const question = value as Record<string, unknown>;
    if (
      typeof question.id !== "string" ||
      !question.id ||
      ids.has(question.id) ||
      typeof question.header !== "string" ||
      typeof question.question !== "string" ||
      !question.question.trim()
    ) {
      return false;
    }
    ids.add(question.id);
    if (question.options != null && !Array.isArray(question.options)) return false;
    for (const option of Array.isArray(question.options) ? question.options : []) {
      if (!option || typeof option !== "object" || Array.isArray(option)) return false;
      const record = option as Record<string, unknown>;
      if (typeof record.label !== "string" || typeof record.description !== "string") return false;
    }
  }
  return true;
}

export async function loadCodexChatAssistantMessageParts(assistantMessageId: string) {
  const [message] = await getDb()
    .select({ debugTrace: goatChatMessages.debugTrace })
    .from(goatChatMessages)
    .where(and(eq(goatChatMessages.id, assistantMessageId), eq(goatChatMessages.role, "assistant")))
    .limit(1);
  return parseCodexUiMessageParts(message?.debugTrace?.uiMessageParts);
}

// Secrets can surface anywhere in event payloads (command echoes, error messages), so redaction
// runs over the serialized JSON rather than individual fields.
function redactJson(value: unknown, redact: (value: string) => string): unknown {
  return JSON.parse(redact(JSON.stringify(value ?? null)));
}

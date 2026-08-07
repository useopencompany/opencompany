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
  parseGoatPublishedChatArtifact,
  resolveCodexUiInteraction,
} from "@opencompany/agent-runtime";
import type { GoatAnalyticsEngine } from "@opencompany/analytics/goat/events";
import {
  captureGoatLlmUsageRecorded,
  type GoatLlmUsageAnalyticsStage,
} from "@opencompany/analytics/goat/server";
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
import { type GoatTaskTurnCompletion, settleGoatDurableTurn } from "./goat-task-turn";
import { rowsFromExecute } from "./sql-exec";

const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1" as const;

// Event types that are persisted to goat.codex_chat_events. Deltas are volume, not chunks:
// they never land in the audit log or the message row.
const PERSISTED_EVENT_TYPES = new Set<GoatCodexChatEventType>(
  GOAT_CODEX_CHAT_EVENT_TYPES.filter((eventType) => eventType !== "unknown"),
);

export type GoatCodexChatProjectorTarget = {
  userWorkosId: string;
  workspaceId?: string | null;
  codexChatSessionId: string;
  chatSessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  model: string;
  engine: GoatAnalyticsEngine;
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
  // Engines that don't speak the codex app-server protocol (Claude Code) inject their
  // own raw-event → normalized-event translation; everything downstream is shared.
  normalizeEvent?: (raw: Record<string, unknown>) => CodexAppServerNormalizedEvent[];
}) {
  const { target, redact } = input;
  const normalizeEvent = input.normalizeEvent ?? normalizeCodexAppServerEvent;
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
    taskCompletion?: GoatTaskTurnCompletion | null | undefined;
  }) => {
    const now = options.completedAt ?? new Date();
    await settleGoatDurableTurn({
      target,
      turnStatus: options.turnStatus,
      sessionStatus: options.sessionStatus,
      error: options.error,
      completedAt: now,
      taskCompletion: options.taskCompletion,
    });
  };

  // Publication commits before the engine emits its tool-completed event. If the runner dies in
  // that narrow window, recover the immutable version into the assistant message at terminal
  // projection so a durable file can never exist without its durable chat reference.
  const reconcilePublishedArtifacts = async () => {
    const result = await getDb().execute(sql`
      SELECT version.id AS "artifactVersionId",
             artifact.id AS "artifactId",
             version.version,
             version.title,
             version.description,
             version.filename,
             version.media_type AS "mediaType",
             version.size_bytes AS "sizeBytes",
             CASE WHEN artifact.archived_at IS NULL THEN 'ready' ELSE 'deleted' END AS state
      FROM goat.chat_artifact_versions AS version
      INNER JOIN goat.chat_artifacts AS artifact ON artifact.id = version.artifact_id
      WHERE version.source_turn_id = ${target.turnId}
        AND version.source_message_id = ${target.assistantMessageId}
        AND artifact.user_workos_id = ${target.userWorkosId}
        AND artifact.chat_session_id = ${target.chatSessionId}
      ORDER BY version.created_at ASC, version.id ASC
    `);
    const projectedVersionIds = collectProjectedArtifactVersionIds(parts);
    for (const row of rowsFromExecute(result)) {
      const artifact = parseGoatPublishedChatArtifact({ ok: true, artifact: row });
      if (!artifact || projectedVersionIds.has(artifact.artifactVersionId)) continue;
      parts = [...parts, { type: "data-artifact-file", data: artifact }];
      projectedVersionIds.add(artifact.artifactVersionId);
    }
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
          for (const event of normalizeEvent(raw)) {
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

    finalize(
      summary: CodexAppServerSummary,
      options: {
        taskCompletion?: GoatTaskTurnCompletion | null;
        replacementContent?: string | null;
      } = {},
    ) {
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
        await captureExternalHarnessUsage({
          target,
          summary,
          taskCompletion: options.taskCompletion,
        });
        await reconcilePublishedArtifacts();
        if (summary.status === "success") {
          if (options.replacementContent?.trim()) {
            parts = [
              ...parts.filter((part) => part.type !== "text"),
              { type: "text", text: options.replacementContent.trim() },
            ];
          }
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
            taskCompletion: options.taskCompletion,
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
        await settleTurn({
          turnStatus: "failed",
          sessionStatus: "idle",
          error,
          completedAt,
          taskCompletion: options.taskCompletion,
        });
      });
    },

    interrupted(taskCompletion?: GoatTaskTurnCompletion | null) {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        await reconcilePublishedArtifacts();
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
          taskCompletion,
        });
      });
    },

    fail(
      error: string,
      options: {
        sessionStatus?: GoatCodexChatSessionStatus;
        taskCompletion?: GoatTaskTurnCompletion | null;
      } = {},
    ) {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        await reconcilePublishedArtifacts();
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
          taskCompletion: options.taskCompletion,
        });
      });
    },
  };
}

async function captureExternalHarnessUsage(input: {
  target: GoatCodexChatProjectorTarget;
  summary: CodexAppServerSummary;
  taskCompletion?: GoatTaskTurnCompletion | null | undefined;
}) {
  const usage = input.summary.usage;
  if (!usage || (input.target.engine !== "codex" && input.target.engine !== "claude_code")) return;

  const inputTokens = positiveTokenCount(usage.input_tokens);
  const outputTokens = positiveTokenCount(usage.output_tokens);
  if (!inputTokens && !outputTokens) return;

  const inputCacheReadTokens = positiveTokenCount(usage.cache_read_input_tokens);
  const inputCacheWriteTokens = positiveTokenCount(usage.cache_creation_input_tokens);
  const inputNoCacheTokens = Math.max(
    inputTokens - inputCacheReadTokens - inputCacheWriteTokens,
    0,
  );
  const totalTokens = inputTokens + outputTokens;

  await captureGoatLlmUsageRecorded({
    distinctId: input.target.userWorkosId,
    workspaceId: input.target.workspaceId,
    surface: input.taskCompletion ? "task" : "chat",
    stage: externalHarnessUsageStage(input.target.engine),
    sessionId: input.target.chatSessionId,
    messageId: input.target.userMessageId,
    taskId: input.taskCompletion?.taskId,
    turnId: input.target.turnId,
    modelProvider: externalHarnessModelProvider(input.target.engine),
    model: input.target.model,
    engine: input.target.engine,
    inputTokens,
    inputNoCacheTokens,
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens,
    outputTextTokens: outputTokens,
    outputReasoningTokens: 0,
    totalTokens,
    providerCostUsdMicros: 0,
    platformFeeUsdMicros: 0,
    chargedCostUsdMicros: 0,
    billable: false,
    finishReason: input.summary.status,
  });
}

function externalHarnessUsageStage(_engine: GoatAnalyticsEngine): GoatLlmUsageAnalyticsStage {
  return "execution";
}

function externalHarnessModelProvider(engine: GoatAnalyticsEngine) {
  if (engine === "claude_code") return "anthropic";
  if (engine === "codex") return "openai";
  return "external";
}

function positiveTokenCount(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

function collectProjectedArtifactVersionIds(parts: readonly CodexUiMessagePart[]) {
  const ids = new Set<string>();
  const visit = (values: readonly CodexUiMessagePart[]) => {
    for (const part of values) {
      if (part.type === "data-artifact-file") ids.add(part.data.artifactVersionId);
      if ("children" in part) visit(part.children);
    }
  };
  visit(parts);
  return ids;
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
  "dynamic_tool.started",
  "dynamic_tool.completed",
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

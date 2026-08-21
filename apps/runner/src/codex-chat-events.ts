import { randomUUID } from "node:crypto";
import {
  applyCodexEventToUiMessageParts,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_NAME,
  CODEX_WEB_SEARCH_TOOL_NAME,
  type CodexUiMessagePart,
  createCodexCommandOutputAccumulator,
  finalizeCodexUiMessageParts,
  type HarnessNormalizedEvent,
  offerCodexPlanImplementation,
  parseCodexUiMessageParts,
  parsePublishedChatArtifact,
  resolveCodexUiApproval,
  resolveCodexUiInteraction,
} from "@opencompany/agent-runtime";
import type { ProductAnalyticsEngine } from "@opencompany/analytics/product/events";
import {
  captureProductLlmUsageRecorded,
  type ProductLlmUsageAnalyticsStage,
} from "@opencompany/analytics/product/server";
import type { RunEventDraft, RunExecutionRepository } from "@opencompany/core";
import { PostgresRunExecutionRepository } from "@opencompany/db/chat-repository";
import {
  type ChatMessageDebugTrace,
  CODEX_CHAT_EVENT_TYPES,
  type CodexChatEventType,
  type CodexChatSessionStatus,
  chatMessages,
} from "@opencompany/db/product-schema";
import { captureException } from "@opencompany/observability";
import { and, eq, sql } from "drizzle-orm";
import { CodexChatLeaseLostError } from "./codex-chat-errors";
import { getDb } from "./db";
import type { ExternalEngineRequest, ExternalEngineTurnSummary } from "./external-engine-contract";
import { rowsFromExecute } from "./sql-exec";
import { settleDurableTurn, type TaskTurnCompletion } from "./task-turn";

const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1" as const;

// Live deltas already stream to the client over SSE run_events; the durable chat_messages row only
// needs periodic checkpoints plus a guaranteed terminal write. Debouncing the row write (instead of
// writing on every token) keeps the Electric read-model shape log from growing with streaming
// activity. Part boundaries and terminal settles bypass the debounce via a forced write.
const ASSISTANT_DURABLE_WRITE_DEBOUNCE_MS = 2000;

// Event types that are persisted to goat.codex_chat_events. High-volume deltas skip the audit log.
const PERSISTED_EVENT_TYPES = new Set<CodexChatEventType>(
  CODEX_CHAT_EVENT_TYPES.filter((eventType) => eventType !== "unknown"),
);

export type ExternalEngineProjectorTarget = {
  userWorkosId: string;
  workspaceId?: string | null;
  codexChatSessionId: string;
  chatSessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  model: string;
  engine: ProductAnalyticsEngine;
  leaseId: string;
  leaseOwner: string;
  canonicalAttemptId?: string;
  planMode: boolean;
  turnCreatedAt?: Date;
};

// Folds normalized coding-harness events into the turn's assistant chat_messages row (the
// Electric-synced streaming surface), the codex_chat_events audit log, and turn/session status.
// The live surface is the SSE run_events stream (emitted per event); the durable chat_messages
// UPDATE is debounced so the Electric read-model shape log stays bounded, with a forced write on
// every part boundary and terminal settle so reloads always see the latest committed state.
export function createExternalEngineProjector(input: {
  target: ExternalEngineProjectorTarget;
  redact: (value: string) => string;
  initialParts?: CodexUiMessagePart[];
  normalizeEvent?: (raw: Record<string, unknown>) => HarnessNormalizedEvent[];
  execution?: RunExecutionRepository;
  now?: () => number;
  assistantWriteDebounceMs?: number;
}) {
  const { target, redact } = input;
  const execution =
    input.execution ?? new PostgresRunExecutionRepository((query) => getDb().execute(query));
  const normalizeEvent = input.normalizeEvent ?? (() => []);
  const now = input.now ?? Date.now;
  const assistantWriteDebounceMs =
    input.assistantWriteDebounceMs ?? ASSISTANT_DURABLE_WRITE_DEBOUNCE_MS;
  let parts: CodexUiMessagePart[] = input.initialParts ?? [];
  let turnError: string | null = null;
  let auditFailureReported = false;
  let lastProjectedContent: string | null = null;
  // Persist the first delta immediately (crash/interrupt safety), then debounce subsequent writes.
  let lastDurableWriteAt = now() - assistantWriteDebounceMs;
  const toolEventStates = new Map<string, "started" | "completed" | "failed">();
  const publishedArtifactIds = new Set<string>();
  const outputAccumulator = createCodexCommandOutputAccumulator();

  const appendProjectionEvents = async (content: string) => {
    if (!target.canonicalAttemptId) return;
    const events: RunEventDraft[] = [];
    if (content !== lastProjectedContent) {
      events.push({
        id: `run_event_${randomUUID()}`,
        type: "message.content_updated",
        payload: { messageId: target.assistantMessageId, content, complete: false },
      });
      lastProjectedContent = content;
    }
    events.push(
      ...semanticEventsFromCodexParts(parts, toolEventStates, publishedArtifactIds, redact),
    );
    if (events.length === 0) return;
    const inserted = await execution.appendEvents({
      worker: { workerId: target.leaseOwner },
      runId: target.turnId,
      attemptId: target.canonicalAttemptId,
      leaseId: target.leaseId,
      events,
    });
    if (inserted.length !== events.length) throw new CodexChatLeaseLostError();
  };

  type AssistantWriteOptions = {
    error?: string | null;
    aborted?: boolean;
    usage?: ChatMessageDebugTrace["usage"];
    durationMs?: number | undefined;
  };

  const computeContent = () =>
    redact(
      parts
        .filter(
          (part): part is Extract<CodexUiMessagePart, { type: "text" }> => part.type === "text",
        )
        .map((part) => part.text)
        .filter((text) => text.trim())
        .join("\n\n"),
    );

  const persistAssistantMessage = async (content: string, options: AssistantWriteOptions) => {
    const redactedParts = redactJson(parts, redact) as unknown[];
    const debugTrace: ChatMessageDebugTrace = {
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

  // Emits the live SSE projection on every call and commits the durable chat_messages row when
  // forced (a part boundary or terminal settle) or once the debounce window elapses. Both live
  // rendering and lease-loss detection run through appendProjectionEvents, so a debounced skip of
  // the DB write never hides a lost lease or stalls the client.
  const syncAssistantMessage = async (
    options: AssistantWriteOptions & { force?: boolean } = {},
  ) => {
    const content = computeContent();
    await appendProjectionEvents(content);
    const nowMs = now();
    if (!options.force && nowMs - lastDurableWriteAt < assistantWriteDebounceMs) return content;
    lastDurableWriteAt = nowMs;
    await persistAssistantMessage(content, options);
    return content;
  };

  const insertEventRow = async (event: HarnessNormalizedEvent) => {
    if (!PERSISTED_EVENT_TYPES.has(event.type as CodexChatEventType)) return true;
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
      throw new CodexChatLeaseLostError();
    } catch (error) {
      if (error instanceof CodexChatLeaseLostError) throw error;
      if (auditFailureReported) return true;
      auditFailureReported = true;
      const persistenceError = new Error("opencompany Codex chat audit event persistence failed.");
      persistenceError.name = "CodexChatEventPersistenceError";
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

  const handleEvent = async (event: HarnessNormalizedEvent) => {
    if (event.type === "command.output") {
      outputAccumulator.push(event);
      return;
    }
    if (event.type === "unknown") return;

    if (event.type === "assistant.delta") {
      const projection = applyCodexEventToUiMessageParts(parts, event);
      if (!projection.changed) return;
      parts = projection.parts;
      // High-frequency token stream: debounce the durable write; the live SSE delta still flows.
      await syncAssistantMessage({ error: turnError });
      return;
    }

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
    // Part boundary (tool/reasoning/plan/etc.): commit the durable row immediately.
    await syncAssistantMessage({ error: turnError, force: true });
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
      ), canceled_approvals AS (
        UPDATE goat.run_approvals AS approval
        SET status = 'canceled',
            resolution = 'canceled',
            response = jsonb_build_object('resolution', 'canceled'),
            resolved_at = ${now},
            updated_at = ${now}
        WHERE approval.run_id = ${target.turnId}
          AND approval.kind = 'acp_permission'
          AND approval.status = 'pending'
          AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        RETURNING approval.id
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
      SELECT approval.id, 'approval-canceled'::text AS status
      FROM canceled_approvals AS approval
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
      status: "approval-canceled" | "auto-resolved" | "canceled" | "resolved";
    }>(result)) {
      if (row.status === "approval-canceled") {
        const projection = resolveCodexUiApproval(parts, {
          approvalId: row.id,
          status: "canceled",
        });
        if (!projection.changed) continue;
        parts = projection.parts;
        didChange = true;
        continue;
      }
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
    sessionStatus: CodexChatSessionStatus;
    error: string | null;
    completedAt?: Date;
    taskCompletion?: TaskTurnCompletion | null | undefined;
    content: string;
    failureDiagnostic?: string;
  }) => {
    const now = options.completedAt ?? new Date();
    await settleDurableTurn({
      target,
      turnStatus: options.turnStatus,
      sessionStatus: options.sessionStatus,
      error: options.error,
      completedAt: now,
      taskCompletion: options.taskCompletion,
      ...(target.canonicalAttemptId
        ? {
            canonicalRun: {
              attemptId: target.canonicalAttemptId,
              assistantMessageId: target.assistantMessageId,
              content: options.content,
              ...(options.failureDiagnostic
                ? { failureDiagnostic: redact(options.failureDiagnostic) }
                : {}),
            },
          }
        : {}),
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
      const artifact = parsePublishedChatArtifact({ ok: true, artifact: row });
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

  // Notifications are already batched serially, but ACP client requests are handled on a
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

    requestUserInput(request: ExternalEngineRequest) {
      return serializeProjection(async () => {
        if (request.method !== "elicitation/create") {
          throw new Error(`Unsupported external-engine request: ${request.method}`);
        }
        if (!isValidEngineUserInputRequest(request.params)) {
          throw new Error("The coding engine sent an invalid user-input request.");
        }
        const questions = request.params.questions as Array<Record<string, unknown>>;
        const interactionId = `goat_codex_chat_interaction_${randomUUID()}`;
        const event: HarnessNormalizedEvent = {
          type: "question.requested",
          rawEvent: { ...request, interactionId },
          payload: {
            threadId: typeof request.params.threadId === "string" ? request.params.threadId : null,
            turnId: typeof request.params.turnId === "string" ? request.params.turnId : null,
            itemId: typeof request.params.itemId === "string" ? request.params.itemId : null,
            requestId: request.id,
            method: request.method,
            interactionId,
            question: typeof questions[0]?.question === "string" ? questions[0].question : null,
            questions,
            ...(typeof request.params.autoResolutionMs === "number"
              ? { autoResolutionMs: request.params.autoResolutionMs }
              : {}),
          },
        };
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
        if (target.canonicalAttemptId) {
          assertRowsChanged(
            await getDb().execute(sql`
              INSERT INTO goat.run_approvals (
                id, run_id, attempt_id, tool_call_id, kind, prompt, options,
                status, created_at, updated_at
              )
              SELECT ${interactionId}, ${target.turnId}, ${target.canonicalAttemptId},
                     ${interactionId}, 'engine_questions',
                     'The coding engine needs more information.', NULL,
                     'pending', ${now}, ${now}
              WHERE EXISTS (${turnLeaseSubquery({ runningOnly: true })})
              RETURNING id
            `),
          );
        }
        await insertEventRow(event);
        const projection = applyCodexEventToUiMessageParts(parts, event);
        if (projection.changed) {
          parts = projection.parts;
          await syncAssistantMessage({ error: turnError, force: true });
        }
        return { interactionId };
      });
    },

    requestApproval(request: ExternalEngineRequest) {
      return serializeProjection(async () => {
        if (request.method !== "session/request_permission") {
          throw new Error(`Unsupported ACP client request: ${request.method}`);
        }
        const toolCall = isRecord(request.params.toolCall) ? request.params.toolCall : null;
        const toolCallId =
          toolCall && typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : null;
        const title = toolCall && typeof toolCall.title === "string" ? toolCall.title.trim() : "";
        const options = Array.isArray(request.params.options) ? request.params.options : [];
        if (!toolCallId || !title || options.length === 0) {
          throw new Error("ACP sent an invalid permission request.");
        }
        const optionIds = options.flatMap((option) => {
          const record = isRecord(option) ? option : null;
          return typeof record?.optionId === "string" ? [record.optionId] : [];
        });
        if (optionIds.length === 0) throw new Error("ACP permission request has no valid options.");

        const approvalId = `opencompany_acp_permission_${randomUUID()}`;
        const rawEvent: Record<string, unknown> = { ...request, interactionId: approvalId };
        const [event] = normalizeEvent(rawEvent);
        if (!event || event.type !== "approval.requested") {
          throw new Error("ACP sent an invalid permission request.");
        }
        const now = new Date();
        assertRowsChanged(
          await getDb().execute(sql`
            INSERT INTO goat.run_approvals (
              id, run_id, attempt_id, tool_call_id, kind, prompt, options,
              status, created_at, updated_at
            )
            SELECT ${approvalId}, ${target.turnId}, ${target.canonicalAttemptId ?? null},
                   ${toolCallId}, 'acp_permission', ${redact(title)},
                   ${JSON.stringify(optionIds)}::jsonb, 'pending', ${now}, ${now}
            WHERE EXISTS (${turnLeaseSubquery({ runningOnly: true })})
            RETURNING id
          `),
        );
        await insertEventRow(event);
        const projection = applyCodexEventToUiMessageParts(parts, event);
        if (projection.changed) {
          parts = projection.parts;
          await syncAssistantMessage({ error: turnError, force: true });
        }
        return { approvalId };
      });
    },

    resolveInteraction(interactionId: string, status: "answered" | "auto-resolved" | "canceled") {
      return serializeProjection(async () => {
        const now = new Date();
        await getDb().execute(sql`
          UPDATE goat.run_approvals AS approval
          SET status = ${status === "canceled" ? "canceled" : "resolved"},
              resolution = ${status === "canceled" ? "canceled" : "answered"},
              response = COALESCE(
                approval.response,
                jsonb_build_object(
                  'resolution', ${status === "canceled" ? "canceled" : "answered"}::text,
                  'autoResolved', ${status === "auto-resolved"}::boolean
                )
              ),
              resolved_at = COALESCE(approval.resolved_at, ${now}),
              updated_at = ${now}
          WHERE approval.id = ${interactionId}
            AND approval.run_id = ${target.turnId}
            AND approval.status = 'pending'
        `);
        const projection = resolveCodexUiInteraction(parts, { interactionId, status });
        if (!projection.changed) return;
        parts = projection.parts;
        await syncAssistantMessage({ error: turnError, force: true });
      });
    },

    resolveApproval(approvalId: string, status: "approved" | "denied" | "canceled") {
      return serializeProjection(async () => {
        const projection = resolveCodexUiApproval(parts, { approvalId, status });
        if (!projection.changed) return;
        parts = projection.parts;
        await syncAssistantMessage({ error: turnError, force: true });
      });
    },

    cancelPendingInteractions() {
      return serializeProjection(async () => {
        const didCancel = await cancelPendingInteractions();
        if (didCancel) await syncAssistantMessage({ error: turnError, force: true });
        return didCancel;
      });
    },

    finalize(
      summary: ExternalEngineTurnSummary,
      options: {
        taskCompletion?: TaskTurnCompletion | null;
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
          const content = await syncAssistantMessage({
            error: null,
            usage,
            durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
            force: true,
          });
          await settleTurn({
            turnStatus: "completed",
            sessionStatus: "idle",
            error: null,
            completedAt,
            taskCompletion: options.taskCompletion,
            content,
          });
          return;
        }
        const error =
          summary.error ?? turnError ?? `Codex finished with status: ${summary.status}.`;
        parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
        const content = await syncAssistantMessage({
          error,
          usage,
          durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
          force: true,
        });
        await settleTurn({
          turnStatus: "failed",
          sessionStatus: "idle",
          error,
          completedAt,
          taskCompletion: options.taskCompletion,
          content,
        });
      });
    },

    interrupted(taskCompletion?: TaskTurnCompletion | null) {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        await reconcilePublishedArtifacts();
        parts = finalizeCodexUiMessageParts(parts, "interrupted").parts;
        const content = await syncAssistantMessage({
          aborted: true,
          durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
          force: true,
        });
        await settleTurn({
          turnStatus: "interrupted",
          sessionStatus: "interrupted",
          error: null,
          completedAt,
          taskCompletion,
          content,
        });
      });
    },

    fail(
      error: string,
      options: {
        sessionStatus?: CodexChatSessionStatus;
        taskCompletion?: TaskTurnCompletion | null;
        failureDiagnostic?: string;
      } = {},
    ) {
      return serializeProjection(async () => {
        const completedAt = new Date();
        await cancelPendingInteractions();
        await reconcilePublishedArtifacts();
        parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
        const content = await syncAssistantMessage({
          error,
          durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
          force: true,
        });
        await settleTurn({
          turnStatus: "failed",
          sessionStatus: options.sessionStatus ?? "idle",
          error,
          completedAt,
          taskCompletion: options.taskCompletion,
          content,
          ...(options.failureDiagnostic ? { failureDiagnostic: options.failureDiagnostic } : {}),
        });
      });
    },
  };
}

async function captureExternalHarnessUsage(input: {
  target: ExternalEngineProjectorTarget;
  summary: ExternalEngineTurnSummary;
  taskCompletion?: TaskTurnCompletion | null | undefined;
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

  await captureProductLlmUsageRecorded({
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

function externalHarnessUsageStage(_engine: ProductAnalyticsEngine): ProductLlmUsageAnalyticsStage {
  return "execution";
}

function externalHarnessModelProvider(engine: ProductAnalyticsEngine) {
  if (engine === "claude_code") return "anthropic";
  if (engine === "codex") return "openai";
  return "external";
}

function positiveTokenCount(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function assertRowsChanged(result: unknown) {
  if (rowsFromExecute(result).length === 0) {
    throw new CodexChatLeaseLostError();
  }
}

function elapsedTurnDurationMs(startedAt: Date | undefined, completedAt: Date) {
  if (!startedAt || Number.isNaN(startedAt.getTime())) return undefined;
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function semanticEventsFromCodexParts(
  parts: readonly CodexUiMessagePart[],
  toolStates: Map<string, "started" | "completed" | "failed">,
  artifactIds: Set<string>,
  redact: (value: string) => string,
) {
  const events: RunEventDraft[] = [];
  const visit = (values: readonly CodexUiMessagePart[], parentToolCallId?: string) => {
    for (const part of values) {
      const record = part as unknown as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : null;
      const state = typeof record.state === "string" ? record.state : null;
      if (toolCallId && state && (type === "dynamic-tool" || type.startsWith("tool-"))) {
        if (!toolStates.has(toolCallId)) {
          events.push({
            id: `run_event_${randomUUID()}`,
            type: "tool.started",
            payload: {
              toolCallId,
              ...semanticToolStartedPayload(record, type, parentToolCallId, redact),
            },
          });
          toolStates.set(toolCallId, "started");
        }
        if (
          (state === "output-available" || state === "completed") &&
          toolStates.get(toolCallId) !== "completed"
        ) {
          events.push({
            id: `run_event_${randomUUID()}`,
            type: "tool.completed",
            payload: {
              toolCallId,
              summary: semanticToolOutcome(record, redact),
            },
          });
          toolStates.set(toolCallId, "completed");
        } else if (
          (state === "output-error" || state === "failed" || state === "output-denied") &&
          toolStates.get(toolCallId) !== "failed"
        ) {
          events.push({
            id: `run_event_${randomUUID()}`,
            type: "tool.failed",
            payload: {
              toolCallId,
              code: state === "output-denied" ? "denied" : "tool_error",
              message:
                typeof record.errorText === "string"
                  ? redact(record.errorText)
                  : state === "output-denied"
                    ? "Tool execution was denied."
                    : "Tool execution failed.",
            },
          });
          toolStates.set(toolCallId, "failed");
        }
      }
      if (type === "data-artifact-file" && isRecord(record.data)) {
        const artifact = record.data;
        const artifactId = typeof artifact.artifactId === "string" ? artifact.artifactId : null;
        if (
          artifactId &&
          !artifactIds.has(artifactId) &&
          typeof artifact.title === "string" &&
          typeof artifact.filename === "string" &&
          typeof artifact.mediaType === "string" &&
          typeof artifact.sizeBytes === "number"
        ) {
          events.push({
            id: `run_event_${randomUUID()}`,
            type: "artifact.published",
            payload: {
              artifactId,
              title: redact(artifact.title),
              filename: redact(artifact.filename),
              mediaType: artifact.mediaType,
              sizeBytes: artifact.sizeBytes,
            },
          });
          artifactIds.add(artifactId);
        }
      }
      if (Array.isArray(record.children)) {
        visit(record.children as CodexUiMessagePart[], toolCallId ?? parentToolCallId);
      }
    }
  };
  visit(parts);
  return events;
}

const SEMANTIC_TOOL_LABEL_LIMIT = 500;
const SEMANTIC_TOOL_DETAIL_LIMIT = 4_000;
const SEMANTIC_TOOL_KIND_LIMIT = 100;

function semanticToolStartedPayload(
  part: Record<string, unknown>,
  type: string,
  parentToolCallId: string | undefined,
  redact: (value: string) => string,
) {
  const name =
    typeof part.toolName === "string" ? part.toolName : type.slice("tool-".length) || "tool";
  const input = isRecord(part.input) ? part.input : {};
  const fallback = semanticToolFallback(name);
  const label = semanticToolText(
    name === CODEX_COMMAND_TOOL_NAME
      ? (input.description ?? input.label ?? fallback.label)
      : (input.label ?? input.title ?? fallback.label),
    SEMANTIC_TOOL_LABEL_LIMIT,
    redact,
  );
  const detail = semanticToolText(
    semanticToolDetail(name, input),
    SEMANTIC_TOOL_DETAIL_LIMIT,
    redact,
  );
  const kind = semanticToolText(
    input.kind ??
      (name === CODEX_SUBAGENT_TOOL_NAME ? input.subagentType : undefined) ??
      fallback.kind,
    SEMANTIC_TOOL_KIND_LIMIT,
    redact,
  );
  return {
    name,
    ...(label ? { label } : {}),
    ...(detail ? { detail } : {}),
    ...(kind ? { kind } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function semanticToolDetail(name: string, input: Record<string, unknown>) {
  if (name === CODEX_COMMAND_TOOL_NAME) return input.command;
  if (name === CODEX_MCP_TOOL_NAME) {
    const target = [input.server, input.tool ?? input.toolName]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join(".");
    return target || input.title;
  }
  if (name === CODEX_WEB_SEARCH_TOOL_NAME) return input.query ?? input.title ?? input.toolName;
  if (name === CODEX_SUBAGENT_TOOL_NAME) return input.description ?? input.prompt ?? input.title;
  if (name === CODEX_FILE_CHANGE_TOOL_NAME) {
    const paths = Array.isArray(input.changes)
      ? input.changes
          .map((change) =>
            isRecord(change) && typeof change.path === "string" ? change.path : null,
          )
          .filter((path): path is string => Boolean(path))
      : [];
    return paths.length > 0 ? paths.join(", ") : input.title;
  }
  return (
    input.detail ??
    input.description ??
    input.command ??
    input.query ??
    input.action ??
    input.question ??
    input.title
  );
}

function semanticToolFallback(name: string) {
  if (name === CODEX_COMMAND_TOOL_NAME) return { label: "Command", kind: "execute" };
  if (name === CODEX_MCP_TOOL_NAME) return { label: "MCP tool", kind: "mcp" };
  if (name === CODEX_WEB_SEARCH_TOOL_NAME) return { label: "Web search", kind: "search" };
  if (name === CODEX_FILE_CHANGE_TOOL_NAME) return { label: "File change", kind: "edit" };
  if (name === CODEX_SUBAGENT_TOOL_NAME) return { label: "Subagent", kind: "subagent" };
  return { label: humanizeToolName(name), kind: "tool" };
}

function semanticToolOutcome(part: Record<string, unknown>, redact: (value: string) => string) {
  const output = isRecord(part.output) ? part.output : {};
  return (
    semanticToolText(output.status ?? output.summary, SEMANTIC_TOOL_LABEL_LIMIT, redact) ??
    "completed"
  );
}

function semanticToolText(value: unknown, limit: number, redact: (value: string) => string) {
  if (typeof value !== "string") return undefined;
  const redacted = redact(value).trim();
  return redacted ? redacted.slice(0, limit) : undefined;
}

function humanizeToolName(name: string) {
  const label = name
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return label || "Tool";
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

function codexChatEventKey(event: HarnessNormalizedEvent) {
  const itemId = typeof event.payload.itemId === "string" ? event.payload.itemId : null;
  if (itemId && ITEM_LIFECYCLE_EVENT_TYPES.has(event.type)) return `${event.type}:${itemId}`;
  const turnId = typeof event.payload.turnId === "string" ? event.payload.turnId : null;
  if (turnId && (event.type === "turn.started" || event.type === "turn.completed")) {
    return `${event.type}:${turnId}`;
  }
  return null;
}

const ITEM_LIFECYCLE_EVENT_TYPES = new Set<HarnessNormalizedEvent["type"]>([
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

function isValidEngineUserInputRequest(params: Record<string, unknown>) {
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
    .select({ debugTrace: chatMessages.debugTrace })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, assistantMessageId), eq(chatMessages.role, "assistant")))
    .limit(1);
  return parseCodexUiMessageParts(message?.debugTrace?.uiMessageParts);
}

// Secrets can surface anywhere in event payloads (command echoes, error messages), so redaction
// runs over the serialized JSON rather than individual fields.
function redactJson(value: unknown, redact: (value: string) => string): unknown {
  return JSON.parse(redact(JSON.stringify(value ?? null)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

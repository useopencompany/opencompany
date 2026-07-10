import {
  applyCodexEventToUiMessageParts,
  type CodexAppServerNormalizedEvent,
  type CodexUiMessagePart,
  createCodexCommandOutputAccumulator,
  finalizeCodexUiMessageParts,
  normalizeCodexAppServerEvent,
  parseCodexUiMessageParts,
} from "@opencompany/agent-runtime";
import {
  type GoatChatMessageDebugTrace,
  type GoatCodexChatEventType,
  type GoatCodexChatSessionStatus,
  goatChatMessages,
} from "@opencompany/db/goat-schema";
import { and, eq, sql } from "drizzle-orm";
import type { CodexAppServerSummary } from "./codex-app-server";
import { getDb } from "./db";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { rowsFromExecute } from "./sql-exec";

const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1" as const;

// Event types that are persisted to goat.codex_chat_events. Deltas are volume, not chunks:
// they never land in the audit log or the message row.
const PERSISTED_EVENT_TYPES = new Set<GoatCodexChatEventType>([
  "assistant.completed",
  "reasoning.completed",
  "command.started",
  "command.completed",
  "command.failed",
  "plan.updated",
  "goal.updated",
  "question.requested",
  "approval.requested",
  "turn.started",
  "turn.completed",
  "usage.updated",
  "error",
]);

export type GoatCodexChatProjectorTarget = {
  userWorkosId: string;
  codexChatSessionId: string;
  chatSessionId: string;
  turnId: string;
  assistantMessageId: string;
  model: string;
  leaseId: string;
  leaseOwner: string;
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
    if (!PERSISTED_EVENT_TYPES.has(event.type as GoatCodexChatEventType)) return;
    assertRowsChanged(
      await getDb().execute(sql`
        INSERT INTO goat.codex_chat_events (
          user_workos_id,
          codex_chat_session_id,
          codex_chat_turn_id,
          type,
          payload,
          raw_event,
          created_at
        )
        SELECT ${target.userWorkosId},
               ${target.codexChatSessionId},
               ${target.turnId},
               ${event.type},
               ${JSON.stringify(redactJson(event.payload, redact))}::jsonb,
               ${JSON.stringify(redactJson(event.rawEvent, redact))}::jsonb,
               ${new Date()}
        WHERE EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        RETURNING id
      `),
    );
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

    await insertEventRow(event);

    if (event.type === "turn.started") {
      const codexTurnId = typeof event.payload.turnId === "string" ? event.payload.turnId : null;
      await markTurnRunning(codexTurnId);
      return;
    }
    if (event.type === "turn.completed" || event.type === "usage.updated") {
      // Terminal transitions and usage land in finalize() with the full summary.
      return;
    }

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

  const settleTurn = async (options: {
    turnStatus: "completed" | "failed" | "interrupted";
    sessionStatus: GoatCodexChatSessionStatus;
    error: string | null;
    completedAt?: Date;
  }) => {
    const now = options.completedAt ?? new Date();
    assertRowsChanged(
      await getDb().execute(sql`
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
      `),
    );
    assertRowsChanged(
      await getDb().execute(sql`
        UPDATE goat.codex_chat_sessions AS session
        SET active_turn_id = NULL,
            status = ${options.sessionStatus},
            error = ${options.error},
            updated_at = ${now}
        WHERE session.id = ${target.codexChatSessionId}
          AND session.user_workos_id = ${target.userWorkosId}
          AND (session.active_turn_id IS NULL OR session.active_turn_id = ${target.turnId})
          AND EXISTS (${turnLeaseSubquery({ runningOnly: false })})
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

  return {
    // Serialized by the app-server notification batcher: each flush awaits this before the next.
    async push(rawEvents: Record<string, unknown>[]) {
      for (const raw of rawEvents) {
        for (const event of normalizeCodexAppServerEvent(raw)) {
          await handleEvent(event);
        }
      }
    },

    async finalize(summary: CodexAppServerSummary) {
      const completedAt = new Date();
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
      const error = summary.error ?? turnError ?? `Codex finished with status: ${summary.status}.`;
      parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
      await writeAssistantMessage({
        error,
        usage,
        durationMs: elapsedTurnDurationMs(target.turnCreatedAt, completedAt),
      });
      await settleTurn({ turnStatus: "failed", sessionStatus: "idle", error, completedAt });
    },

    async interrupted() {
      const completedAt = new Date();
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
    },

    async fail(error: string, options: { sessionStatus?: GoatCodexChatSessionStatus } = {}) {
      const completedAt = new Date();
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

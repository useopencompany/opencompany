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
  goatChatSessions,
  goatCodexChatEvents,
  goatCodexChatSessions,
  goatCodexChatTurns,
} from "@opencompany/db/goat-schema";
import { and, eq } from "drizzle-orm";
import type { CodexAppServerSummary } from "./codex-app-server";
import { getDb } from "./db";

const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1" as const;

// Event types that are persisted to goat.codex_chat_events. Deltas are volume, not chunks:
// they never land in the audit log or the message row.
const PERSISTED_EVENT_TYPES = new Set<GoatCodexChatEventType>([
  "assistant.completed",
  "reasoning.completed",
  "command.started",
  "command.completed",
  "command.failed",
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
    };
    await getDb()
      .update(goatChatMessages)
      .set({ content, debugTrace, updatedAt: new Date() })
      .where(
        and(
          eq(goatChatMessages.id, target.assistantMessageId),
          eq(goatChatMessages.role, "assistant"),
        ),
      );
  };

  const insertEventRow = async (event: CodexAppServerNormalizedEvent) => {
    if (!PERSISTED_EVENT_TYPES.has(event.type as GoatCodexChatEventType)) return;
    await getDb()
      .insert(goatCodexChatEvents)
      .values({
        userWorkosId: target.userWorkosId,
        codexChatSessionId: target.codexChatSessionId,
        codexChatTurnId: target.turnId,
        type: event.type as GoatCodexChatEventType,
        payload: redactJson(event.payload, redact) as Record<string, unknown>,
        rawEvent: redactJson(event.rawEvent, redact) as Record<string, unknown>,
        createdAt: new Date(),
      });
  };

  const markTurnRunning = async (codexTurnId: string | null) => {
    const now = new Date();
    await getDb()
      .update(goatCodexChatTurns)
      .set({
        ...(codexTurnId ? { codexTurnId } : {}),
        status: "running",
        updatedAt: now,
      })
      .where(turnLeaseWhere());
    await getDb()
      .update(goatCodexChatSessions)
      .set({ status: "running", activeTurnId: target.turnId, error: null, updatedAt: now })
      .where(sessionWhere());
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
  }) => {
    const now = new Date();
    await getDb()
      .update(goatCodexChatTurns)
      .set({
        status: options.turnStatus,
        error: options.error,
        completedAt: now,
        updatedAt: now,
      })
      .where(turnLeaseWhere());
    await getDb()
      .update(goatCodexChatSessions)
      .set({
        activeTurnId: null,
        status: options.sessionStatus,
        error: options.error,
        updatedAt: now,
      })
      .where(sessionWhere());
    await getDb()
      .update(goatChatSessions)
      .set({ updatedAt: now })
      .where(
        and(
          eq(goatChatSessions.id, target.chatSessionId),
          eq(goatChatSessions.userWorkosId, target.userWorkosId),
        ),
      );
  };

  const turnLeaseWhere = () =>
    and(
      eq(goatCodexChatTurns.id, target.turnId),
      eq(goatCodexChatTurns.userWorkosId, target.userWorkosId),
      eq(goatCodexChatTurns.leaseId, target.leaseId),
      eq(goatCodexChatTurns.leaseOwner, target.leaseOwner),
    );

  const sessionWhere = () =>
    and(
      eq(goatCodexChatSessions.id, target.codexChatSessionId),
      eq(goatCodexChatSessions.userWorkosId, target.userWorkosId),
    );

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
        await writeAssistantMessage({ error: null, usage });
        await settleTurn({ turnStatus: "completed", sessionStatus: "idle", error: null });
        return;
      }
      const error = summary.error ?? turnError ?? `Codex finished with status: ${summary.status}.`;
      parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
      await writeAssistantMessage({ error, usage });
      await settleTurn({ turnStatus: "failed", sessionStatus: "idle", error });
    },

    async interrupted() {
      parts = finalizeCodexUiMessageParts(parts, "interrupted").parts;
      await writeAssistantMessage({ aborted: true });
      await settleTurn({ turnStatus: "interrupted", sessionStatus: "interrupted", error: null });
    },

    async fail(error: string, options: { sessionStatus?: GoatCodexChatSessionStatus } = {}) {
      parts = finalizeCodexUiMessageParts(parts, "failed", error).parts;
      await writeAssistantMessage({ error });
      await settleTurn({
        turnStatus: "failed",
        sessionStatus: options.sessionStatus ?? "idle",
        error,
      });
    },
  };
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

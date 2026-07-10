import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import { goatChatSessions, goatCodexChatSessions } from "@opencompany/db/goat-schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { newGoatChatMessageId } from "@/lib/chat";
import { nextGoatChatMessageCreatedAt } from "@/lib/chat-ui";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { CODEX_CHAT_DEFAULT_MODEL, CODEX_CHAT_PROMPT_MAX_LENGTH } from "@/lib/codex-chat-constants";
import { toGoatTaskTitle } from "@/lib/task-display";
import { triggerGoatCodexChatWake } from "@/lib/task-runner";

export { CODEX_CHAT_DEFAULT_MODEL, CODEX_PICKER_VALUE } from "@/lib/codex-chat-constants";

// Cloud codex chat sessions record the gateway-style model id on the chat session (like every
// other engine) while the codex_chat_sessions row keeps the Codex CLI model name.
const CODEX_CHAT_SESSION_MODEL: AgentModelId = "openai/gpt-5.5";
const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1";

export const CODEX_CHAT_DISCONNECTED_MESSAGE =
  "Connect Codex in Goat settings before chatting with the Codex engine.";

export type CodexChatMessageResult =
  | {
      ok: true;
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string;
      mode: "started" | "queued";
    }
  | { ok: false; status: number; error: string };

export async function createGoatCodexChatMessage(input: {
  userWorkosId: string;
  sessionId?: string | null;
  prompt: string;
  clientMessageId?: string | null;
}): Promise<CodexChatMessageResult> {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, status: 400, error: "Enter a message before sending." };
  if (prompt.length > CODEX_CHAT_PROMPT_MAX_LENGTH) {
    return { ok: false, status: 400, error: "Messages can be at most 10,000 characters." };
  }

  if (!(await isGoatCodexConnectedForUser(input.userWorkosId))) {
    return { ok: false, status: 409, error: CODEX_CHAT_DISCONNECTED_MESSAGE };
  }

  let result: CodexChatMessageResult;
  if (input.sessionId) {
    const session = await loadCodexChatSessionForChat({
      userWorkosId: input.userWorkosId,
      chatSessionId: input.sessionId,
    });
    if (!session) return { ok: false, status: 404, error: "Codex chat session not found." };
    result = await enqueueExistingCodexChatMessage({
      userWorkosId: input.userWorkosId,
      prompt,
      clientMessageId: input.clientMessageId ?? null,
      session,
    });
  } else {
    result = await createFirstCodexChatTurn({
      userWorkosId: input.userWorkosId,
      prompt,
      clientMessageId: input.clientMessageId ?? null,
    });
  }

  if (result.ok) {
    // Best-effort nudge; the runner worker's poll loop picks the turn up regardless.
    await triggerGoatCodexChatWake().catch((error) => {
      console.warn("Goat codex chat wake failed.", {
        event: "goat.codex_chat_wake_failed",
        error,
      });
    });
  }
  return result;
}

export async function interruptGoatCodexChatSession(input: {
  userWorkosId: string;
  chatSessionId: string;
}) {
  const session = await loadCodexChatSessionForChat({
    userWorkosId: input.userWorkosId,
    chatSessionId: input.chatSessionId,
  });
  if (!session) return { ok: false, status: 404, error: "Codex chat session not found." };

  const now = new Date();
  // A running turn is interrupted cooperatively: the runner polls the flag and sends
  // turn/interrupt. Turns still waiting in the queue are cancelled directly here, including
  // their assistant placeholders, so a stop never leaves zombie queued work behind.
  await getDb().execute(sql`
    UPDATE goat.codex_chat_turns
    SET interrupt_requested_at = COALESCE(interrupt_requested_at, ${now}),
        updated_at = ${now}
    WHERE codex_chat_session_id = ${session.id}
      AND user_workos_id = ${input.userWorkosId}
      AND status = 'running'
  `);
  await getDb().execute(sql`
    WITH cancelled AS (
      UPDATE goat.codex_chat_turns
      SET status = 'interrupted',
          completed_at = ${now},
          updated_at = ${now}
      WHERE codex_chat_session_id = ${session.id}
        AND user_workos_id = ${input.userWorkosId}
        AND status = 'queued'
      RETURNING assistant_message_id
    )
    UPDATE goat.chat_messages AS message
    SET debug_trace = COALESCE(message.debug_trace, '{}'::jsonb)
          || jsonb_build_object('aborted', true, 'schemaVersion', ${CODEX_CHAT_DEBUG_SCHEMA_VERSION}::text),
        updated_at = ${now}
    FROM cancelled
    WHERE message.id = cancelled.assistant_message_id
      AND message.role = 'assistant'
  `);
  return { ok: true, status: 202, error: null };
}

async function loadCodexChatSessionForChat(input: { userWorkosId: string; chatSessionId: string }) {
  const [row] = await getDb()
    .select()
    .from(goatCodexChatSessions)
    .innerJoin(goatChatSessions, eq(goatChatSessions.id, goatCodexChatSessions.chatSessionId))
    .where(
      and(
        eq(goatCodexChatSessions.userWorkosId, input.userWorkosId),
        eq(goatCodexChatSessions.chatSessionId, input.chatSessionId),
        isNull(goatChatSessions.closedAt),
      ),
    )
    .limit(1);
  return row?.codex_chat_sessions ?? null;
}

async function createFirstCodexChatTurn(input: {
  userWorkosId: string;
  prompt: string;
  clientMessageId: string | null;
}): Promise<CodexChatMessageResult> {
  const chatSessionId = `goat_chat_${randomUUID()}`;
  const codexChatSessionId = `goat_codex_chat_${randomUUID()}`;
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const userMessageId = safeClientMessageId(input.clientMessageId) ?? newGoatChatMessageId();
  const assistantMessageId = newGoatChatMessageId();
  const now = new Date();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const title = toGoatTaskTitle(input.prompt);

  await getDb().execute(sql`
    WITH created_chat AS (
      INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, created_at, updated_at)
      VALUES (
        ${chatSessionId},
        ${input.userWorkosId},
        ${title},
        ${CODEX_CHAT_SESSION_MODEL},
        'codex',
        ${now},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_user_message AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, created_at, updated_at)
      VALUES (${userMessageId}, ${chatSessionId}, 'user', ${input.prompt}, ${now}, ${now})
      RETURNING id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      VALUES (
        ${assistantMessageId},
        ${chatSessionId},
        'assistant',
        '',
        ${JSON.stringify(emptyAssistantDebugTrace())}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_codex_session AS (
      INSERT INTO goat.codex_chat_sessions (
        id, user_workos_id, chat_session_id, model, active_turn_id, status, created_at, updated_at
      )
      VALUES (
        ${codexChatSessionId},
        ${input.userWorkosId},
        ${chatSessionId},
        ${CODEX_CHAT_DEFAULT_MODEL},
        ${turnId},
        'starting',
        ${now},
        ${now}
      )
      RETURNING id
    )
    INSERT INTO goat.codex_chat_turns (
      id, user_workos_id, codex_chat_session_id, chat_session_id,
      user_message_id, assistant_message_id, status, prompt, created_at, updated_at
    )
    VALUES (
      ${turnId},
      ${input.userWorkosId},
      ${codexChatSessionId},
      ${chatSessionId},
      ${userMessageId},
      ${assistantMessageId},
      'queued',
      ${input.prompt},
      ${now},
      ${now}
    )
  `);

  return { ok: true, sessionId: chatSessionId, userMessageId, assistantMessageId, mode: "started" };
}

async function enqueueExistingCodexChatMessage(input: {
  userWorkosId: string;
  prompt: string;
  clientMessageId: string | null;
  session: { id: string; chatSessionId: string; status: string };
}): Promise<CodexChatMessageResult> {
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const userMessageId = safeClientMessageId(input.clientMessageId) ?? newGoatChatMessageId();
  const assistantMessageId = newGoatChatMessageId();
  const now = new Date();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const running = input.session.status === "running" || input.session.status === "starting";

  await getDb().execute(sql`
    WITH inserted_user_message AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, created_at, updated_at)
      VALUES (${userMessageId}, ${input.session.chatSessionId}, 'user', ${input.prompt}, ${now}, ${now})
      RETURNING id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      VALUES (
        ${assistantMessageId},
        ${input.session.chatSessionId},
        'assistant',
        '',
        ${JSON.stringify(emptyAssistantDebugTrace())}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_turn AS (
      INSERT INTO goat.codex_chat_turns (
        id, user_workos_id, codex_chat_session_id, chat_session_id,
        user_message_id, assistant_message_id, status, prompt, created_at, updated_at
      )
      VALUES (
        ${turnId},
        ${input.userWorkosId},
        ${input.session.id},
        ${input.session.chatSessionId},
        ${userMessageId},
        ${assistantMessageId},
        'queued',
        ${input.prompt},
        ${now},
        ${now}
      )
      RETURNING id
    )
    UPDATE goat.chat_sessions
    SET updated_at = ${assistantCreatedAt}
    WHERE id = ${input.session.chatSessionId}
      AND user_workos_id = ${input.userWorkosId}
  `);

  return {
    ok: true,
    sessionId: input.session.chatSessionId,
    userMessageId,
    assistantMessageId,
    mode: running ? "queued" : "started",
  };
}

function emptyAssistantDebugTrace() {
  return {
    schemaVersion: CODEX_CHAT_DEBUG_SCHEMA_VERSION,
    model: CODEX_CHAT_DEFAULT_MODEL,
    uiMessageParts: [],
  };
}

function safeClientMessageId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return trimmed;
}

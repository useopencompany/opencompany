import { randomUUID } from "node:crypto";
import {
  claudeCodeCliModelNameForModelId,
  codexCliModelNameForModelId,
  GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION,
  isCloudCodingEngine,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  type GoatChatMessageAttachment,
  type GoatCodexChatEngine,
  type GoatCodexChatTurnSettings,
  goatChatSessions,
  goatCodexChatSessions,
} from "@opencompany/db/goat-schema";
import {
  emptyAssistantDebugTrace,
  nextGoatChatMessageCreatedAt,
} from "@opencompany/goat-agent/chat-ui";
import type { GoatBrainSkill } from "@opencompany/goat-brain";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { newGoatChatMessageId } from "@/lib/chat";
import { CLAUDE_CHAT_DEFAULT_MODEL_ID, parseClaudeChatModelId } from "@/lib/claude-chat-constants";
import { parseClaudeChatSettings } from "@/lib/claude-chat-settings";
import { isGoatClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import {
  CODEX_CHAT_DEFAULT_MODEL_ID,
  CODEX_CHAT_PROMPT_MAX_LENGTH,
  parseCodexChatModelId,
} from "@/lib/codex-chat-constants";
import { parseCodexChatSettings } from "@/lib/codex-chat-settings";
import { DEFAULT_GOAT_MODEL, normalizeGoatModel } from "@/lib/model-options";
import { toGoatTaskTitle } from "@/lib/task-display";
import {
  type GoatCodexSandboxStatus,
  GoatCodingWorkspaceRequestError,
  getGoatCodexSandboxStatus,
  killGoatCodexSandbox,
  requestGoatCodingWorkspaceRuntimeAccess,
  triggerGoatCodexChatWake,
} from "@/lib/task-runner";

export { CODEX_CHAT_DEFAULT_MODEL, CODEX_PICKER_VALUE } from "@/lib/codex-chat-constants";

// Coding-engine sessions record the gateway-style model id on chat_sessions while their
// codex_chat_sessions row keeps the CLI model name. OpenCompany durable turns use the gateway id
// in both rows because they have no separate sandbox runtime.
const CODEX_CHAT_DEBUG_SCHEMA_VERSION = "goat.codex_chat.debug.v1";
const OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION = "opencompany.chat.debug.v1";

export const CODEX_CHAT_DISCONNECTED_MESSAGE =
  "Connect Codex in Goat settings before chatting with the Codex engine.";

export const CLAUDE_CHAT_DISCONNECTED_MESSAGE =
  "Connect Claude Code in Goat settings before chatting with the Claude engine.";

export type CodexChatMessageResult =
  | {
      ok: true;
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string;
      mode: "started" | "queued";
      analytics: {
        isFirstMessage: boolean;
        engine: GoatCodexChatEngine;
        model: string;
      };
    }
  | { ok: false; status: number; error: string };

export type GoatCodexChatSkillSnapshot = GoatBrainSkill & { brainRef: string };

export async function createGoatCodexChatMessage(input: {
  userWorkosId: string;
  workspaceId: string;
  brainRef?: string | null;
  sessionId?: string | null;
  newSessionId?: string | null;
  prompt: string;
  skills?: GoatCodexChatSkillSnapshot[];
  attachments?: GoatChatMessageAttachment[];
  clientMessageId?: string | null;
  settings?: unknown;
  model?: unknown;
  engine?: GoatCodexChatEngine;
}): Promise<CodexChatMessageResult> {
  const engine = input.engine ?? "codex";
  const prompt = input.prompt.trim();
  const attachments = input.attachments ?? [];
  const skills = input.skills ?? [];
  if (!prompt && attachments.length === 0) {
    return { ok: false, status: 400, error: "Enter a message or attach a file before sending." };
  }
  if (prompt.length > CODEX_CHAT_PROMPT_MAX_LENGTH) {
    return { ok: false, status: 400, error: "Messages can be at most 10,000 characters." };
  }

  if (engine === "opencompany") {
    // Internal-only durable OpenCompany enqueues need no coding-CLI credential.
  } else if (engine === "claude_code") {
    if (!(await isGoatClaudeCodeConnectedForUser(input.userWorkosId))) {
      return { ok: false, status: 409, error: CLAUDE_CHAT_DISCONNECTED_MESSAGE };
    }
  } else if (!(await isGoatCodexConnectedForUser(input.userWorkosId))) {
    return { ok: false, status: 409, error: CODEX_CHAT_DISCONNECTED_MESSAGE };
  }

  let settings: GoatCodexChatTurnSettings = {};
  if (engine !== "opencompany") {
    const parsedSettings =
      engine === "claude_code"
        ? parseClaudeChatSettings(input.settings)
        : parseCodexChatSettings(input.settings);
    if (!parsedSettings.ok) return { ok: false, status: 400, error: parsedSettings.error };
    settings = parsedSettings.settings;
  }
  const normalizedOpenCompanyModel =
    engine === "opencompany" && input.model !== undefined
      ? normalizeGoatModel(input.model)
      : DEFAULT_GOAT_MODEL;
  const requestedModelId =
    engine === "opencompany"
      ? input.model === undefined
        ? DEFAULT_GOAT_MODEL
        : normalizedOpenCompanyModel === input.model
          ? normalizedOpenCompanyModel
          : null
      : engine === "claude_code"
        ? input.model === undefined
          ? CLAUDE_CHAT_DEFAULT_MODEL_ID
          : parseClaudeChatModelId(input.model)
        : input.model === undefined
          ? CODEX_CHAT_DEFAULT_MODEL_ID
          : parseCodexChatModelId(input.model);
  if (!requestedModelId) {
    return {
      ok: false,
      status: 400,
      error:
        engine === "opencompany"
          ? "Select a supported Goat model."
          : engine === "claude_code"
            ? "Select a supported Claude model."
            : "Select a supported Codex model.",
    };
  }
  let result: CodexChatMessageResult;
  if (input.sessionId) {
    const session = await loadCodexChatSessionForChat({
      userWorkosId: input.userWorkosId,
      chatSessionId: input.sessionId,
    });
    if (!session) return { ok: false, status: 404, error: "Codex chat session not found." };
    if ((session.engine ?? "codex") !== engine) {
      return { ok: false, status: 409, error: "This chat runs on a different coding engine." };
    }
    result = await enqueueExistingCodexChatMessage({
      userWorkosId: input.userWorkosId,
      prompt,
      skills,
      clientMessageId: input.clientMessageId ?? null,
      attachments,
      settings,
      session,
    });
  } else {
    result = await createFirstCodexChatTurn({
      chatSessionId: input.newSessionId ?? null,
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      brainRef: input.brainRef ?? null,
      prompt,
      skills,
      clientMessageId: input.clientMessageId ?? null,
      attachments,
      settings,
      modelId: requestedModelId,
      engine,
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
    SET debug_trace = COALESCE(
          message.debug_trace,
          ${JSON.stringify(emptyDurableAssistantDebugTrace(session.engine, session.model))}::jsonb
        ) || jsonb_build_object('aborted', true),
        updated_at = ${now}
    FROM cancelled
    WHERE message.id = cancelled.assistant_message_id
      AND message.role = 'assistant'
  `);
  // Running turns settle the session from the runner, but a stop that only cancelled queued
  // turns has no runner to do it: without this the session would stay queued/starting/running
  // forever and the UI would show an eternal spinner.
  await getDb().execute(sql`
    UPDATE goat.codex_chat_sessions AS session
    SET status = 'interrupted',
        active_turn_id = NULL,
        updated_at = ${now}
    WHERE session.id = ${session.id}
      AND session.user_workos_id = ${input.userWorkosId}
      AND session.status IN ('queued', 'starting', 'running')
      AND NOT EXISTS (
        SELECT 1
        FROM goat.codex_chat_turns AS turn
        WHERE turn.codex_chat_session_id = session.id
          AND turn.status = 'running'
      )
  `);
  return { ok: true, status: 202, error: null };
}

export async function getGoatCodexChatSandboxStatus(input: {
  userWorkosId: string;
  chatSessionId: string;
}): Promise<
  | { ok: true; status: GoatCodexSandboxStatus | null }
  | { ok: false; statusCode: number; error: string }
> {
  const session = await loadCodexChatSessionForChat({
    userWorkosId: input.userWorkosId,
    chatSessionId: input.chatSessionId,
  });
  if (!session) return { ok: false, statusCode: 404, error: "Codex chat session not found." };
  if (!session.sandboxId) return { ok: true, status: null };

  try {
    return {
      ok: true,
      status: await getGoatCodexSandboxStatus(session.sandboxId),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      error: error instanceof Error ? error.message : "Unable to load Codex sandbox status.",
    };
  }
}

export async function createGoatCodingWorkspaceRuntimeAccess(input: {
  userWorkosId: string;
  chatSessionId: string;
}) {
  const session = await loadCodexChatSessionForChat(input);
  if (!session)
    return { ok: false as const, statusCode: 404, error: "Coding workspace session not found." };
  if (session.status === "closed" || !isCloudCodingEngine(session.engine)) {
    return { ok: false as const, statusCode: 404, error: "Coding workspace session not found." };
  }
  if (!session.sandboxId) {
    return {
      ok: false as const,
      statusCode: 409,
      error: "The coding workspace is not ready yet. Send a message first.",
    };
  }

  try {
    return {
      ok: true as const,
      access: await requestGoatCodingWorkspaceRuntimeAccess({
        codingSessionId: session.id,
        userWorkosId: input.userWorkosId,
      }),
    };
  } catch (error) {
    return {
      ok: false as const,
      statusCode: error instanceof GoatCodingWorkspaceRequestError ? error.statusCode : 502,
      error: error instanceof Error ? error.message : "Unable to connect to the coding workspace.",
    };
  }
}

// Settles the engine session and kills its e2b sandbox after the parent chat is closed.
// A session with in-flight work (queued/starting/running) is left alone: the runner settles it
// and the sandbox idle timeout pauses the sandbox regardless, so nothing keeps running either way.
export async function closeGoatCodexChatSessionForChat(input: {
  userWorkosId: string;
  chatSessionId: string;
}) {
  const now = new Date();
  const [session] = await getDb()
    .update(goatCodexChatSessions)
    .set({ status: "closed", activeTurnId: null, updatedAt: now })
    .where(
      and(
        eq(goatCodexChatSessions.chatSessionId, input.chatSessionId),
        eq(goatCodexChatSessions.userWorkosId, input.userWorkosId),
        notInArray(goatCodexChatSessions.status, ["queued", "starting", "running", "closed"]),
      ),
    )
    .returning({ sandboxId: goatCodexChatSessions.sandboxId });
  await cancelQueuedCodexChatWakeups({
    userWorkosId: input.userWorkosId,
    chatSessionId: input.chatSessionId,
    now,
  });
  if (!session?.sandboxId) return;

  // Best-effort: a paused sandbox that outlives the kill only costs storage until e2b's
  // retention window deletes it.
  await killGoatCodexSandbox(session.sandboxId).catch((error) => {
    console.warn("Goat codex sandbox kill on chat close failed.", {
      event: "goat.codex_chat_close_sandbox_kill_failed",
      chat_session_id: input.chatSessionId,
      error,
    });
  });
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
  return row
    ? {
        ...row.codex_chat_sessions,
        chatModel: row.chat_sessions.model,
      }
    : null;
}

async function createFirstCodexChatTurn(input: {
  chatSessionId: string | null;
  userWorkosId: string;
  workspaceId: string;
  brainRef: string | null;
  prompt: string;
  skills: GoatCodexChatSkillSnapshot[];
  clientMessageId: string | null;
  attachments: GoatChatMessageAttachment[];
  settings: GoatCodexChatTurnSettings;
  modelId: string;
  engine: GoatCodexChatEngine;
}): Promise<CodexChatMessageResult> {
  const chatSessionId = input.chatSessionId ?? `goat_chat_${randomUUID()}`;
  const codexChatSessionId = `goat_codex_chat_${randomUUID()}`;
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const userMessageId = safeClientMessageId(input.clientMessageId) ?? newGoatChatMessageId();
  const assistantMessageId = newGoatChatMessageId();
  const now = new Date();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const title = toGoatTaskTitle(input.prompt || input.attachments[0]?.filename || "Attachment");
  const engineModel =
    input.engine === "opencompany"
      ? input.modelId
      : input.engine === "claude_code"
        ? claudeCodeCliModelNameForModelId(input.modelId)
        : codexCliModelNameForModelId(input.modelId);
  if (!engineModel) throw new Error(`Unsupported ${input.engine} model: ${input.modelId}`);
  // Host tool contract version gates the sandboxed engines' dynamic tools: Codex reads it in
  // apps/runner/src/goat-codex-chat.ts, Claude Code in apps/runner/src/goat-claude-code-chat.ts.
  // Claude Code only wires the action-gateway tools today, not the brain tools. The opencompany
  // engine is not a sandboxed CLI session and has its own tool wiring, so it stays null here.
  const hostToolContractVersion =
    input.engine === "opencompany" ? null : GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION;

  await getDb().execute(sql`
    WITH created_chat AS (
      INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, created_at, updated_at)
      VALUES (
        ${chatSessionId},
        ${input.userWorkosId},
        ${title},
        ${input.modelId},
        ${input.engine},
        ${now},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_user_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, attachments, created_at, updated_at
      )
      VALUES (
        ${userMessageId},
        ${chatSessionId},
        'user',
        ${input.prompt},
        ${attachmentsJsonbValue(input.attachments)}::jsonb,
        ${now},
        ${now}
      )
      RETURNING id
    ),
    activated_skills AS (
      INSERT INTO goat.chat_session_skills (
        chat_session_id, skill_id, brain_ref, activated_message_id,
        name, description, instructions, created_at
      )
      SELECT
        ${chatSessionId}, skill.skill_id, skill.brain_ref, ${userMessageId},
        skill.name, skill.description, skill.instructions, ${now}
      FROM jsonb_to_recordset(${skillsJsonbValue(input.skills)}::jsonb) AS skill(
        skill_id text,
        brain_ref text,
        name text,
        description text,
        instructions text
      )
      ON CONFLICT (chat_session_id, skill_id) DO NOTHING
      RETURNING skill_id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      VALUES (
        ${assistantMessageId},
        ${chatSessionId},
        'assistant',
        '',
        ${JSON.stringify(emptyDurableAssistantDebugTrace(input.engine, engineModel))}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_codex_session AS (
      INSERT INTO goat.codex_chat_sessions (
        id, user_workos_id, chat_session_id, engine, model, brain_ref, workspace_id,
        host_tool_contract_version,
        active_turn_id, status, created_at, updated_at
      )
      VALUES (
        ${codexChatSessionId},
        ${input.userWorkosId},
        ${chatSessionId},
        ${input.engine},
        ${engineModel},
        ${input.brainRef},
        ${input.workspaceId},
        ${hostToolContractVersion},
        ${turnId},
        'queued',
        ${now},
        ${now}
      )
      RETURNING id
    )
    INSERT INTO goat.codex_chat_turns (
      id, user_workos_id, codex_chat_session_id, chat_session_id,
      user_message_id, assistant_message_id, status, prompt, settings, created_at, updated_at
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
      ${JSON.stringify(input.settings)}::jsonb,
      ${now},
      ${now}
    )
  `);

  return {
    ok: true,
    sessionId: chatSessionId,
    userMessageId,
    assistantMessageId,
    mode: "started",
    analytics: {
      isFirstMessage: true,
      engine: input.engine,
      model: input.modelId,
    },
  };
}

async function enqueueExistingCodexChatMessage(input: {
  userWorkosId: string;
  prompt: string;
  skills: GoatCodexChatSkillSnapshot[];
  clientMessageId: string | null;
  attachments: GoatChatMessageAttachment[];
  settings: GoatCodexChatTurnSettings;
  session: {
    id: string;
    chatSessionId: string;
    status: string;
    engine: GoatCodexChatEngine;
    model: string;
    chatModel: string;
  };
}): Promise<CodexChatMessageResult> {
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const userMessageId = safeClientMessageId(input.clientMessageId) ?? newGoatChatMessageId();
  const assistantMessageId = newGoatChatMessageId();
  const now = new Date();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const active =
    input.session.status === "queued" ||
    input.session.status === "starting" ||
    input.session.status === "running";

  await getDb().execute(sql`
    WITH cancelled_wakeups AS (
      UPDATE goat.codex_chat_turns
      SET status = 'interrupted',
          completed_at = ${now},
          updated_at = ${now}
      WHERE codex_chat_session_id = ${input.session.id}
        AND user_workos_id = ${input.userWorkosId}
        AND status = 'queued'
        AND run_after IS NOT NULL
      RETURNING assistant_message_id
    ),
    aborted_wakeup_messages AS (
      UPDATE goat.chat_messages AS message
      SET debug_trace = COALESCE(
            message.debug_trace,
            ${JSON.stringify(
              emptyDurableAssistantDebugTrace(input.session.engine, input.session.model),
            )}::jsonb
          ) || jsonb_build_object('aborted', true),
          updated_at = ${now}
      FROM cancelled_wakeups
      WHERE message.id = cancelled_wakeups.assistant_message_id
        AND message.role = 'assistant'
      RETURNING message.id
    ),
    inserted_user_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, attachments, created_at, updated_at
      )
      VALUES (
        ${userMessageId},
        ${input.session.chatSessionId},
        'user',
        ${input.prompt},
        ${attachmentsJsonbValue(input.attachments)}::jsonb,
        ${now},
        ${now}
      )
      RETURNING id
    ),
    activated_skills AS (
      INSERT INTO goat.chat_session_skills (
        chat_session_id, skill_id, brain_ref, activated_message_id,
        name, description, instructions, created_at
      )
      SELECT
        ${input.session.chatSessionId}, skill.skill_id, skill.brain_ref, ${userMessageId},
        skill.name, skill.description, skill.instructions, ${now}
      FROM jsonb_to_recordset(${skillsJsonbValue(input.skills)}::jsonb) AS skill(
        skill_id text,
        brain_ref text,
        name text,
        description text,
        instructions text
      )
      ON CONFLICT (chat_session_id, skill_id) DO NOTHING
      RETURNING skill_id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      VALUES (
        ${assistantMessageId},
        ${input.session.chatSessionId},
        'assistant',
        '',
        ${JSON.stringify(
          emptyDurableAssistantDebugTrace(input.session.engine, input.session.model),
        )}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_turn AS (
      INSERT INTO goat.codex_chat_turns (
        id, user_workos_id, codex_chat_session_id, chat_session_id,
        user_message_id, assistant_message_id, status, prompt, settings, created_at, updated_at
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
        ${JSON.stringify(input.settings)}::jsonb,
        ${now},
        ${now}
      )
      RETURNING id
    ),
    updated_codex_session AS (
      UPDATE goat.codex_chat_sessions AS session
      SET status = CASE
            WHEN session.status IN ('queued', 'starting', 'running') THEN session.status
            ELSE 'queued'
          END,
          active_turn_id = CASE
            WHEN session.status IN ('queued', 'starting', 'running') THEN session.active_turn_id
            ELSE ${turnId}
          END,
          error = NULL,
          updated_at = ${now}
      WHERE session.id = ${input.session.id}
        AND session.user_workos_id = ${input.userWorkosId}
      RETURNING session.id
    )
    UPDATE goat.chat_sessions
    SET updated_at = ${assistantCreatedAt}
    WHERE id = ${input.session.chatSessionId}
      AND user_workos_id = ${input.userWorkosId}
  `);
  if (input.session.engine === "claude_code") {
    // The first cancellation is atomic with the send. This second, idempotent pass catches a
    // wakeup that held the session lock and committed while this statement was waiting.
    await cancelQueuedCodexChatWakeups({
      userWorkosId: input.userWorkosId,
      codexChatSessionId: input.session.id,
      now: new Date(),
    });
  }

  return {
    ok: true,
    sessionId: input.session.chatSessionId,
    userMessageId,
    assistantMessageId,
    mode: active ? "queued" : "started",
    analytics: {
      isFirstMessage: false,
      engine: input.session.engine,
      model: input.session.chatModel,
    },
  };
}

async function cancelQueuedCodexChatWakeups(
  input: {
    userWorkosId: string;
    now: Date;
  } & (
    | { codexChatSessionId: string; chatSessionId?: never }
    | { chatSessionId: string; codexChatSessionId?: never }
  ),
) {
  const sessionPredicate = input.codexChatSessionId
    ? sql`codex_chat_session_id = ${input.codexChatSessionId}`
    : sql`chat_session_id = ${input.chatSessionId}`;
  await getDb().execute(sql`
    WITH cancelled_wakeups AS (
      UPDATE goat.codex_chat_turns
      SET status = 'interrupted',
          completed_at = ${input.now},
          updated_at = ${input.now}
      WHERE ${sessionPredicate}
        AND user_workos_id = ${input.userWorkosId}
        AND status = 'queued'
        AND run_after IS NOT NULL
      RETURNING assistant_message_id
    )
    UPDATE goat.chat_messages AS message
    SET debug_trace = COALESCE(
          message.debug_trace,
          jsonb_build_object('schemaVersion', ${CODEX_CHAT_DEBUG_SCHEMA_VERSION}::text)
        ) || jsonb_build_object('aborted', true),
        updated_at = ${input.now}
    FROM cancelled_wakeups
    WHERE message.id = cancelled_wakeups.assistant_message_id
      AND message.role = 'assistant'
  `);
}

function attachmentsJsonbValue(attachments: GoatChatMessageAttachment[]) {
  return attachments.length > 0 ? JSON.stringify(attachments) : null;
}

function skillsJsonbValue(skills: GoatCodexChatSkillSnapshot[]) {
  return JSON.stringify(
    skills.map((skill) => ({
      skill_id: skill.id,
      brain_ref: skill.brainRef,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    })),
  );
}

function emptyDurableAssistantDebugTrace(engine: GoatCodexChatEngine, model: string) {
  if (engine === "opencompany") {
    return {
      schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
      model,
      uiMessageParts: [],
    };
  }
  return emptyAssistantDebugTrace(model);
}

function safeClientMessageId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return trimmed;
}

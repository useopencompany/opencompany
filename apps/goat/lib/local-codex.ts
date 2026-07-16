import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  applyCodexEventToUiMessageParts,
  type CodexAppServerNormalizedEvent,
  type CodexUiMessagePart,
  finalizeCodexUiMessageParts,
  normalizeCodexAppServerEvent,
  parseCodexUiMessageParts,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import {
  type GoatChatMessageDebugTrace,
  type GoatCodexChatTurnSettings,
  type GoatLocalBridge,
  type GoatLocalCodexCommandKind,
  type GoatLocalCodexCommandStatus,
  type GoatLocalCodexSession,
  goatChatMessages,
  goatChatSessions,
  goatLocalBridges,
  goatLocalCodexCommands,
  goatLocalCodexEvents,
  goatLocalCodexSessions,
  goatLocalCodexTurns,
} from "@opencompany/db/goat-schema";
import { captureException } from "@opencompany/observability";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { newGoatChatMessageId } from "@/lib/chat";
import { nextGoatChatMessageCreatedAt } from "@/lib/chat-ui";
import { parseCodexChatSettings } from "@/lib/codex-chat-settings";
import { LOCAL_CODEX_DEFAULT_MODEL, LOCAL_CODEX_PICKER_VALUE } from "@/lib/local-codex-constants";
import { extractLocalRepositoryPath, hashLocalBridgeToken } from "@/lib/local-codex-utils";
import { toGoatTaskTitle } from "@/lib/task-display";

export {
  extractLocalRepositoryPath,
  hashLocalBridgeToken,
  LOCAL_CODEX_DEFAULT_MODEL,
  LOCAL_CODEX_PICKER_VALUE,
};

const LOCAL_CODEX_CHAT_MODEL: AgentModelId = "openai/gpt-5.5";
const LOCAL_BRIDGE_TOKEN_PREFIX = "oc_goat_local_";
const LOCAL_CODEX_PROMPT_MAX_LENGTH = 10_000;
const LOCAL_BRIDGE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const LOCAL_CODEX_COMMAND_CLAIM_TIMEOUT_MS = 30_000;

export type CreateLocalBridgeResult = {
  bridge: Pick<GoatLocalBridge, "id" | "name" | "tokenPrefix">;
  token: string;
  command: string;
};

export type LocalCodexMessageResult =
  | {
      ok: true;
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string | null;
      mode: "started" | "steered";
    }
  | { ok: false; status: number; error: string };

export type ClaimedLocalCodexCommand = {
  id: string;
  kind: GoatLocalCodexCommandKind;
  localCodexSessionId: string;
  localCodexTurnId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type LocalCodexCommandRow = {
  id: string;
  userWorkosId: string;
  localCodexSessionId: string;
  localCodexTurnId: string | null;
  bridgeId: string | null;
  claimedByBridgeId: string | null;
  kind: GoatLocalCodexCommandKind;
  status: GoatLocalCodexCommandStatus;
  payload: Record<string, unknown>;
  error: string | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type LocalCodexTurnRow = typeof goatLocalCodexTurns.$inferSelect;

export async function createLocalCodexBridgeForUser(input: {
  userWorkosId: string;
  name?: string | null;
  baseUrl?: string | null;
}): Promise<CreateLocalBridgeResult> {
  const token = `${LOCAL_BRIDGE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const [bridge] = await getDb()
    .insert(goatLocalBridges)
    .values({
      id: `goat_local_bridge_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      name: normalizeBridgeName(input.name),
      tokenHash: hashLocalBridgeToken(token),
      tokenPrefix: token.slice(0, LOCAL_BRIDGE_TOKEN_PREFIX.length + 6),
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: goatLocalBridges.id,
      name: goatLocalBridges.name,
      tokenPrefix: goatLocalBridges.tokenPrefix,
    });
  if (!bridge) throw new Error("Unable to create local Codex bridge.");

  const baseUrl = (input.baseUrl || "http://localhost:3002").replace(/\/+$/, "");
  return {
    bridge,
    token,
    command: `bun --filter @opencompany/goat-local-bridge start --base-url ${shellToken(baseUrl)} --token ${shellToken(token)}`,
  };
}

export async function authenticateLocalCodexBridgeToken(
  authorization: string | null | undefined,
): Promise<GoatLocalBridge | null> {
  const token = bearerToken(authorization);
  if (!token) return null;
  const tokenHash = hashLocalBridgeToken(token);
  const [bridge] = await getDb()
    .select()
    .from(goatLocalBridges)
    .where(and(eq(goatLocalBridges.tokenHash, tokenHash), isNull(goatLocalBridges.revokedAt)))
    .limit(1);
  if (!bridge) return null;
  if (!safeEqual(bridge.tokenHash, tokenHash)) return null;
  return bridge;
}

export async function heartbeatLocalCodexBridge(input: {
  bridge: GoatLocalBridge;
  name?: string | null;
}) {
  const now = new Date();
  await getDb()
    .update(goatLocalBridges)
    .set({
      ...(input.name ? { name: normalizeBridgeName(input.name) } : {}),
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(goatLocalBridges.id, input.bridge.id));
}

export async function createOrSteerLocalCodexMessage(input: {
  userWorkosId: string;
  sessionId?: string | null;
  prompt: string;
  clientMessageId?: string | null;
  settings?: unknown;
}): Promise<LocalCodexMessageResult> {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, status: 400, error: "Enter a message before sending." };
  if (prompt.length > LOCAL_CODEX_PROMPT_MAX_LENGTH) {
    return { ok: false, status: 400, error: "Messages can be at most 10,000 characters." };
  }
  const parsedSettings = parseCodexChatSettings(input.settings);
  if (!parsedSettings.ok) return { ok: false, status: 400, error: parsedSettings.error };
  const settings = parsedSettings.settings;

  const bridge = await loadActiveLocalCodexBridge(input.userWorkosId);
  if (!bridge) {
    return {
      ok: false,
      status: 409,
      error: "Start the local Codex bridge before using Local Codex.",
    };
  }

  if (input.sessionId) {
    const existing = await loadLocalCodexSessionForChat({
      userWorkosId: input.userWorkosId,
      chatSessionId: input.sessionId,
    });
    if (!existing) {
      return { ok: false, status: 404, error: "Local Codex session not found." };
    }
    return enqueueExistingLocalCodexMessage({
      userWorkosId: input.userWorkosId,
      prompt,
      ...(input.clientMessageId !== undefined ? { clientMessageId: input.clientMessageId } : {}),
      settings,
      bridge,
      localSession: existing,
    });
  }

  return createFirstLocalCodexTurn({
    userWorkosId: input.userWorkosId,
    prompt,
    repositoryPath: null,
    ...(input.clientMessageId !== undefined ? { clientMessageId: input.clientMessageId } : {}),
    settings,
    bridge,
  });
}

export async function interruptLocalCodexSessionForUser(input: {
  userWorkosId: string;
  chatSessionId: string;
}) {
  const localSession = await loadLocalCodexSessionForChat({
    userWorkosId: input.userWorkosId,
    chatSessionId: input.chatSessionId,
  });
  if (!localSession) return { ok: false, status: 404, error: "Local Codex session not found." };

  const bridge = await loadActiveLocalCodexBridge(input.userWorkosId);
  if (!bridge) return { ok: false, status: 409, error: "Local Codex bridge is not connected." };

  const turnId = localSession.activeTurnId;
  await enqueueLocalCodexCommand({
    userWorkosId: input.userWorkosId,
    localCodexSessionId: localSession.id,
    localCodexTurnId: turnId,
    bridgeId: bridge.id,
    kind: "interrupt",
    payload: {
      localCodexSessionId: localSession.id,
      ...(turnId ? { localCodexTurnId: turnId } : {}),
    },
  });
  return { ok: true, status: 202, error: null };
}

export async function claimLocalCodexCommandsForBridge(input: {
  bridge: GoatLocalBridge;
  limit?: number;
}): Promise<ClaimedLocalCodexCommand[]> {
  const now = new Date();
  const staleClaimedBefore = new Date(Date.now() - LOCAL_CODEX_COMMAND_CLAIM_TIMEOUT_MS);
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const result = await getDb().execute(sql`
    WITH candidate AS (
      SELECT id
      FROM goat.local_codex_commands
      WHERE user_workos_id = ${input.bridge.userWorkosId}
        AND (
          (
            status = 'queued'
            AND (bridge_id = ${input.bridge.id} OR bridge_id IS NULL)
          )
          OR (
            status = 'claimed'
            AND claimed_at < ${staleClaimedBefore}
            AND (
              bridge_id = ${input.bridge.id}
              OR claimed_by_bridge_id = ${input.bridge.id}
              OR bridge_id IS NULL
            )
          )
        )
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE goat.local_codex_commands AS command
    SET status = 'claimed',
        claimed_by_bridge_id = ${input.bridge.id},
        claimed_at = ${now},
        updated_at = ${now}
    FROM candidate
    WHERE command.id = candidate.id
    RETURNING
      command.id,
      command.user_workos_id AS "userWorkosId",
      command.local_codex_session_id AS "localCodexSessionId",
      command.local_codex_turn_id AS "localCodexTurnId",
      command.bridge_id AS "bridgeId",
      command.claimed_by_bridge_id AS "claimedByBridgeId",
      command.kind,
      command.status,
      command.payload,
      command.error,
      command.claimed_at AS "claimedAt",
      command.completed_at AS "completedAt",
      command.created_at AS "createdAt",
      command.updated_at AS "updatedAt"
  `);

  return rowsFromExecute<LocalCodexCommandRow>(result).map((command) => ({
    id: command.id,
    kind: command.kind,
    localCodexSessionId: command.localCodexSessionId,
    localCodexTurnId: command.localCodexTurnId,
    payload: command.payload,
    createdAt: isoTimestamp(command.createdAt),
  }));
}

export async function completeLocalCodexCommand(input: {
  bridge: GoatLocalBridge;
  commandId: string;
  status: Extract<GoatLocalCodexCommandStatus, "succeeded" | "failed">;
  error?: string | null;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
  worktreePath?: string | null;
}) {
  const now = new Date();
  const [command] = await getDb()
    .update(goatLocalCodexCommands)
    .set({
      status: input.status,
      error: input.error ?? null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatLocalCodexCommands.id, input.commandId),
        eq(goatLocalCodexCommands.userWorkosId, input.bridge.userWorkosId),
        eq(goatLocalCodexCommands.status, "claimed"),
        eq(goatLocalCodexCommands.claimedByBridgeId, input.bridge.id),
      ),
    )
    .returning();
  if (!command) return { ok: false, status: 404, error: "Command not found." };

  const sessionPatch: Partial<typeof goatLocalCodexSessions.$inferInsert> = {
    updatedAt: now,
  };
  if (input.codexThreadId) sessionPatch.codexThreadId = input.codexThreadId;
  if (input.worktreePath) sessionPatch.worktreePath = input.worktreePath;
  if (input.status === "failed") {
    sessionPatch.status = "failed";
    sessionPatch.error = input.error ?? "Local Codex command failed.";
  } else if (command.kind === "interrupt") {
    sessionPatch.activeTurnId = null;
    sessionPatch.status = "interrupted";
    sessionPatch.error = null;
  } else if (command.kind === "close") {
    sessionPatch.activeTurnId = null;
    sessionPatch.status = "closed";
    sessionPatch.error = null;
  }
  await getDb()
    .update(goatLocalCodexSessions)
    .set(sessionPatch)
    .where(
      and(
        eq(goatLocalCodexSessions.id, command.localCodexSessionId),
        eq(goatLocalCodexSessions.userWorkosId, input.bridge.userWorkosId),
      ),
    );

  if (command.localCodexTurnId) {
    const turn = await loadLocalCodexTurnForSession({
      userWorkosId: input.bridge.userWorkosId,
      localCodexSessionId: command.localCodexSessionId,
      turnId: command.localCodexTurnId,
    });
    if (!turn) return { ok: true, status: 200, error: null };

    const turnPatch: Partial<typeof goatLocalCodexTurns.$inferInsert> = { updatedAt: now };
    let assistantFinalization: {
      outcome: "failed" | "interrupted";
      error: string | null;
    } | null = null;
    if (input.codexTurnId) turnPatch.codexTurnId = input.codexTurnId;
    if (input.status === "failed") {
      turnPatch.status = "failed";
      turnPatch.error = input.error ?? "Local Codex command failed.";
      turnPatch.completedAt = now;
      assistantFinalization = { outcome: "failed", error: turnPatch.error };
    } else if (command.kind === "interrupt" || command.kind === "close") {
      turnPatch.status = "interrupted";
      turnPatch.error = null;
      turnPatch.completedAt = now;
      assistantFinalization = { outcome: "interrupted", error: null };
    }
    await getDb()
      .update(goatLocalCodexTurns)
      .set(turnPatch)
      .where(
        and(
          eq(goatLocalCodexTurns.id, command.localCodexTurnId),
          eq(goatLocalCodexTurns.userWorkosId, input.bridge.userWorkosId),
          eq(goatLocalCodexTurns.localCodexSessionId, command.localCodexSessionId),
        ),
      );
    if (assistantFinalization) {
      await finalizeAssistantMessageParts({
        assistantMessageId: turn.assistantMessageId,
        outcome: assistantFinalization.outcome,
        error: assistantFinalization.error,
        durationMs: elapsedTurnDurationMs(turn.createdAt, now),
        now,
      });
    }
  }

  return { ok: true, status: 200, error: null };
}

export async function recordLocalCodexBridgeEvents(input: {
  bridge: GoatLocalBridge;
  localCodexSessionId: string;
  localCodexTurnId?: string | null;
  commandId?: string | null;
  events: Record<string, unknown>[];
}) {
  const localSession = await loadLocalCodexSessionForBridge({
    bridge: input.bridge,
    localCodexSessionId: input.localCodexSessionId,
  });
  if (!localSession) return { ok: false, status: 404, error: "Local Codex session not found." };

  const command = input.commandId
    ? await loadLocalCodexCommandForBridgeSession({
        bridge: input.bridge,
        localCodexSessionId: localSession.id,
        commandId: input.commandId,
      })
    : null;
  if (input.commandId && !command) {
    return { ok: false, status: 404, error: "Local Codex command not found." };
  }

  const localTurn = await resolveLocalCodexTurnForEvent({
    userWorkosId: input.bridge.userWorkosId,
    localSession,
    localCodexTurnId: input.localCodexTurnId ?? null,
  });
  if (!localTurn.ok) return localTurn;

  const normalized = input.events.flatMap(normalizeCodexAppServerEvent);
  const auditFailureState = { reported: false };
  for (const event of normalized) {
    await persistLocalCodexEvent({
      bridge: input.bridge,
      localSession,
      localTurn: localTurn.turn,
      commandId: command?.id ?? null,
      event,
      auditFailureState,
    });
  }
  return { ok: true, status: 202, error: null };
}

function normalizeBridgeName(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 80) : "Local Codex bridge";
}

function bearerToken(value: string | null | undefined) {
  const match = /^Bearer\s+(.+)$/i.exec(value?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function shellToken(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function loadActiveLocalCodexBridge(userWorkosId: string) {
  const activeAfter = new Date(Date.now() - LOCAL_BRIDGE_ACTIVE_WINDOW_MS);
  const [bridge] = await getDb()
    .select()
    .from(goatLocalBridges)
    .where(
      and(
        eq(goatLocalBridges.userWorkosId, userWorkosId),
        isNull(goatLocalBridges.revokedAt),
        gt(goatLocalBridges.lastSeenAt, activeAfter),
      ),
    )
    .orderBy(desc(goatLocalBridges.lastSeenAt), desc(goatLocalBridges.createdAt))
    .limit(1);
  return bridge ?? null;
}

async function loadLocalCodexSessionForChat(input: {
  userWorkosId: string;
  chatSessionId: string;
}) {
  const [session] = await getDb()
    .select()
    .from(goatLocalCodexSessions)
    .innerJoin(goatChatSessions, eq(goatChatSessions.id, goatLocalCodexSessions.chatSessionId))
    .where(
      and(
        eq(goatLocalCodexSessions.userWorkosId, input.userWorkosId),
        eq(goatLocalCodexSessions.chatSessionId, input.chatSessionId),
        isNull(goatChatSessions.closedAt),
      ),
    )
    .limit(1);
  return session?.local_codex_sessions ?? null;
}

async function loadLocalCodexSessionForBridge(input: {
  bridge: GoatLocalBridge;
  localCodexSessionId: string;
}) {
  const [session] = await getDb()
    .select()
    .from(goatLocalCodexSessions)
    .where(
      and(
        eq(goatLocalCodexSessions.id, input.localCodexSessionId),
        eq(goatLocalCodexSessions.userWorkosId, input.bridge.userWorkosId),
        or(
          eq(goatLocalCodexSessions.bridgeId, input.bridge.id),
          isNull(goatLocalCodexSessions.bridgeId),
        ),
      ),
    )
    .limit(1);
  return session ?? null;
}

async function loadLocalCodexCommandForBridgeSession(input: {
  bridge: GoatLocalBridge;
  localCodexSessionId: string;
  commandId: string;
}) {
  const [command] = await getDb()
    .select()
    .from(goatLocalCodexCommands)
    .where(
      and(
        eq(goatLocalCodexCommands.id, input.commandId),
        eq(goatLocalCodexCommands.userWorkosId, input.bridge.userWorkosId),
        eq(goatLocalCodexCommands.localCodexSessionId, input.localCodexSessionId),
        or(
          eq(goatLocalCodexCommands.bridgeId, input.bridge.id),
          eq(goatLocalCodexCommands.claimedByBridgeId, input.bridge.id),
          isNull(goatLocalCodexCommands.bridgeId),
        ),
      ),
    )
    .limit(1);
  return command ?? null;
}

async function createFirstLocalCodexTurn(input: {
  userWorkosId: string;
  prompt: string;
  repositoryPath: string | null;
  clientMessageId?: string | null;
  settings: GoatCodexChatTurnSettings;
  bridge: GoatLocalBridge;
}): Promise<LocalCodexMessageResult> {
  const chatSessionId = `goat_chat_${randomUUID()}`;
  const localCodexSessionId = `goat_local_codex_${randomUUID()}`;
  const turnId = `goat_local_codex_turn_${randomUUID()}`;
  const commandId = `goat_local_codex_cmd_${randomUUID()}`;
  const userMessageId = safeClientMessageId(input.clientMessageId) ?? newGoatChatMessageId();
  const assistantMessageId = newGoatChatMessageId();
  const now = new Date();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const title = toGoatTaskTitle(input.prompt);

  await getDb().execute(sql`
    WITH created_chat AS (
      INSERT INTO goat.chat_sessions (
        id,
        user_workos_id,
        title,
        model,
        engine,
        created_at,
        updated_at
      )
      VALUES (
        ${chatSessionId},
        ${input.userWorkosId},
        ${title},
        ${LOCAL_CODEX_CHAT_MODEL},
        'local_codex',
        ${now},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_user_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        created_at,
        updated_at
      )
      VALUES (${userMessageId}, ${chatSessionId}, 'user', ${input.prompt}, ${now}, ${now})
      RETURNING id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        debug_trace,
        created_at,
        updated_at
      )
      VALUES (
        ${assistantMessageId},
        ${chatSessionId},
        'assistant',
        '',
        ${JSON.stringify({ schemaVersion: "goat.local_codex.debug.v1", model: LOCAL_CODEX_DEFAULT_MODEL })}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_local_session AS (
      INSERT INTO goat.local_codex_sessions (
        id,
        user_workos_id,
        chat_session_id,
        bridge_id,
        repository_path,
        model,
        active_turn_id,
        status,
        created_at,
        updated_at
      )
      VALUES (
        ${localCodexSessionId},
        ${input.userWorkosId},
        ${chatSessionId},
        ${input.bridge.id},
        ${input.repositoryPath},
        ${LOCAL_CODEX_DEFAULT_MODEL},
        ${turnId},
        'starting',
        ${now},
        ${now}
      )
      RETURNING id
    ),
    inserted_turn AS (
      INSERT INTO goat.local_codex_turns (
        id,
        user_workos_id,
        local_codex_session_id,
        user_message_id,
        assistant_message_id,
        status,
        prompt,
        settings,
        created_at,
        updated_at
      )
      VALUES (
        ${turnId},
        ${input.userWorkosId},
        ${localCodexSessionId},
        ${userMessageId},
        ${assistantMessageId},
        'queued',
        ${input.prompt},
        ${JSON.stringify(input.settings)}::jsonb,
        ${now},
        ${now}
      )
      RETURNING id
    )
    INSERT INTO goat.local_codex_commands (
      id,
      user_workos_id,
      local_codex_session_id,
      local_codex_turn_id,
      bridge_id,
      kind,
      status,
      payload,
      created_at,
      updated_at
    )
    SELECT
      ${commandId},
      ${input.userWorkosId},
      ${localCodexSessionId},
      ${turnId},
      ${input.bridge.id},
      'start_turn',
      'queued',
      ${JSON.stringify({
        prompt: input.prompt,
        repositoryPath: input.repositoryPath,
        model: LOCAL_CODEX_DEFAULT_MODEL,
        settings: input.settings,
      })}::jsonb,
      ${now},
      ${now}
    WHERE EXISTS (SELECT 1 FROM created_chat)
      AND EXISTS (SELECT 1 FROM inserted_user_message)
      AND EXISTS (SELECT 1 FROM inserted_assistant_message)
      AND EXISTS (SELECT 1 FROM inserted_local_session)
      AND EXISTS (SELECT 1 FROM inserted_turn)
  `);

  return {
    ok: true,
    sessionId: chatSessionId,
    userMessageId,
    assistantMessageId,
    mode: "started",
  };
}

async function enqueueExistingLocalCodexMessage(input: {
  userWorkosId: string;
  prompt: string;
  clientMessageId?: string | null;
  settings: GoatCodexChatTurnSettings;
  bridge: GoatLocalBridge;
  localSession: GoatLocalCodexSession;
}): Promise<LocalCodexMessageResult> {
  const now = new Date();
  const userMessageId = safeClientMessageId(input.clientMessageId) ?? newGoatChatMessageId();
  const running = input.localSession.status === "running" && input.localSession.activeTurnId;

  if (running) {
    await getDb().execute(sql`
      WITH inserted_user_message AS (
        INSERT INTO goat.chat_messages (
          id,
          session_id,
          role,
          content,
          created_at,
          updated_at
        )
        VALUES (
          ${userMessageId},
          ${input.localSession.chatSessionId},
          'user',
          ${input.prompt},
          ${now},
          ${now}
        )
        RETURNING id
      ),
      touched_chat AS (
        UPDATE goat.chat_sessions
        SET updated_at = ${now}
        WHERE id = ${input.localSession.chatSessionId}
        RETURNING id
      )
      INSERT INTO goat.local_codex_commands (
        id,
        user_workos_id,
        local_codex_session_id,
        local_codex_turn_id,
        bridge_id,
        kind,
        status,
        payload,
        created_at,
        updated_at
      )
      SELECT
        ${`goat_local_codex_cmd_${randomUUID()}`},
        ${input.userWorkosId},
        ${input.localSession.id},
        ${input.localSession.activeTurnId},
        ${input.bridge.id},
        'steer',
        'queued',
        ${JSON.stringify({ prompt: input.prompt, settings: input.settings })}::jsonb,
        ${now},
        ${now}
      WHERE EXISTS (SELECT 1 FROM inserted_user_message)
        AND EXISTS (SELECT 1 FROM touched_chat)
    `);
    return {
      ok: true,
      sessionId: input.localSession.chatSessionId,
      userMessageId,
      assistantMessageId: null,
      mode: "steered",
    };
  }

  const turnId = `goat_local_codex_turn_${randomUUID()}`;
  const assistantMessageId = newGoatChatMessageId();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  await getDb().execute(sql`
    WITH inserted_user_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        created_at,
        updated_at
      )
      VALUES (
        ${userMessageId},
        ${input.localSession.chatSessionId},
        'user',
        ${input.prompt},
        ${now},
        ${now}
      )
      RETURNING id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        debug_trace,
        created_at,
        updated_at
      )
      VALUES (
        ${assistantMessageId},
        ${input.localSession.chatSessionId},
        'assistant',
        '',
        ${JSON.stringify({ schemaVersion: "goat.local_codex.debug.v1", model: input.localSession.model })}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      )
      RETURNING id
    ),
    inserted_turn AS (
      INSERT INTO goat.local_codex_turns (
        id,
        user_workos_id,
        local_codex_session_id,
        user_message_id,
        assistant_message_id,
        status,
        prompt,
        settings,
        created_at,
        updated_at
      )
      VALUES (
        ${turnId},
        ${input.userWorkosId},
        ${input.localSession.id},
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
    updated_session AS (
      UPDATE goat.local_codex_sessions
      SET bridge_id = ${input.bridge.id},
          active_turn_id = ${turnId},
          status = 'starting',
          error = NULL,
          updated_at = ${now}
      WHERE id = ${input.localSession.id}
      RETURNING id
    ),
    touched_chat AS (
      UPDATE goat.chat_sessions
      SET updated_at = ${assistantCreatedAt}
      WHERE id = ${input.localSession.chatSessionId}
      RETURNING id
    )
    INSERT INTO goat.local_codex_commands (
      id,
      user_workos_id,
      local_codex_session_id,
      local_codex_turn_id,
      bridge_id,
      kind,
      status,
      payload,
      created_at,
      updated_at
    )
    SELECT
      ${`goat_local_codex_cmd_${randomUUID()}`},
      ${input.userWorkosId},
      ${input.localSession.id},
      ${turnId},
      ${input.bridge.id},
      'start_turn',
      'queued',
      ${JSON.stringify({
        prompt: input.prompt,
        repositoryPath: input.localSession.repositoryPath,
        model: input.localSession.model,
        codexThreadId: input.localSession.codexThreadId,
        worktreePath: input.localSession.worktreePath,
        settings: input.settings,
      })}::jsonb,
      ${now},
      ${now}
    WHERE EXISTS (SELECT 1 FROM inserted_user_message)
      AND EXISTS (SELECT 1 FROM inserted_assistant_message)
      AND EXISTS (SELECT 1 FROM inserted_turn)
      AND EXISTS (SELECT 1 FROM updated_session)
      AND EXISTS (SELECT 1 FROM touched_chat)
  `);

  return {
    ok: true,
    sessionId: input.localSession.chatSessionId,
    userMessageId,
    assistantMessageId,
    mode: "started",
  };
}

async function enqueueLocalCodexCommand(input: {
  userWorkosId: string;
  localCodexSessionId: string;
  localCodexTurnId?: string | null;
  bridgeId: string;
  kind: GoatLocalCodexCommandKind;
  payload: Record<string, unknown>;
}) {
  const now = new Date();
  await getDb()
    .insert(goatLocalCodexCommands)
    .values({
      id: `goat_local_codex_cmd_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      localCodexSessionId: input.localCodexSessionId,
      localCodexTurnId: input.localCodexTurnId ?? null,
      bridgeId: input.bridgeId,
      kind: input.kind,
      status: "queued",
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    });
}

async function persistLocalCodexEvent(input: {
  bridge: GoatLocalBridge;
  localSession: GoatLocalCodexSession;
  localTurn?: LocalCodexTurnRow | null;
  commandId?: string | null;
  event: CodexAppServerNormalizedEvent;
  auditFailureState: { reported: boolean };
}) {
  const now = new Date();
  try {
    await getDb()
      .insert(goatLocalCodexEvents)
      .values({
        userWorkosId: input.bridge.userWorkosId,
        localCodexSessionId: input.localSession.id,
        localCodexTurnId: input.localTurn?.id ?? null,
        bridgeId: input.bridge.id,
        commandId: input.commandId ?? null,
        type: input.event.type,
        payload: input.event.payload,
        rawEvent: input.event.rawEvent,
        createdAt: now,
      });
  } catch (error) {
    // A bridge request can contain thousands of deltas. One sanitized report
    // is enough to alert us without creating an observability storm.
    if (!input.auditFailureState.reported) {
      input.auditFailureState.reported = true;
      const persistenceError = new Error("Local Codex audit event persistence failed.");
      persistenceError.name = "LocalCodexEventPersistenceError";
      captureException(persistenceError, {
        event: "opencompany.goat_local_codex_event_persist_failed",
        local_codex_session_id: input.localSession.id,
        local_codex_turn_id: input.localTurn?.id,
        event_type: input.event.type,
        original_error_name: error instanceof Error ? error.name : typeof error,
        original_error_code: databaseErrorCode(error),
      });
    }
  }

  if (input.localTurn) {
    await applyLocalCodexEventToChat({
      localSession: input.localSession,
      turn: input.localTurn,
      event: input.event,
      now,
    });
  }
}

async function applyLocalCodexEventToChat(input: {
  localSession: GoatLocalCodexSession;
  turn: LocalCodexTurnRow;
  event: CodexAppServerNormalizedEvent;
  now: Date;
}) {
  if (input.event.type === "assistant.delta") {
    return;
  }

  await projectEventIntoAssistantMessage({
    assistantMessageId: input.turn.assistantMessageId,
    model: input.localSession.model,
    event: input.event,
    now: input.now,
  });

  if (input.event.type === "turn.started") {
    const codexTurnId = stringPayload(input.event.payload.turnId);
    await getDb()
      .update(goatLocalCodexTurns)
      .set({
        ...(codexTurnId ? { codexTurnId } : {}),
        status: "running",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(goatLocalCodexTurns.id, input.turn.id),
          eq(goatLocalCodexTurns.userWorkosId, input.localSession.userWorkosId),
          eq(goatLocalCodexTurns.localCodexSessionId, input.localSession.id),
        ),
      );
    await getDb()
      .update(goatLocalCodexSessions)
      .set({
        activeTurnId: input.turn.id,
        status: "running",
        error: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(goatLocalCodexSessions.id, input.localSession.id),
          eq(goatLocalCodexSessions.userWorkosId, input.localSession.userWorkosId),
        ),
      );
    return;
  }

  if (input.event.type === "turn.completed") {
    const rawStatus = stringPayload(input.event.payload.status);
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "interrupted"
          ? "interrupted"
          : "failed";
    const error = stringPayload(input.event.payload.error);
    await getDb()
      .update(goatLocalCodexTurns)
      .set({
        status,
        error: error || null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(goatLocalCodexTurns.id, input.turn.id),
          eq(goatLocalCodexTurns.userWorkosId, input.localSession.userWorkosId),
          eq(goatLocalCodexTurns.localCodexSessionId, input.localSession.id),
        ),
      );
    await getDb()
      .update(goatLocalCodexSessions)
      .set({
        activeTurnId: null,
        status: status === "completed" ? "idle" : status,
        error: error || null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(goatLocalCodexSessions.id, input.localSession.id),
          eq(goatLocalCodexSessions.userWorkosId, input.localSession.userWorkosId),
        ),
      );
    await getDb()
      .update(goatChatSessions)
      .set({ updatedAt: input.now })
      .where(
        and(
          eq(goatChatSessions.id, input.localSession.chatSessionId),
          eq(goatChatSessions.userWorkosId, input.localSession.userWorkosId),
        ),
      );
    if (status !== "completed") {
      await finalizeAssistantMessageParts({
        assistantMessageId: input.turn.assistantMessageId,
        model: input.localSession.model,
        outcome: status,
        error: error || null,
        durationMs: elapsedTurnDurationMs(input.turn.createdAt, input.now),
        now: input.now,
      });
    } else {
      await writeAssistantMessageDuration({
        assistantMessageId: input.turn.assistantMessageId,
        durationMs: elapsedTurnDurationMs(input.turn.createdAt, input.now),
        now: input.now,
      });
    }
  }
}

async function resolveLocalCodexTurnForEvent(input: {
  userWorkosId: string;
  localSession: GoatLocalCodexSession;
  localCodexTurnId?: string | null;
}): Promise<
  { ok: true; turn: LocalCodexTurnRow | null } | { ok: false; status: 404; error: string }
> {
  const turnId = input.localCodexTurnId ?? input.localSession.activeTurnId;
  if (!turnId) return { ok: true, turn: null };

  const turn = await loadLocalCodexTurnForSession({
    userWorkosId: input.userWorkosId,
    localCodexSessionId: input.localSession.id,
    turnId,
  });
  if (!turn) return { ok: false, status: 404, error: "Local Codex turn not found." };

  return { ok: true, turn };
}

async function loadLocalCodexTurnForSession(input: {
  userWorkosId: string;
  localCodexSessionId: string;
  turnId: string;
}) {
  const [turn] = await getDb()
    .select()
    .from(goatLocalCodexTurns)
    .where(
      and(
        eq(goatLocalCodexTurns.id, input.turnId),
        eq(goatLocalCodexTurns.userWorkosId, input.userWorkosId),
        eq(goatLocalCodexTurns.localCodexSessionId, input.localCodexSessionId),
      ),
    )
    .limit(1);
  return turn ?? null;
}

async function loadAssistantMessageForProjection(assistantMessageId: string) {
  const [message] = await getDb()
    .select({ content: goatChatMessages.content, debugTrace: goatChatMessages.debugTrace })
    .from(goatChatMessages)
    .where(and(eq(goatChatMessages.id, assistantMessageId), eq(goatChatMessages.role, "assistant")))
    .limit(1);
  return message ?? null;
}

async function projectEventIntoAssistantMessage(input: {
  assistantMessageId: string;
  model: string;
  event: CodexAppServerNormalizedEvent;
  now: Date;
}) {
  const message = await loadAssistantMessageForProjection(input.assistantMessageId);
  if (!message) return;
  const parts = assistantProjectionParts(message);
  const projection = applyCodexEventToUiMessageParts(parts, input.event);
  if (!projection.changed) return;
  await writeAssistantMessageProjection({
    assistantMessageId: input.assistantMessageId,
    existingTrace: message.debugTrace,
    model: input.model,
    parts: projection.parts,
    content: projection.content,
    error: projection.error,
    now: input.now,
  });
}

async function finalizeAssistantMessageParts(input: {
  assistantMessageId: string;
  model?: string | null;
  outcome: "failed" | "interrupted";
  error: string | null;
  durationMs?: number;
  now: Date;
}) {
  const message = await loadAssistantMessageForProjection(input.assistantMessageId);
  if (!message) return;
  const parts = assistantProjectionParts(message);
  const projection = finalizeCodexUiMessageParts(parts, input.outcome, input.error);
  // Always write: even without dangling command parts the error/aborted metadata must land.
  await writeAssistantMessageProjection({
    assistantMessageId: input.assistantMessageId,
    existingTrace: message.debugTrace,
    model: input.model ?? null,
    parts: projection.parts,
    content: projection.content,
    error: input.outcome === "failed" ? (input.error ?? "Local Codex turn failed.") : null,
    aborted: input.outcome === "interrupted",
    durationMs: input.durationMs,
    now: input.now,
  });
}

async function writeAssistantMessageDuration(input: {
  assistantMessageId: string;
  durationMs?: number;
  now: Date;
}) {
  if (typeof input.durationMs !== "number") return;
  const message = await loadAssistantMessageForProjection(input.assistantMessageId);
  if (!message) return;
  await writeAssistantMessageProjection({
    assistantMessageId: input.assistantMessageId,
    existingTrace: message.debugTrace,
    parts: assistantProjectionParts(message),
    content: message.content,
    durationMs: input.durationMs,
    now: input.now,
  });
}

async function writeAssistantMessageProjection(input: {
  assistantMessageId: string;
  existingTrace: GoatChatMessageDebugTrace | null;
  model?: string | null;
  parts: unknown[];
  content: string;
  error?: string | null;
  aborted?: boolean;
  durationMs?: number | undefined;
  now: Date;
}) {
  const debugTrace: GoatChatMessageDebugTrace = {
    ...(input.existingTrace ?? {}),
    schemaVersion: "goat.local_codex.debug.v2",
    model: input.model ?? input.existingTrace?.model ?? LOCAL_CODEX_DEFAULT_MODEL,
    uiMessageParts: input.parts,
  };
  if (input.error !== undefined) {
    if (input.error) debugTrace.error = input.error;
    else delete debugTrace.error;
  }
  if (input.aborted !== undefined) {
    if (input.aborted) debugTrace.aborted = true;
    else delete debugTrace.aborted;
  }
  if (typeof input.durationMs === "number") {
    debugTrace.durationMs = input.durationMs;
  }
  await getDb()
    .update(goatChatMessages)
    .set({ content: input.content, debugTrace, updatedAt: input.now })
    .where(
      and(
        eq(goatChatMessages.id, input.assistantMessageId),
        eq(goatChatMessages.role, "assistant"),
      ),
    );
}

function assistantProjectionParts(message: {
  content: string;
  debugTrace: GoatChatMessageDebugTrace | null;
}): CodexUiMessagePart[] {
  const parts = parseCodexUiMessageParts(message.debugTrace?.uiMessageParts);
  if (parts.length > 0) return parts;
  return message.content.trim() ? [{ type: "text", text: message.content }] : [];
}

function stringPayload(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function elapsedTurnDurationMs(startedAt: Date, completedAt: Date) {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function safeClientMessageId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return trimmed;
}

function isoTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

type ExecuteResultRow = Record<string, unknown>;

function rowsFromExecute<T extends ExecuteResultRow>(result: unknown): T[] {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

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

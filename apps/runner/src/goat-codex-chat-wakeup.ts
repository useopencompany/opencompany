import { randomUUID } from "node:crypto";
import type { GoatCodexChatTurn, GoatCodexChatTurnSettings } from "@opencompany/db/goat-schema";
import {
  emptyAssistantDebugTrace,
  nextGoatChatMessageCreatedAt,
} from "@opencompany/goat-agent/chat-ui";
import { createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { rowsFromExecute } from "./sql-exec";

export const GOAT_CODEX_CHAT_WAKEUP_MIN_DELAY_SECONDS = 60;
export const GOAT_CODEX_CHAT_WAKEUP_MAX_DELAY_SECONDS = 3_600;
export const GOAT_CODEX_CHAT_WAKEUP_MAX_CHAIN = 5;

export type GoatCodexChatScheduledWakeup = {
  delaySeconds: number;
  reason: string;
  prompt: string;
};

export type PreparedGoatCodexChatScheduledWakeup = {
  dueAt: Date;
  prompt: string;
  settings: GoatCodexChatTurnSettings;
  userDebugTrace: {
    scheduledWakeup: {
      reason: string;
      dueAt: string;
    };
  };
  userMessageContent: string;
  wakeupChain: number;
};

type WakeupParentTurn = Pick<
  GoatCodexChatTurn,
  "id" | "userWorkosId" | "codexChatSessionId" | "chatSessionId" | "createdAt" | "settings"
>;

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-codex-chat-wakeup",
});

export async function enqueueGoatCodexChatWakeup(input: {
  parentTurn: WakeupParentTurn;
  model: string;
  wakeup: GoatCodexChatScheduledWakeup;
  now?: Date;
}): Promise<"enqueued" | "chain_capped" | "superseded"> {
  const prepared = prepareGoatCodexChatScheduledWakeup({
    parentSettings: input.parentTurn.settings,
    wakeup: input.wakeup,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!prepared) {
    logger.info("Claude Code scheduled wakeup chain reached its cap", {
      event: "opencompany.goat_claude_chat_wakeup_chain_capped",
      turn_id: input.parentTurn.id,
      codex_chat_session_id: input.parentTurn.codexChatSessionId,
      wakeup_chain: validWakeupChain(input.parentTurn.settings) + 1,
    });
    return "chain_capped";
  }

  const now = input.now ?? new Date();
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const userMessageId = `goat_chat_msg_${randomUUID()}`;
  const assistantMessageId = `goat_chat_msg_${randomUUID()}`;
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;

  const result = await getDb().execute(sql`
    WITH eligible_session AS MATERIALIZED (
      SELECT engine_session.id
      FROM goat.codex_chat_sessions AS engine_session
      INNER JOIN goat.chat_sessions AS chat_session
        ON chat_session.id = engine_session.chat_session_id
      WHERE engine_session.id = ${input.parentTurn.codexChatSessionId}
        AND engine_session.user_workos_id = ${input.parentTurn.userWorkosId}
        AND engine_session.chat_session_id = ${input.parentTurn.chatSessionId}
        AND engine_session.status = 'idle'
        AND chat_session.kind = 'chat'
        AND chat_session.closed_at IS NULL
      FOR UPDATE OF engine_session, chat_session
    ),
    eligible_parent AS (
      SELECT parent.id
      FROM goat.codex_chat_turns AS parent
      WHERE parent.id = ${input.parentTurn.id}
        AND parent.user_workos_id = ${input.parentTurn.userWorkosId}
        AND parent.codex_chat_session_id = ${input.parentTurn.codexChatSessionId}
        AND parent.chat_session_id = ${input.parentTurn.chatSessionId}
        AND parent.status = 'completed'
        AND EXISTS (SELECT 1 FROM eligible_session)
        AND NOT EXISTS (
          SELECT 1
          FROM goat.codex_chat_turns AS sibling
          WHERE sibling.codex_chat_session_id = parent.codex_chat_session_id
            AND sibling.created_at > parent.created_at
            AND sibling.status IN ('queued', 'running')
        )
    ),
    inserted_user_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, debug_trace, created_at, updated_at
      )
      SELECT
        ${userMessageId},
        ${input.parentTurn.chatSessionId},
        'user',
        ${prepared.userMessageContent},
        ${JSON.stringify(prepared.userDebugTrace)}::jsonb,
        ${now},
        ${now}
      FROM eligible_parent
      RETURNING id
    ),
    inserted_assistant_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, debug_trace, created_at, updated_at
      )
      SELECT
        ${assistantMessageId},
        ${input.parentTurn.chatSessionId},
        'assistant',
        '',
        ${JSON.stringify(emptyAssistantDebugTrace(input.model))}::jsonb,
        ${assistantCreatedAt},
        ${assistantCreatedAt}
      FROM eligible_parent
      RETURNING id
    ),
    inserted_turn AS (
      INSERT INTO goat.codex_chat_turns (
        id, user_workos_id, codex_chat_session_id, chat_session_id,
        user_message_id, assistant_message_id, status, prompt, settings,
        run_after, created_at, updated_at
      )
      SELECT
        ${turnId},
        ${input.parentTurn.userWorkosId},
        ${input.parentTurn.codexChatSessionId},
        ${input.parentTurn.chatSessionId},
        inserted_user_message.id,
        inserted_assistant_message.id,
        'queued',
        ${prepared.prompt},
        ${JSON.stringify(prepared.settings)}::jsonb,
        ${prepared.dueAt},
        ${now},
        ${now}
      FROM eligible_parent
      INNER JOIN inserted_user_message ON true
      INNER JOIN inserted_assistant_message ON true
      RETURNING id
    )
    SELECT id FROM inserted_turn
  `);

  return rowsFromExecute<{ id: string }>(result).length > 0 ? "enqueued" : "superseded";
}

export function prepareGoatCodexChatScheduledWakeup(input: {
  parentSettings: GoatCodexChatTurnSettings;
  wakeup: GoatCodexChatScheduledWakeup;
  now?: Date;
}): PreparedGoatCodexChatScheduledWakeup | null {
  const wakeupChain = validWakeupChain(input.parentSettings) + 1;
  if (wakeupChain > GOAT_CODEX_CHAT_WAKEUP_MAX_CHAIN) return null;

  const now = input.now ?? new Date();
  const delaySeconds = Math.min(
    GOAT_CODEX_CHAT_WAKEUP_MAX_DELAY_SECONDS,
    Math.max(GOAT_CODEX_CHAT_WAKEUP_MIN_DELAY_SECONDS, input.wakeup.delaySeconds),
  );
  const dueAt = new Date(now.getTime() + delaySeconds * 1_000);
  const reason = input.wakeup.reason.trim();
  const settings: GoatCodexChatTurnSettings = {
    ...input.parentSettings,
    wakeupChain,
  };
  delete settings.scheduledWakeup;

  return {
    dueAt,
    prompt: buildScheduledWakeupPrompt({
      reason,
      prompt: input.wakeup.prompt.trim(),
    }),
    settings,
    userDebugTrace: {
      scheduledWakeup: {
        reason,
        dueAt: dueAt.toISOString(),
      },
    },
    userMessageContent: `Scheduled check-in: ${reason}`,
    wakeupChain,
  };
}

export async function persistGoatCodexChatScheduledWakeup(input: {
  turnId: string;
  userWorkosId: string;
  codexChatSessionId: string;
  leaseId: string;
  leaseOwner: string;
  wakeup: GoatCodexChatScheduledWakeup;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const result = await getDb().execute(sql`
    UPDATE goat.codex_chat_turns
    SET settings = jsonb_set(
          settings,
          '{scheduledWakeup}',
          ${JSON.stringify(input.wakeup)}::jsonb,
          true
        ),
        updated_at = ${now}
    WHERE id = ${input.turnId}
      AND user_workos_id = ${input.userWorkosId}
      AND codex_chat_session_id = ${input.codexChatSessionId}
      AND lease_id = ${input.leaseId}
      AND lease_owner = ${input.leaseOwner}
      AND status = 'running'
    RETURNING id
  `);
  if (rowsFromExecute(result).length === 0) throw new GoatCodexChatLeaseLostError();
}

export function scheduledWakeupFromTurnSettings(
  settings: GoatCodexChatTurnSettings,
): GoatCodexChatScheduledWakeup | null {
  const wakeup = settings.scheduledWakeup;
  if (
    !wakeup ||
    typeof wakeup.delaySeconds !== "number" ||
    !Number.isFinite(wakeup.delaySeconds) ||
    wakeup.delaySeconds <= 0 ||
    typeof wakeup.reason !== "string" ||
    !wakeup.reason.trim() ||
    typeof wakeup.prompt !== "string"
  ) {
    return null;
  }
  return {
    delaySeconds: Math.min(
      GOAT_CODEX_CHAT_WAKEUP_MAX_DELAY_SECONDS,
      Math.max(GOAT_CODEX_CHAT_WAKEUP_MIN_DELAY_SECONDS, Math.round(wakeup.delaySeconds)),
    ),
    reason: wakeup.reason.trim().slice(0, 500),
    prompt: wakeup.prompt.trim().slice(0, 10_000),
  };
}

function validWakeupChain(settings: GoatCodexChatTurnSettings) {
  const chain = settings.wakeupChain;
  return typeof chain === "number" && Number.isInteger(chain) && chain >= 0 ? chain : 0;
}

function buildScheduledWakeupPrompt(input: { reason: string; prompt: string }) {
  return [
    "[Automated scheduled wakeup — not a message typed by the user]",
    `You scheduled this wakeup. Reason: ${input.reason}`,
    input.prompt || null,
    "Check on the deferred work and report the outcome. If it is already resolved, reply with a brief status. Schedule another wakeup only if the work is still genuinely pending.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

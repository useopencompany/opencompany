import {
  CODEX_COMMAND_TOOL_PART_TYPE,
  type CodexUiMessagePart,
  isCodexReasoningEffort,
  shellQuote,
} from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import {
  type GoatCodexChatSession,
  type GoatCodexChatTurn,
  goatCodexChatTurns,
  goatIntegrations,
} from "@opencompany/db/goat-schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { runCodexAppServerTurn } from "./codex-app-server";
import { ensureCodexInstalled } from "./codex-tool";
import { createKnownSecretRedactor, gitAuthHeader } from "./coding-agent-shared";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { getGitHubWorkInstallationToken } from "./github";
import { loadGoatCodexCliAuth, persistRefreshedGoatCodexAuth } from "./goat-codex";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import {
  createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts,
} from "./goat-codex-chat-events";
import { armSandboxIdleTimeout, createOrConnectSandbox } from "./sandbox";
import { rowsFromExecute } from "./sql-exec";

const CODEX_CHAT_HOME = "/home/user/.opencompany-goat/codex-chat-home";
const CODEX_CHAT_WORKDIR = "/home/user/opencompany-goat/codex-chat";
const GOAT_CODEX_CHAT_SKILL_FINGERPRINT = "goat-codex-chat-v1";
const INTERRUPT_POLL_INTERVAL_MS = 2_000;

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-codex-chat" });

export const GOAT_CODEX_CHAT_REAUTH_MESSAGE =
  "Codex is disconnected. Reconnect Codex in Goat settings, then send your message again.";

export class GoatCodexChatInterruptedError extends Error {
  constructor() {
    super("Codex chat turn was interrupted.");
    this.name = "GoatCodexChatInterruptedError";
  }
}

export async function runGoatCodexChatTurn(input: {
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  env: RunnerEnv;
  recovery?: { reason: "lease_reclaimed" };
  shouldAbort?: () => Error | null;
}) {
  const { turn, session, env, shouldAbort } = input;
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) {
    throw new Error(`Claimed codex chat turn ${turn.id} is missing its lease.`);
  }

  const initialParts = await loadCodexChatAssistantMessageParts(turn.assistantMessageId);
  const bareProjector = async () =>
    createGoatCodexChatProjector({
      target: {
        userWorkosId: turn.userWorkosId,
        codexChatSessionId: session.id,
        chatSessionId: session.chatSessionId,
        turnId: turn.id,
        assistantMessageId: turn.assistantMessageId,
        model: session.model,
        leaseId,
        leaseOwner,
      },
      redact: (value) => value,
      initialParts,
    });

  const auth = await loadGoatCodexCliAuth(turn.userWorkosId);
  if (!auth) {
    await (await bareProjector()).fail(GOAT_CODEX_CHAT_REAUTH_MESSAGE, { sessionStatus: "failed" });
    return;
  }

  let sandbox;
  try {
    sandbox = await createOrConnectSandbox({
      sandboxId: session.sandboxId,
      template: env.codexE2bTemplate ?? "codex",
      envs: {},
      metadata: {
        user_id: turn.userWorkosId,
      },
      idleTimeoutMs: env.goatCodexChatIdleTimeoutMs,
    });
  } catch (error) {
    await (await bareProjector()).fail(
      `Codex sandbox could not be started: ${errorMessage(error)}. Send your message again to retry.`,
    );
    return;
  }

  if (sandbox.sandboxId !== session.sandboxId) {
    await updateCodexChatSessionIfLeaseHeld({
      turn,
      leaseId,
      leaseOwner,
      setSql: sql`sandbox_id = ${sandbox.sandboxId}, updated_at = ${new Date()}`,
    });
  }

  const serializedAuthJson = auth.kind === "chatgpt" ? JSON.stringify(auth.authJson) : null;
  const github = await loadGoatGitHubAuthForUser(turn.userWorkosId);
  const settings = normalizeTurnSettings(turn.settings);
  const redact = createKnownSecretRedactor([
    serializedAuthJson,
    auth.kind === "api" ? auth.apiKeyValue : null,
    github?.githubToken ?? null,
    github?.githubAuthHeader ?? null,
  ]);
  const projector = createGoatCodexChatProjector({
    target: {
      userWorkosId: turn.userWorkosId,
      codexChatSessionId: session.id,
      chatSessionId: session.chatSessionId,
      turnId: turn.id,
      assistantMessageId: turn.assistantMessageId,
      model: session.model,
      leaseId,
      leaseOwner,
    },
    redact,
    // Resumes the parts already persisted for this message (normally empty; non-empty only if a
    // previous write landed before a transient failure of the same turn).
    initialParts,
  });

  try {
    await sandbox.commands.run(
      `mkdir -p ${shellQuote(CODEX_CHAT_WORKDIR)} ${shellQuote(CODEX_CHAT_HOME)}`,
      { timeoutMs: 30_000 },
    );
    if (serializedAuthJson) {
      await sandbox.files.write(`${CODEX_CHAT_HOME}/auth.json`, serializedAuthJson);
    }
    await ensureCodexInstalled(sandbox);

    const summary = await runCodexAppServerTurn({
      sandbox,
      codexWorkRoot: CODEX_CHAT_WORKDIR,
      codexHome: CODEX_CHAT_HOME,
      skillFingerprint: GOAT_CODEX_CHAT_SKILL_FINGERPRINT,
      task: input.recovery
        ? buildCodexChatRecoveryTask({
            prompt: turn.prompt,
            githubAvailable: Boolean(github),
            previousProgress: summarizeCodexChatRecoveryProgress(initialParts),
          })
        : buildCodexChatTask({ prompt: turn.prompt, githubAvailable: Boolean(github) }),
      model: session.model || env.codexModel,
      reasoningEffort: settings.reasoningEffort,
      planModeReasoningEffort: settings.planModeReasoningEffort,
      goalMode: settings.goalMode,
      existingEngineSessionId: session.codexThreadId,
      auth,
      githubAuth: {
        githubToken: github?.githubToken ?? null,
        githubAuthHeader: github?.githubAuthHeader ?? null,
      },
      timeoutMs: env.codexTimeoutMs,
      checkAbort: createTurnAbortCheck({
        turnId: turn.id,
        leaseId,
        leaseOwner,
        ...(shouldAbort ? { shouldAbort } : {}),
      }),
      onRuntimeEvents: (events) => projector.push(events),
      onActivity: async () => undefined,
    });

    if (summary.sessionId && summary.sessionId !== session.codexThreadId) {
      await updateCodexChatSessionIfLeaseHeld({
        turn,
        leaseId,
        leaseOwner,
        setSql: sql`codex_thread_id = ${summary.sessionId}, updated_at = ${new Date()}`,
      });
    }
    await persistRefreshedGoatCodexAuth({
      sandbox,
      userWorkosId: turn.userWorkosId,
      auth,
      codexHome: CODEX_CHAT_HOME,
    }).catch((error) => {
      captureException(error, {
        event: "opencompany.goat_codex_chat_auth_persist_failed",
        turn_id: turn.id,
      });
      logger.warn("Failed to persist refreshed Goat Codex auth", {
        event: "opencompany.goat_codex_chat_auth_persist_failed",
        turn_id: turn.id,
        error,
      });
    });
    await projector.finalize(summary);
  } catch (error) {
    if (error instanceof GoatCodexChatInterruptedError) {
      await persistRefreshedGoatCodexAuth({
        sandbox,
        userWorkosId: turn.userWorkosId,
        auth,
        codexHome: CODEX_CHAT_HOME,
      }).catch(() => undefined);
      await projector.interrupted();
    } else if (error instanceof GoatCodexChatLeaseLostError) {
      // Another worker owns the turn now; leave all rows to it.
      throw error;
    } else {
      await projector.fail(redact(errorMessage(error)));
    }
  } finally {
    // The sandbox outlives the turn: arm the chat idle timeout instead of killing it, so the
    // next message reconnects to warm files and a reusable app-server daemon.
    await armSandboxIdleTimeout(sandbox, env.goatCodexChatIdleTimeoutMs).catch(() => undefined);
  }
}

// GitHub auth is injected whenever the user has a connected Goat GitHub integration; the token
// covers every repository of the installation (no repo scoping) so Codex can clone what the user
// asks for in chat. Missing integration is not an error - the sandbox simply has no GitHub auth.
export async function loadGoatGitHubAuthForUser(userWorkosId: string) {
  const [integration] = await getDb()
    .select({ installationId: goatIntegrations.externalId })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "github"),
        eq(goatIntegrations.status, "connected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);
  if (!integration?.installationId) return null;

  const githubToken = await getGitHubWorkInstallationToken({
    installationId: integration.installationId,
  }).catch(() => null);
  if (!githubToken) return null;
  return { githubToken, githubAuthHeader: gitAuthHeader(githubToken) };
}

async function updateCodexChatSessionIfLeaseHeld(input: {
  turn: GoatCodexChatTurn;
  leaseId: string;
  leaseOwner: string;
  setSql: SQL;
}) {
  const result = await getDb().execute(sql`
    UPDATE goat.codex_chat_sessions AS session
    SET ${input.setSql}
    WHERE session.id = ${input.turn.codexChatSessionId}
      AND session.user_workos_id = ${input.turn.userWorkosId}
      AND EXISTS (
        SELECT 1
        FROM goat.codex_chat_turns AS turn
        WHERE turn.id = ${input.turn.id}
          AND turn.user_workos_id = ${input.turn.userWorkosId}
          AND turn.codex_chat_session_id = session.id
          AND turn.lease_id = ${input.leaseId}
          AND turn.lease_owner = ${input.leaseOwner}
          AND turn.status = 'running'
      )
    RETURNING session.id
  `);
  if (rowsFromExecute(result).length === 0) {
    throw new GoatCodexChatLeaseLostError();
  }
}

function createTurnAbortCheck(input: {
  turnId: string;
  leaseId: string;
  leaseOwner: string;
  shouldAbort?: () => Error | null;
}) {
  let lastCheckedAt = 0;
  return async () => {
    const externalAbort = input.shouldAbort?.();
    if (externalAbort) throw externalAbort;
    const now = Date.now();
    if (now - lastCheckedAt < INTERRUPT_POLL_INTERVAL_MS) return;
    lastCheckedAt = now;
    const [row] = await getDb()
      .select({
        interruptRequestedAt: goatCodexChatTurns.interruptRequestedAt,
        leaseId: goatCodexChatTurns.leaseId,
        leaseOwner: goatCodexChatTurns.leaseOwner,
      })
      .from(goatCodexChatTurns)
      .where(eq(goatCodexChatTurns.id, input.turnId))
      .limit(1);
    if (!row || row.leaseId !== input.leaseId || row.leaseOwner !== input.leaseOwner) {
      throw new GoatCodexChatLeaseLostError();
    }
    if (row.interruptRequestedAt) throw new GoatCodexChatInterruptedError();
  };
}

function buildCodexChatTask(input: { prompt: string; githubAvailable: boolean }) {
  return [
    "You are Codex running in a persistent cloud sandbox for an ongoing chat with a user.",
    "The sandbox and its files persist across messages in this chat session, so you can build on earlier work.",
    input.githubAvailable
      ? "GitHub authentication is available through GH_TOKEN and git HTTPS extraheader auth. Clone repositories into the working directory only when the user asks you to work on one."
      : null,
    "Answer conversationally. Run commands or edit files only when the message calls for it, and keep replies concise unless the user asks for detail.",
    "",
    "<user_message>",
    input.prompt,
    "</user_message>",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function buildCodexChatRecoveryTask(input: {
  prompt: string;
  githubAvailable: boolean;
  previousProgress: string;
}) {
  return [
    "You are Codex running in a persistent cloud sandbox for an ongoing chat with a user.",
    "The previous runner process died while handling this same user message. Continue from the durable sandbox, filesystem, git state, app-server thread, and persisted progress below instead of starting over.",
    "First inspect the current filesystem, git state, and any relevant external state. Do not repeat completed work or rerun side-effecting commands until inspection proves that it is necessary.",
    input.githubAvailable
      ? "GitHub authentication is available through GH_TOKEN and git HTTPS extraheader auth. Before pushing, opening a PR, or mutating GitHub, inspect the current remote/PR state so recovery is idempotent."
      : null,
    "If the interrupted work already finished, report the final result. If additional work is needed, finish it and then answer concisely.",
    "",
    "<original_user_message>",
    input.prompt,
    "</original_user_message>",
    "",
    "<last_persisted_progress>",
    input.previousProgress || "No persisted assistant progress was available.",
    "</last_persisted_progress>",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function summarizeCodexChatRecoveryProgress(parts: readonly CodexUiMessagePart[]) {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      pushSummaryLine(lines, `Assistant: ${oneLine(part.text, 700)}`);
      continue;
    }
    if (part.type === "reasoning") {
      pushSummaryLine(lines, `Reasoning: ${oneLine(part.text, 260)}`);
      continue;
    }
    if (part.type === CODEX_COMMAND_TOOL_PART_TYPE) {
      const command = oneLine(part.input.command, 360);
      if (part.state === "input-available") {
        pushSummaryLine(lines, `Command started without a persisted result: ${command}`);
      } else if (part.state === "output-error") {
        pushSummaryLine(lines, `Command failed: ${command}`);
      } else {
        const status = part.output.status;
        const exitCode =
          typeof part.output.exitCode === "number" ? `, exit ${part.output.exitCode}` : "";
        pushSummaryLine(lines, `Command ${status}${exitCode}: ${command}`);
      }
      continue;
    }
    if (part.type === "dynamic-tool") {
      pushSummaryLine(lines, summarizeCodexStatusPart(part));
    }
  }
  return lines.slice(-18).join("\n");
}

function summarizeCodexStatusPart(part: Extract<CodexUiMessagePart, { type: "dynamic-tool" }>) {
  const input = isRecord(part.input) ? part.input : {};
  const output = part.state === "output-available" && isRecord(part.output) ? part.output : {};
  const objective = readString(output.objective) ?? readString(input.objective);
  const status = readString(output.status) ?? readString(input.status);
  const text = readString(output.text) ?? readString(input.text);
  const detail = objective ?? text ?? readString(input.question) ?? readString(input.title);
  const state = part.state === "output-available" ? "updated" : "active";
  return `${part.toolName} ${status ?? state}: ${oneLine(detail ?? "no detail", 260)}`;
}

function pushSummaryLine(lines: string[], line: string) {
  const trimmed = line.trim();
  if (trimmed) lines.push(trimmed);
}

function oneLine(value: string, limit: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeTurnSettings(value: unknown): {
  reasoningEffort: CodexReasoningEffort;
  planModeReasoningEffort: CodexReasoningEffort | null;
  goalMode: { objective: string; tokenBudget?: number | null } | null;
} {
  const record = isRecord(value) ? value : {};
  return {
    reasoningEffort: readReasoningEffort(record.reasoningEffort) ?? "medium",
    planModeReasoningEffort: readReasoningEffort(record.planModeReasoningEffort),
    goalMode: readGoalMode(record.goalMode),
  };
}

function readReasoningEffort(value: unknown): CodexReasoningEffort | null {
  return typeof value === "string" && isCodexReasoningEffort(value) ? value : null;
}

function readGoalMode(value: unknown): { objective: string; tokenBudget?: number | null } | null {
  if (!isRecord(value)) return null;
  const objective = typeof value.objective === "string" ? value.objective.trim() : "";
  if (!objective) return null;
  const tokenBudget =
    typeof value.tokenBudget === "number" && Number.isInteger(value.tokenBudget)
      ? value.tokenBudget
      : null;
  return {
    objective,
    ...(tokenBudget && tokenBudget > 0 ? { tokenBudget } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

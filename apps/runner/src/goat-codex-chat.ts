import { shellQuote } from "@opencompany/agent-runtime";
import {
  type GoatCodexChatSession,
  type GoatCodexChatTurn,
  goatCodexChatSessions,
  goatCodexChatTurns,
  goatIntegrations,
} from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import { runCodexAppServerTurn } from "./codex-app-server";
import { ensureCodexInstalled } from "./codex-tool";
import { createKnownSecretRedactor, gitAuthHeader } from "./coding-agent-shared";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { getGitHubWorkInstallationToken } from "./github";
import { loadGoatCodexCliAuth, persistRefreshedGoatCodexAuth } from "./goat-codex";
import {
  createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts,
} from "./goat-codex-chat-events";
import { armSandboxIdleTimeout, createOrConnectSandbox } from "./sandbox";

const CODEX_CHAT_HOME = "/home/user/.opencompany-goat/codex-chat-home";
const CODEX_CHAT_WORKDIR = "/home/user/opencompany-goat/codex-chat";
const GOAT_CODEX_CHAT_SKILL_FINGERPRINT = "goat-codex-chat-v1";
const INTERRUPT_POLL_INTERVAL_MS = 2_000;

export const GOAT_CODEX_CHAT_REAUTH_MESSAGE =
  "Codex is disconnected. Reconnect Codex in Goat settings, then send your message again.";

export class GoatCodexChatInterruptedError extends Error {
  constructor() {
    super("Codex chat turn was interrupted.");
    this.name = "GoatCodexChatInterruptedError";
  }
}

export class GoatCodexChatLeaseLostError extends Error {
  constructor() {
    super("Codex chat turn lease is no longer owned by this worker.");
    this.name = "GoatCodexChatLeaseLostError";
  }
}

export async function runGoatCodexChatTurn(input: {
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  env: RunnerEnv;
}) {
  const { turn, session, env } = input;
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) {
    throw new Error(`Claimed codex chat turn ${turn.id} is missing its lease.`);
  }

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
      initialParts: await loadCodexChatAssistantMessageParts(turn.assistantMessageId),
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
      idleTimeoutMs: env.goatCodexChatIdleTimeoutMs,
    });
  } catch (error) {
    await (await bareProjector()).fail(
      `Codex sandbox could not be started: ${errorMessage(error)}. Send your message again to retry.`,
    );
    return;
  }

  if (sandbox.sandboxId !== session.sandboxId) {
    await getDb()
      .update(goatCodexChatSessions)
      .set({ sandboxId: sandbox.sandboxId, updatedAt: new Date() })
      .where(
        and(
          eq(goatCodexChatSessions.id, session.id),
          eq(goatCodexChatSessions.userWorkosId, turn.userWorkosId),
        ),
      );
  }

  const serializedAuthJson = auth.kind === "chatgpt" ? JSON.stringify(auth.authJson) : null;
  const github = await loadGoatGitHubAuthForUser(turn.userWorkosId);
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
    initialParts: await loadCodexChatAssistantMessageParts(turn.assistantMessageId),
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
      task: buildCodexChatTask({ prompt: turn.prompt, githubAvailable: Boolean(github) }),
      model: session.model || env.codexModel,
      reasoningEffort: "medium",
      planModeReasoningEffort: null,
      goalMode: null,
      existingEngineSessionId: session.codexThreadId,
      auth,
      githubAuth: {
        githubToken: github?.githubToken ?? null,
        githubAuthHeader: github?.githubAuthHeader ?? null,
      },
      timeoutMs: env.codexTimeoutMs,
      checkAbort: createTurnAbortCheck({ turnId: turn.id, leaseId, leaseOwner }),
      onRuntimeEvents: (events) => projector.push(events),
      onActivity: async () => undefined,
    });

    if (summary.sessionId && summary.sessionId !== session.codexThreadId) {
      await getDb()
        .update(goatCodexChatSessions)
        .set({ codexThreadId: summary.sessionId, updatedAt: new Date() })
        .where(
          and(
            eq(goatCodexChatSessions.id, session.id),
            eq(goatCodexChatSessions.userWorkosId, turn.userWorkosId),
          ),
        );
    }
    await persistRefreshedGoatCodexAuth({
      sandbox,
      userWorkosId: turn.userWorkosId,
      auth,
      codexHome: CODEX_CHAT_HOME,
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

function createTurnAbortCheck(input: { turnId: string; leaseId: string; leaseOwner: string }) {
  let lastCheckedAt = 0;
  return async () => {
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

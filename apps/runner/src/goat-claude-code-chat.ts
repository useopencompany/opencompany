import {
  type ClaudeCodeTurnSummary,
  claudeCodeModelSupportsReasoningEffort,
  createClaudeCodeEventNormalizer,
  isCodexReasoningEffort,
  shellQuote,
} from "@opencompany/agent-runtime";
import {
  loadGoatClaudeCodeCredential,
  markGoatClaudeCodeCredentialNeedsReauth,
  markGoatClaudeCodeCredentialValidated,
} from "@opencompany/db/goat-claude-code-auth";
import type { GoatCodexChatSession, GoatCodexChatTurn } from "@opencompany/db/goat-schema";
import { serializeGoatBrainSkillMarkdown } from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import {
  buildClaudeCommandEnv,
  buildClaudeTurnCommand,
  type ClaudeCodeCliAuth,
  ensureClaudeInstalled,
  runClaudeCodeCliProcess,
} from "./claude-code-cli";
import type { CodexAppServerSummary } from "./codex-app-server";
import { buildGitHubCommandEnv, createKnownSecretRedactor } from "./coding-agent-shared";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  claimCodexChatRecovery,
  codexChatAttachmentPromptLines,
  codexChatTurnLeaseIsHeld,
  createTurnAbortCheck,
  GoatCodexChatInterruptedError,
  loadGoatCodexChatAttachments,
  loadGoatCodexChatSessionSkills,
  loadGoatGitHubAuthForUser,
  markCodexChatSandboxTimeoutArmed,
  materializeGoatCodexChatAttachments,
  summarizeCodexChatRecoveryProgress,
  updateCodexChatSessionIfLeaseHeld,
} from "./goat-codex-chat";
import { GoatCodexChatHandoffError, GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import {
  createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts,
} from "./goat-codex-chat-events";
import {
  armSandboxActiveTimeoutById,
  armSandboxIdleTimeout,
  createOrConnectSandbox,
} from "./sandbox";
import { materializeCodexSkillSnapshotsForSession } from "./skills";

const CLAUDE_CHAT_WORKDIR = "/home/user/opencompany-goat/claude-chat";
const CLAUDE_CHAT_PROMPTS_ROOT = "/home/user/.opencompany-goat/claude-chat-prompts";
const CLAUDE_CHAT_HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-claude-code-chat" });

export const GOAT_CLAUDE_CODE_CHAT_REAUTH_MESSAGE =
  "Claude Code is disconnected. Reconnect Claude Code in Goat settings, then send your message again.";

// "authenticat" covers both "Failed to authenticate" (real 401 result text, observed
// against claude 2.1.220) and "authentication".
const AUTH_FAILURE_PATTERN =
  /oauth|authenticat|unauthorized|401|login expired|invalid api key|credit balance|usage credits/i;

export async function loadGoatClaudeCodeAuth(
  userWorkosId: string,
): Promise<(ClaudeCodeCliAuth & { credentialUpdatedAt: Date }) | null> {
  let credential: Awaited<ReturnType<typeof loadGoatClaudeCodeCredential>>;
  try {
    credential = await loadGoatClaudeCodeCredential({ db: getDb(), userWorkosId });
  } catch {
    await markGoatClaudeCodeCredentialNeedsReauth({
      db: getDb(),
      userWorkosId,
      statusReason:
        "Claude Code credentials could not be decrypted. Reconnect Claude Code in Goat settings.",
    });
    return null;
  }
  if (!credential || credential.status !== "connected") return null;
  const token = credential.authJson.token;
  if (typeof token !== "string" || !token) return null;
  return {
    kind: "oauth",
    token,
    subscriptionType:
      typeof credential.authJson.subscriptionType === "string"
        ? credential.authJson.subscriptionType
        : null,
    rateLimitTier:
      typeof credential.authJson.rateLimitTier === "string"
        ? credential.authJson.rateLimitTier
        : null,
    credentialUpdatedAt: credential.updatedAt,
  };
}

export async function runGoatClaudeCodeChatTurn(input: {
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  env: RunnerEnv;
  recovery?: { reason: "lease_reclaimed" };
  shouldAbort?: () => Error | null;
}): Promise<"settled" | "handed_off"> {
  const { turn, session, env, shouldAbort } = input;
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) {
    throw new Error(`Claimed claude chat turn ${turn.id} is missing its lease.`);
  }

  const initialParts = await loadCodexChatAssistantMessageParts(turn.assistantMessageId);
  const projectorTarget = {
    userWorkosId: turn.userWorkosId,
    codexChatSessionId: session.id,
    chatSessionId: session.chatSessionId,
    turnId: turn.id,
    assistantMessageId: turn.assistantMessageId,
    model: session.model,
    leaseId,
    leaseOwner,
    planMode: false,
    turnCreatedAt: turn.createdAt,
  };
  const bareProjector = () =>
    createGoatCodexChatProjector({
      target: projectorTarget,
      redact: (value) => value,
      initialParts,
    });

  const auth = await loadGoatClaudeCodeAuth(turn.userWorkosId);
  if (!auth) {
    await bareProjector().fail(GOAT_CLAUDE_CODE_CHAT_REAUTH_MESSAGE, { sessionStatus: "failed" });
    return "settled";
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
    await bareProjector().fail(
      `Claude Code sandbox could not be started: ${errorMessage(error)}. Send your message again to retry.`,
    );
    return "settled";
  }

  // A replacement sandbox has a fresh home directory, so any stored Claude session id
  // points at state that no longer exists; start a fresh engine session in that case.
  const sandboxReplaced = sandbox.sandboxId !== session.sandboxId;
  if (sandboxReplaced) {
    await updateCodexChatSessionIfLeaseHeld({
      turn,
      leaseId,
      leaseOwner,
      setSql: sql`sandbox_id = ${sandbox.sandboxId}, codex_thread_id = NULL, updated_at = ${new Date()}`,
    });
  }

  const github = await loadGoatGitHubAuthForUser(turn.userWorkosId);
  const redact = createKnownSecretRedactor([
    auth.token,
    github?.githubToken ?? null,
    github?.githubAuthHeader ?? null,
    env.internalToken,
  ]);
  const normalizer = createClaudeCodeEventNormalizer();
  const projector = createGoatCodexChatProjector({
    target: projectorTarget,
    redact,
    initialParts,
    normalizeEvent: normalizer.normalize,
  });

  const checkExternalAbort = () => {
    const abort = shouldAbort?.();
    if (abort) throw abort;
  };

  let outcome: "settled" | "handed_off" = "settled";
  let leaseLost = false;
  let executionStage = "load_attachments";
  try {
    checkExternalAbort();
    if (input.recovery) {
      executionStage = "claim_recovery";
      await claimCodexChatRecovery({ turn, leaseId, leaseOwner });
    }
    const attachments = await loadGoatCodexChatAttachments(turn);
    checkExternalAbort();
    executionStage = "prepare_directories";
    await sandbox.commands.run(
      `mkdir -p ${shellQuote(CLAUDE_CHAT_WORKDIR)} ${shellQuote(CLAUDE_CHAT_PROMPTS_ROOT)}`,
      { timeoutMs: 30_000 },
    );
    checkExternalAbort();
    executionStage = "ensure_claude";
    await ensureClaudeInstalled(sandbox);
    checkExternalAbort();
    executionStage = "load_skills";
    const sessionSkills = await loadGoatCodexChatSessionSkills(turn);
    checkExternalAbort();
    executionStage = "materialize_skills";
    await materializeCodexSkillSnapshotsForSession({
      sandbox,
      codexWorkRoot: CLAUDE_CHAT_WORKDIR,
      skills: sessionSkills.map((skill) => ({
        id: skill.skillId,
        files: [
          {
            path: "SKILL.md",
            content: serializeGoatBrainSkillMarkdown({
              id: skill.skillId,
              name: skill.name,
              description: skill.description,
              instructions: skill.instructions,
            }),
          },
        ],
      })),
    });
    checkExternalAbort();
    const invokedSkillPaths = sessionSkills
      .filter((skill) => skill.activatedMessageId === turn.userMessageId)
      .map((skill) => `${CLAUDE_CHAT_WORKDIR}/.agents/skills/${skill.skillId}/SKILL.md`);
    executionStage = "materialize_attachments";
    const materializedAttachments = await materializeGoatCodexChatAttachments({
      sandbox,
      turnId: turn.id,
      attachments,
      blobToken: env.blobReadWriteToken,
    });
    checkExternalAbort();

    executionStage = "write_prompt";
    const task = input.recovery
      ? buildClaudeChatRecoveryTask({
          prompt: turn.prompt,
          githubAvailable: Boolean(github),
          previousProgress: summarizeCodexChatRecoveryProgress(initialParts),
          attachmentPaths: materializedAttachments.paths,
          skillPaths: invokedSkillPaths,
        })
      : buildClaudeChatTask({
          prompt: turn.prompt,
          githubAvailable: Boolean(github),
          attachmentPaths: materializedAttachments.paths,
          skillPaths: invokedSkillPaths,
        });
    const promptPath = `${CLAUDE_CHAT_PROMPTS_ROOT}/prompt-${turn.id}.txt`;
    await sandbox.files.write(promptPath, task);
    checkExternalAbort();

    const checkAbort = createTurnAbortCheck({
      turnId: turn.id,
      leaseId,
      leaseOwner,
      ...(shouldAbort ? { shouldAbort } : {}),
    });
    let sessionIdPersisted = false;
    const persistEngineSessionId = async () => {
      const engineSessionId = normalizer.sessionId();
      if (sessionIdPersisted || !engineSessionId || engineSessionId === session.codexThreadId) {
        return;
      }
      sessionIdPersisted = true;
      await updateCodexChatSessionIfLeaseHeld({
        turn,
        leaseId,
        leaseOwner,
        setSql: sql`codex_thread_id = ${engineSessionId}, updated_at = ${new Date()}`,
      });
    };

    executionStage = "run_turn";
    const resumeSessionId = sandboxReplaced ? null : session.codexThreadId;
    const runOnce = (resume: string | null) =>
      runClaudeCodeCliProcess({
        sandbox,
        command: buildClaudeTurnCommand({
          workdir: CLAUDE_CHAT_WORKDIR,
          promptPath,
          model: session.model || null,
          reasoningEffort:
            claudeCodeModelSupportsReasoningEffort(session.model) &&
            typeof turn.settings?.reasoningEffort === "string" &&
            isCodexReasoningEffort(turn.settings.reasoningEffort)
              ? turn.settings.reasoningEffort
              : null,
          resumeSessionId: resume,
        }),
        envs: buildClaudeCommandEnv({
          auth,
          ...(github
            ? {
                githubEnv: buildGitHubCommandEnv({
                  githubAuthHeader: github.githubAuthHeader,
                  githubToken: github.githubToken,
                  toolCallId: turn.id,
                }),
              }
            : {}),
        }),
        timeoutMs: env.codexTimeoutMs,
        redact,
        checkAbort,
        onEvent: async (event) => {
          await projector.push([event]);
          await persistEngineSessionId();
        },
      });

    let runResult = await runOnce(resumeSessionId);
    let summary = normalizer.summary();
    // A stored session id can be stale (sandbox files pruned, claude upgraded). Retry
    // once without --resume rather than failing the whole turn.
    if (resumeSessionId && isUnresumableSessionFailure(summary, runResult)) {
      logger.warn("Claude Code session resume failed; retrying with a fresh session", {
        event: "opencompany.goat_claude_chat_resume_failed",
        turn_id: turn.id,
        codex_chat_session_id: session.id,
      });
      await updateCodexChatSessionIfLeaseHeld({
        turn,
        leaseId,
        leaseOwner,
        setSql: sql`codex_thread_id = NULL, updated_at = ${new Date()}`,
      });
      runResult = await runOnce(null);
      summary = normalizer.summary();
    }

    executionStage = "finalize";
    await persistEngineSessionId();
    if (!summary) {
      const stderrTail = redact(runResult.stderrTail.trim());
      const reason = runResult.timedOut
        ? "Claude Code timed out before finishing the turn."
        : `Claude Code exited (code ${runResult.exitCode ?? "unknown"}) without a result.`;
      summary = {
        status: "failure",
        result: null,
        error: stderrTail ? `${reason} ${lastLine(stderrTail)}` : reason,
        usage: null,
        sessionId: normalizer.sessionId(),
      };
    }
    if (summary.status === "failure") {
      const failureText = `${summary.error ?? ""}\n${runResult.stderrTail}`;
      if (AUTH_FAILURE_PATTERN.test(failureText)) {
        await markGoatClaudeCodeCredentialNeedsReauth({
          db: getDb(),
          userWorkosId: turn.userWorkosId,
          statusReason: "Claude Code rejected the stored token. Reconnect in Goat settings.",
        });
        summary = { ...summary, error: GOAT_CLAUDE_CODE_CHAT_REAUTH_MESSAGE };
      }
    }
    if (summary.status === "success") {
      executionStage = "validate_credential";
      try {
        const validated = await markGoatClaudeCodeCredentialValidated({
          db: getDb(),
          userWorkosId: turn.userWorkosId,
          expectedUpdatedAt: auth.credentialUpdatedAt,
        });
        if (!validated) {
          logger.info("Claude Code credential changed before validation completed", {
            event: "opencompany.goat_claude_chat_credential_validation_stale",
            turn_id: turn.id,
            user_workos_id: turn.userWorkosId,
          });
        }
      } catch (error) {
        captureException(error, {
          event: "opencompany.goat_claude_chat_credential_validation_failed",
          turn_id: turn.id,
          user_workos_id: turn.userWorkosId,
        });
        logger.warn("Failed to record successful Claude Code credential validation", {
          event: "opencompany.goat_claude_chat_credential_validation_failed",
          turn_id: turn.id,
          user_workos_id: turn.userWorkosId,
          error,
        });
      }
    }
    executionStage = "finalize";
    await projector.finalize(toCodexAppServerSummary(summary));
  } catch (error) {
    const effectiveError =
      error instanceof GoatCodexChatHandoffError ||
      error instanceof GoatCodexChatInterruptedError ||
      error instanceof GoatCodexChatLeaseLostError
        ? error
        : (shouldAbort?.() ?? error);
    if (effectiveError instanceof GoatCodexChatHandoffError) {
      // One-shot CLI turns cannot be reattached; the replacement runner reclaims the
      // turn and reruns it with the recovery prompt against the persisted sandbox.
      outcome = "handed_off";
    } else if (effectiveError instanceof GoatCodexChatInterruptedError) {
      await projector.interrupted();
    } else if (effectiveError instanceof GoatCodexChatLeaseLostError) {
      leaseLost = true;
      throw effectiveError;
    } else {
      const message = redact(errorMessage(effectiveError));
      logger.warn("Goat Claude Code chat turn execution failed", {
        event: "opencompany.goat_claude_chat_turn_execution_failed",
        turn_id: turn.id,
        codex_chat_session_id: session.id,
        attempt: turn.attempts,
        recovery: Boolean(input.recovery),
        stage: executionStage,
        error_name: effectiveError instanceof Error ? effectiveError.name : typeof effectiveError,
        error: message,
      });
      await projector.fail(message);
    }
  } finally {
    // The sandbox outlives the turn so the next message reuses warm files and the
    // persisted ~/.claude session store.
    const idleTimeoutMs =
      outcome === "handed_off"
        ? Math.max(CLAUDE_CHAT_HANDOFF_TIMEOUT_MS, env.jobLeaseTtlMs * 2)
        : env.goatCodexChatIdleTimeoutMs;
    try {
      if (
        !leaseLost &&
        (outcome !== "handed_off" ||
          (await codexChatTurnLeaseIsHeld({ turn, leaseId, leaseOwner })))
      ) {
        const armed = await armSandboxIdleTimeout(sandbox, idleTimeoutMs);
        if (armed && outcome === "settled") {
          await markCodexChatSandboxTimeoutArmed({
            sessionId: session.id,
            userWorkosId: turn.userWorkosId,
            sandboxId: sandbox.sandboxId,
          });
        }
        if (
          armed &&
          outcome === "handed_off" &&
          !(await codexChatTurnLeaseIsHeld({ turn, leaseId, leaseOwner }))
        ) {
          await armSandboxActiveTimeoutById(sandbox.sandboxId);
        }
      }
    } catch (error) {
      captureException(error, {
        event: "opencompany.goat_claude_chat_sandbox_parking_failed",
        turn_id: turn.id,
        codex_chat_session_id: session.id,
      });
      logger.warn("Failed to park Goat Claude Code chat sandbox", {
        event: "opencompany.goat_claude_chat_sandbox_parking_failed",
        turn_id: turn.id,
        codex_chat_session_id: session.id,
        error,
      });
    }
  }
  return outcome;
}

function toCodexAppServerSummary(summary: ClaudeCodeTurnSummary): CodexAppServerSummary {
  return {
    sessionId: summary.sessionId,
    status: summary.status === "success" ? "success" : "error",
    result: summary.result ?? "",
    error: summary.error,
    usage: summary.usage,
    goal: null,
  };
}

// A stale --resume id surfaces as a failed result event ("No conversation found with
// session ID: ...") on stdout with an empty stderr — check both channels.
function isUnresumableSessionFailure(
  summary: ClaudeCodeTurnSummary | null,
  runResult: { exitCode: number | null; stderrTail: string },
) {
  if (summary?.status === "success") return false;
  return /no conversation found|session.*not found|could not resume/i.test(
    `${summary?.error ?? ""}\n${runResult.stderrTail}`,
  );
}

function buildClaudeChatTask(input: {
  prompt: string;
  githubAvailable: boolean;
  attachmentPaths: string[];
  skillPaths: string[];
}) {
  return [
    "You are Claude Code running in a persistent cloud sandbox for an ongoing chat with a user.",
    "The sandbox and its files persist across messages in this chat session, so you can build on earlier work.",
    input.githubAvailable
      ? "GitHub authentication is available through GH_TOKEN and git HTTPS extraheader auth. Clone repositories into the working directory only when the user asks you to work on one."
      : null,
    "Answer conversationally. Run commands or edit files only when the message calls for it, and keep replies concise unless the user asks for detail.",
    ...claudeChatSkillPromptLines(input.skillPaths),
    "",
    "<user_message>",
    input.prompt || "Review the attached file(s).",
    "</user_message>",
    ...codexChatAttachmentPromptLines(input.attachmentPaths),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function buildClaudeChatRecoveryTask(input: {
  prompt: string;
  githubAvailable: boolean;
  previousProgress: string;
  attachmentPaths: string[];
  skillPaths: string[];
}) {
  return [
    "You are Claude Code running in a persistent cloud sandbox for an ongoing chat with a user.",
    "The previous runner process died while handling this same user message. Continue from the durable sandbox, filesystem, git state, and persisted progress below instead of starting over.",
    "First inspect the current filesystem, git state, and any relevant external state. Do not repeat completed work or rerun side-effecting commands until inspection proves that it is necessary.",
    input.githubAvailable
      ? "GitHub authentication is available through GH_TOKEN and git HTTPS extraheader auth. Before pushing, opening a PR, or mutating GitHub, inspect the current remote/PR state so recovery is idempotent."
      : null,
    "If the interrupted work already finished, report the final result. If additional work is needed, finish it and then answer concisely.",
    ...claudeChatSkillPromptLines(input.skillPaths),
    "",
    "<original_user_message>",
    input.prompt || "Review the attached file(s).",
    "</original_user_message>",
    ...codexChatAttachmentPromptLines(input.attachmentPaths),
    "",
    "<last_persisted_progress>",
    input.previousProgress || "No persisted assistant progress was available.",
    "</last_persisted_progress>",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function claudeChatSkillPromptLines(skillPaths: string[]) {
  if (skillPaths.length === 0) return [];
  return [
    "",
    "<invoked_skills>",
    "The user invoked these skills with this message. Read each SKILL.md and follow its instructions:",
    ...skillPaths.map((path) => `- ${path}`),
    "</invoked_skills>",
  ];
}

function lastLine(value: string) {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

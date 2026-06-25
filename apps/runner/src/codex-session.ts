import {
  codexCliModelNameForModelId,
  isCodexReasoningEffort,
  newAgentSessionMessageId,
  normalizeAgentConfig,
  shellQuote,
} from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import {
  agentSessionMessageAttachments,
  agentSessionMessages,
  agentSessions,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { flushBraintrust, traceBraintrust } from "@opencompany/observability/braintrust";
import { and, eq, isNull } from "drizzle-orm";
import { setActiveRun } from "./active-runs";
import { loadConnectedGitHubInstallation } from "./amp-tool";
import {
  buildCodexCommand,
  buildCodexConfigForAuth,
  buildCodexWorkRoot,
  type CodexCliAuth,
  codexApiKeyFallbackEnabled,
  codexHostedToolUsage,
  codexRuntimeEventsFromJsonEvent,
  createCodexStreamAccumulator,
  ensureCodexInstalled,
  loadWorkspaceCodexCliAuth,
  persistRefreshedWorkspaceCodexAuth,
} from "./codex-tool";
import {
  buildGitHubCommandEnv,
  createKnownSecretRedactor,
  gitAuthHeader,
  truncateText,
} from "./coding-agent-shared";
import { getDb } from "./db";
import { brokerActive, brokerBaseUrl, type RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { getGitHubWorkInstallationToken } from "./github";
import {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
  failRunLease,
  releaseRunLease,
  requireLeaseWrite,
  StaleRunLeaseError,
  updateSandboxForLease,
} from "./lease-writes";
import { withBrokerDelegation } from "./llm-broker-tokens";
import {
  createLeaseAbortCheck,
  createRunContext,
  finalizeRun,
  observeRunStep,
  recordSandboxUsageBestEffort,
  type SandboxBillingSnapshot,
} from "./run-context";
import {
  RunAbortError,
  RunLeaseBusyError,
  RunLeaseLostError,
  withRunControlChecks,
} from "./run-control";
import { MessageTurnFailedError } from "./runner-errors";
import {
  commandExitResult,
  guardCommandStreamCallbacks,
  isCommandTimeoutError,
  killSandbox,
  type SandboxHandle,
  sandboxLayout,
} from "./sandbox";
import {
  acquireCodexSandboxForTurn,
  isSessionArchived,
  loadAssistantResponseForMessage,
  loadSession,
  loadUserMessage,
  resolveSandboxBilling,
  setStatus,
} from "./session-lifecycle";
import { recordToolUsage } from "./usage-recorder";

const logger = createLogger({ service: "opencompany-runner", runtime: "codex-session" });

const CODEX_BIN_PATH = '"$HOME/.codex/bin"';
// CODEX_HOME for session runs lives OUTSIDE the work root the model operates in (Codex is
// launched with `--cd ${codexWorkRoot}`). For subscription-backed runs the workspace ChatGPT
// auth.json is written here; keeping it out of the agent's working tree stops it surfacing in the
// diffs, file listings, or commits the model produces. Codex's own process still reads/writes
// CODEX_HOME freely — it is not subject to the `workspace-write` sandbox policy — exactly as the
// device-auth flow does. Defense-in-depth, not a full seal: `workspace-write` does not sandbox
// reads, so an out-of-tree absolute path is harder to discover but not unreachable. The sandbox is
// per session, so a single fixed path cannot collide, and it persists across turns so
// `codex exec resume` can still read the session's rollout files.
const CODEX_SESSION_HOME = "/home/user/.opencompany/codex-session";
const CODEX_DIRECT_BASE_URL = "https://api.openai.com/v1";
const CODEX_DIRECT_API_KEY_ENV_VAR = "CODEX_API_KEY";
const BROKER_TOKEN_ENV_VAR = "OPENCOMPANY_LLM_BROKER_TOKEN";
const CODEX_TOOL_CALL_ID = "codex-session";
const CODEX_TOOL_NAME = "codex_session";

type CodexUserMessage = {
  id: string;
  content: string;
  modelMessage: unknown;
};

type CodexGitHubAuth = Awaited<ReturnType<typeof loadGitHubAuth>>;
type CodexCliSummary = ReturnType<ReturnType<typeof createCodexStreamAccumulator>["summary"]> & {
  brokered: boolean;
  subscriptionBacked: boolean;
};

function codexCliModelForSession(modelName: string, fallbackModel: string) {
  return codexCliModelNameForModelId(modelName) ?? fallbackModel;
}

function codexReasoningEffortForSession(value: string): CodexReasoningEffort {
  return isCodexReasoningEffort(value) ? value : "medium";
}

export async function runCodexTurn(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
}) {
  const ctx = createRunContext("runner.codex_turn", input);
  try {
    await traceBraintrust(
      {
        name: "runner.codex_turn",
        type: "task",
        tags: ["runner", "agent-session", "codex"],
        metadata: {
          run_type: "codex_turn",
          session_id: input.sessionId,
          message_id: input.messageId,
          run_lease_id: ctx.leaseId,
          runner_instance_id: input.env.instanceId,
        },
      },
      () => runCodexTurnWithContext(input, ctx),
    );
  } finally {
    await flushBraintrust();
  }
}

async function runCodexTurnWithContext(
  input: {
    sessionId: string;
    messageId: string;
    env: RunnerEnv;
    externalSignal?: AbortSignal;
  },
  ctx: ReturnType<typeof createRunContext>,
) {
  let assistantMessageId = newAgentSessionMessageId();
  let leaseAcquired = false;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let agentId: string | undefined;
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  let sandbox: SandboxHandle | null = null;
  let sandboxBilling: SandboxBillingSnapshot | null = null;
  let outcome = "unknown";
  let assistantMessageCreated = false;
  let assistantMessageCompleted = false;

  try {
    const row = await observeRunStep(ctx, "load_session", () => loadSession(input.sessionId));
    const agentConfig = normalizeAgentConfig(row.agent.config);
    workspaceId = row.workspace.id;
    userId = row.session.userId;
    agentId = row.agent.id;
    modelProvider = "openai";
    const codexModel = codexCliModelForSession(row.session.modelName, input.env.codexModel);
    modelName = row.session.modelName;

    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    if (row.session.engine !== "codex" || agentConfig.engine !== "codex") {
      throw new Error("Session is not configured for the Codex engine.");
    }

    if (
      !(await observeRunStep(ctx, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db: ctx.db, workspaceId: row.session.workspaceId }),
      ))
    ) {
      outcome = "skipped_no_credits";
      await setStatus(input.sessionId, "ready");
      await appendRuntimeEvent(ctx.db, {
        sessionId: input.sessionId,
        type: "session.status",
        payload: { status: "ready", message: "Add workspace credits to continue running agents." },
      });
      return;
    }

    const userMessage = await observeRunStep(ctx, "load_user_message", () =>
      loadUserMessage(input.sessionId, input.messageId),
    );
    if (!userMessage) {
      outcome = "skipped_missing_user_message";
      return;
    }

    const codexUserMessage = await observeRunStep(ctx, "load_codex_user_message", () =>
      loadCodexUserMessage(input.sessionId, input.messageId),
    );
    if (!codexUserMessage) {
      outcome = "skipped_missing_user_message";
      return;
    }

    const attachmentCount = await observeRunStep(ctx, "count_message_attachments", () =>
      countMessageAttachments(input.sessionId, input.messageId),
    );
    if (attachmentCount > 0) {
      throw new Error("Codex sessions do not support attachments yet.");
    }

    const existingAssistantResponse = await observeRunStep(
      ctx,
      "load_existing_assistant_response",
      () => loadAssistantResponseForMessage(input.sessionId, input.messageId),
    );
    if (existingAssistantResponse?.status === "completed") {
      outcome = "skipped_duplicate";
      return;
    }
    if (existingAssistantResponse) {
      assistantMessageId = existingAssistantResponse.id;
    }

    const lease = await observeRunStep(ctx, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: input.messageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        modelProvider: "openai",
        modelName: row.session.modelName,
      }),
    );
    if (!lease) {
      outcome = "skipped_lease_busy";
      throw new RunLeaseBusyError();
    }

    leaseAcquired = true;
    setActiveRun(input.sessionId, ctx.leaseId, ctx.leaseOwner, ctx.controller);
    const checkAbort = createLeaseAbortCheck(ctx);
    await observeRunStep(ctx, "initial_run_control_check", () => checkAbort({ force: true }));

    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.status",
        payload: { status: "running", message: "Codex is running" },
      }),
    );

    const assistantCreated = await observeRunStep(ctx, "create_assistant_message", () =>
      createAssistantMessageForLease({
        id: assistantMessageId,
        sessionId: input.sessionId,
        responseToMessageId: input.messageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
      }),
    );
    if (!assistantCreated) {
      outcome = "skipped_assistant_exists";
      await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
      return;
    }
    assistantMessageCreated = true;

    await appendCodexActivity({
      ctx,
      assistantMessageId,
      status: "running",
      activity: "Codex is starting",
    });

    sandbox = await observeRunStep(ctx, "acquire_codex_sandbox", () =>
      acquireCodexSandboxForTurn(row, input.env),
    );
    await checkAbort();
    const updatedSandbox = await observeRunStep(ctx, "update_sandbox_for_lease", () =>
      updateSandboxForLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, sandbox!.sandboxId),
    );
    if (!updatedSandbox) {
      await killSandbox(sandbox.sandboxId);
      sandbox = null;
      throw new StaleRunLeaseError();
    }
    const billing = resolveSandboxBilling(row, input.env);
    sandboxBilling = {
      sandboxId: sandbox.sandboxId,
      hydratedAt: new Date(),
      template: billing.template,
      vcpu: billing.vcpu,
      ramMib: billing.ramMib,
    };

    const githubAuth = await observeRunStep(ctx, "load_github_auth", () =>
      loadGitHubAuth(row.workspace.id),
    );
    const task = buildCodexTask({
      agentInstructions: agentConfig.instructions,
      userMessage: codexUserMessage,
      hasGitHubAuth: Boolean(githubAuth.githubToken),
    });
    const summary = await runCodexCli({
      ctx,
      sandbox,
      row,
      task,
      model: codexModel,
      reasoningEffort: codexReasoningEffortForSession(row.session.codexReasoningEffort),
      planModeReasoningEffort: row.session.codexPlanModeEnabled
        ? codexReasoningEffortForSession(row.session.codexPlanModeReasoningEffort)
        : null,
      existingEngineSessionId: row.session.engineSessionId,
      assistantMessageId,
      checkAbort,
      env: input.env,
      githubAuth,
    });

    const codexSessionId = resumableCodexSessionId(summary);
    if (codexSessionId) {
      await observeRunStep(ctx, "persist_codex_session_id", () =>
        persistEngineSessionIdForLease({
          sessionId: input.sessionId,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          engineSessionId: codexSessionId,
        }),
      );
    }

    const usage = codexHostedToolUsage({
      model: codexModel,
      summary,
      brokered: summary.brokered,
      subscriptionBacked: summary.subscriptionBacked,
    });
    if (usage) {
      await observeRunStep(ctx, "record_codex_usage", () =>
        recordToolUsage({
          sessionId: input.sessionId,
          assistantMessageId,
          runLeaseId: ctx.leaseId,
          runLeaseOwner: ctx.leaseOwner,
          toolCallId: CODEX_TOOL_CALL_ID,
          toolName: CODEX_TOOL_NAME,
          usage,
        }),
      );
    }

    const assistantContent = codexAssistantContent(summary);
    const modelMessage = { role: "assistant", content: [{ type: "text", text: assistantContent }] };
    await observeRunStep(ctx, "complete_assistant_message", () =>
      completeAssistantMessageForLease({
        sessionId: input.sessionId,
        assistantMessageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        content: assistantContent,
        modelMessage,
      }),
    );
    assistantMessageCompleted = true;
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "message.completed",
        payload: {
          messageId: assistantMessageId,
          content: assistantContent,
          modelMessage,
        },
      }),
    );

    if (summary.status !== "success") {
      const message = summary.error ?? "Codex failed before finishing.";
      await appendCodexActivity({ ctx, assistantMessageId, status: "failed", activity: message });
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "session.error",
          payload: { message },
        }),
      );
      await recordSandboxUsageBestEffort({ ctx, assistantMessageId, sandboxBilling });
      await failRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "failed", message);
      outcome = "failed";
      return;
    }

    await appendCodexActivity({
      ctx,
      assistantMessageId,
      status: "completed",
      activity: "Codex completed",
    });
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.status",
        payload: { status: "completed", message: "Codex completed" },
      }),
    );
    await recordSandboxUsageBestEffort({ ctx, assistantMessageId, sandboxBilling });
    await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
    outcome = "completed";
    logger.info("Codex session completed", {
      event: "opencompany.runner_codex_turn_completed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      codex_session_id: summary.sessionId,
      sandbox_id: sandbox.sandboxId,
      model_name: modelName,
    });
  } catch (error) {
    if (error instanceof RunLeaseBusyError) throw error;
    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      return;
    }
    if (ctx.controller.signal.aborted || error instanceof RunAbortError) {
      outcome = "aborted";
      if (leaseAcquired) {
        await failRunLease(
          input.sessionId,
          ctx.leaseId,
          ctx.leaseOwner,
          "aborting",
          "Run aborted.",
        );
      }
      logger.info("Codex session aborted", {
        event: "opencompany.runner_codex_turn_aborted",
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        session_id: input.sessionId,
        message_id: input.messageId,
        assistant_message_id: assistantMessageId,
        sandbox_id: sandbox?.sandboxId,
        model_name: modelName,
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown Codex runner error";
    captureException(error, {
      event: "opencompany.runner_codex_turn_failed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandbox?.sandboxId,
      model_name: modelName,
    });
    if (leaseAcquired) {
      if (assistantMessageCreated && !assistantMessageCompleted) {
        await finalizeFailedCodexAssistantBestEffort({
          ctx,
          sessionId: input.sessionId,
          assistantMessageId,
          message,
        });
      }
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.error",
        payload: { message },
      });
      const updated = await failRunLease(
        input.sessionId,
        ctx.leaseId,
        ctx.leaseOwner,
        "failed",
        message,
      );
      if (!updated && (await isSessionArchived(input.sessionId))) return;
    }
    outcome = "failed";
    logger.error("Codex session failed", {
      event: "opencompany.runner_codex_turn_failed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandbox?.sandboxId,
      model_name: modelName,
      error,
    });
    throw leaseAcquired ? new MessageTurnFailedError(error) : error;
  } finally {
    await finalizeRun({
      ctx,
      outcome,
      modelProvider,
      modelName,
      sandbox,
    });
  }
}

async function runCodexCli(input: {
  ctx: ReturnType<typeof createRunContext>;
  sandbox: SandboxHandle;
  row: Awaited<ReturnType<typeof loadSession>>;
  task: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  planModeReasoningEffort: CodexReasoningEffort | null;
  existingEngineSessionId: string | null;
  assistantMessageId: string;
  checkAbort: ReturnType<typeof createLeaseAbortCheck>;
  env: RunnerEnv;
  githubAuth: CodexGitHubAuth;
}): Promise<CodexCliSummary> {
  const runWithAuth = async (auth: CodexCliAuth) => {
    const layout = sandboxLayout(input.row.session.workdir, input.row.agent.isDefault);
    const serializedAuthJson = auth.kind === "chatgpt" ? JSON.stringify(auth.authJson) : null;
    const redact = createKnownSecretRedactor([
      auth.kind === "api" ? auth.apiKeyValue : null,
      serializedAuthJson,
      input.env.openaiCodexApiKey,
      input.githubAuth.githubToken,
      input.githubAuth.githubAuthHeader,
    ]);
    const commandPlan = buildCodexSessionCommandPlan({
      workRoot: layout.workRoot,
      task: input.task,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      planModeReasoningEffort: input.planModeReasoningEffort,
      existingEngineSessionId: input.existingEngineSessionId,
      auth,
      githubAuth: input.githubAuth,
    });

    await ensureCodexInstalled(input.sandbox);
    await input.sandbox.commands.run(
      `mkdir -p ${shellQuote(commandPlan.codexWorkRoot)} ${shellQuote(commandPlan.codexHome)}`,
      { timeoutMs: 30_000 },
    );
    await input.sandbox.files.write(`${commandPlan.codexHome}/config.toml`, commandPlan.config);
    if (serializedAuthJson) {
      await input.sandbox.files.write(`${commandPlan.codexHome}/auth.json`, serializedAuthJson);
    }

    const stream = createCodexStreamAccumulator();
    let timedOut = false;
    let result: { stdout?: unknown; stderr?: unknown; exitCode?: number | null };
    const guardedRun = guardCommandStreamCallbacks({
      envs: commandPlan.codexEnv,
      timeoutMs: input.env.codexTimeoutMs,
      onStdout: async (data: string) => {
        const activity = stream.push(redact(data));
        await appendCodexRuntimeEvents({
          ctx: input.ctx,
          assistantMessageId: input.assistantMessageId,
          events: stream.drainEvents(),
        });
        if (activity) {
          await appendCodexActivity({
            ctx: input.ctx,
            assistantMessageId: input.assistantMessageId,
            status: "running",
            activity: truncateText(activity.trim(), 500),
          });
        }
      },
    });

    result = await withRunControlChecks(input.checkAbort, async () => {
      try {
        return await input.sandbox.commands.run(commandPlan.command, guardedRun.options);
      } catch (error) {
        const exitResult = commandExitResult(error);
        if (exitResult) return exitResult;
        if (isCommandTimeoutError(error)) {
          timedOut = true;
          await appendCodexActivity({
            ctx: input.ctx,
            assistantMessageId: input.assistantMessageId,
            status: "running",
            activity: "Codex timed out while collecting partial output",
          });
          return { stdout: "", stderr: "", exitCode: null };
        }
        throw error;
      } finally {
        await guardedRun.rethrow();
      }
    });

    stream.finish();
    await appendCodexRuntimeEvents({
      ctx: input.ctx,
      assistantMessageId: input.assistantMessageId,
      events: stream.drainEvents(),
    });
    const summary = stream.summary({
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      stdout: redact(String(result.stdout ?? "")),
      stderr: redact(String(result.stderr ?? "")),
      timedOut,
    });
    await persistRefreshedWorkspaceCodexAuth({
      sandbox: input.sandbox,
      codexHome: commandPlan.codexHome,
      workspaceId: input.row.workspace.id,
      auth,
    });
    return { ...summary, brokered: auth.brokered, subscriptionBacked: auth.kind === "chatgpt" };
  };

  const workspaceCodexAuth = await loadWorkspaceCodexCliAuth(input.row.workspace.id);
  if (workspaceCodexAuth) return runWithAuth(workspaceCodexAuth);

  if (!codexApiKeyFallbackEnabled()) {
    throw new Error("Connect Codex in company settings before running Codex sessions.");
  }

  if (brokerActive(input.env) && input.env.publicUrl) {
    return withBrokerDelegation(
      {
        sessionId: input.ctx.sessionId,
        workspaceId: input.row.workspace.id,
        messageId: input.assistantMessageId,
        toolCallId: CODEX_TOOL_CALL_ID,
        toolName: CODEX_TOOL_NAME,
        provider: "openai",
        ttlMs: input.env.codexTimeoutMs + 10 * 60 * 1000,
      },
      (minted) =>
        runWithAuth({
          kind: "api",
          baseUrl: brokerBaseUrl(input.env.publicUrl as string, "openai"),
          apiKeyEnvVar: BROKER_TOKEN_ENV_VAR,
          apiKeyValue: minted.token,
          brokered: true,
        }),
    );
  }

  if (!input.env.openaiCodexApiKey) {
    throw new Error("OPENAI_CODEX_API_KEY is required to run Codex sessions.");
  }
  return runWithAuth({
    kind: "api",
    baseUrl: CODEX_DIRECT_BASE_URL,
    apiKeyEnvVar: CODEX_DIRECT_API_KEY_ENV_VAR,
    apiKeyValue: input.env.openaiCodexApiKey,
    brokered: false,
  });
}

export function buildCodexSessionCommandPlan(input: {
  workRoot: string;
  task: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort | null;
  planModeReasoningEffort?: CodexReasoningEffort | null;
  existingEngineSessionId: string | null;
  auth: CodexCliAuth;
  githubAuth: CodexGitHubAuth;
}) {
  const codexWorkRoot = buildCodexWorkRoot(input.workRoot);
  const codexHome = CODEX_SESSION_HOME;
  const codexEnv = {
    CODEX_HOME: codexHome,
    ...(input.auth.kind === "api" ? { [input.auth.apiKeyEnvVar]: input.auth.apiKeyValue } : {}),
    ...(input.githubAuth.githubToken && input.githubAuth.githubAuthHeader
      ? buildGitHubCommandEnv({
          githubAuthHeader: input.githubAuth.githubAuthHeader,
          githubToken: input.githubAuth.githubToken,
          toolCallId: CODEX_TOOL_CALL_ID,
        })
      : {}),
  };
  const command = [
    `cd ${shellQuote(codexWorkRoot)}`,
    `export PATH=${CODEX_BIN_PATH}:"$PATH"`,
    buildCodexCommand({
      task: input.task,
      workRoot: codexWorkRoot,
      model: input.model,
      sessionId: input.existingEngineSessionId,
      reasoningEffort: input.reasoningEffort ?? null,
      planModeReasoningEffort: input.planModeReasoningEffort ?? null,
    }),
  ].join(" && ");

  return {
    codexWorkRoot,
    codexHome,
    codexEnv,
    command,
    config: buildCodexConfigForAuth(input.auth),
  };
}

async function loadCodexUserMessage(
  sessionId: string,
  messageId: string,
): Promise<CodexUserMessage | null> {
  const [message] = await getDb()
    .select({
      id: agentSessionMessages.id,
      content: agentSessionMessages.content,
      modelMessage: agentSessionMessages.modelMessage,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.id, messageId),
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.role, "user"),
        eq(agentSessionMessages.internal, false),
      ),
    )
    .limit(1);
  return message ?? null;
}

async function countMessageAttachments(sessionId: string, messageId: string) {
  const rows = await getDb()
    .select({ id: agentSessionMessageAttachments.id })
    .from(agentSessionMessageAttachments)
    .where(
      and(
        eq(agentSessionMessageAttachments.sessionId, sessionId),
        eq(agentSessionMessageAttachments.messageId, messageId),
      ),
    )
    .limit(1);
  return rows.length;
}

async function loadGitHubAuth(workspaceId: string) {
  const installation = await loadConnectedGitHubInstallation(workspaceId);
  if (!installation) return { githubToken: null, githubAuthHeader: null };
  const githubToken = await getGitHubWorkInstallationToken({
    installationId: installation.installationId,
  });
  return {
    githubToken,
    githubAuthHeader: githubToken ? gitAuthHeader(githubToken) : null,
  };
}

async function persistEngineSessionIdForLease(input: {
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
  engineSessionId: string;
}) {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ engineSessionId: input.engineSessionId, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.runLeaseId, input.leaseId),
        eq(agentSessions.runLeaseOwner, input.leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .returning({ id: agentSessions.id });
  await requireLeaseWrite(Boolean(updated));
}

async function appendCodexActivity(input: {
  ctx: ReturnType<typeof createRunContext>;
  assistantMessageId: string;
  status: "running" | "completed" | "failed";
  activity?: string;
}) {
  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.ctx.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.ctx.leaseId,
      leaseOwner: input.ctx.leaseOwner,
      type: "engine.activity",
      payload: {
        messageId: input.assistantMessageId,
        engine: "codex",
        label: "Codex",
        status: input.status,
        ...(input.activity ? { activity: truncateText(input.activity, 500) } : {}),
      },
    }),
  );
}

async function appendCodexRuntimeEvents(input: {
  ctx: ReturnType<typeof createRunContext>;
  assistantMessageId: string;
  events: Record<string, unknown>[];
}) {
  for (const event of input.events) {
    for (const runtimeEvent of codexRuntimeEventsFromJsonEvent(event, input.assistantMessageId)) {
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.ctx.sessionId,
          messageId: input.assistantMessageId,
          leaseId: input.ctx.leaseId,
          leaseOwner: input.ctx.leaseOwner,
          ...runtimeEvent,
        }),
      );
    }
  }
}

function buildCodexTask(input: {
  agentInstructions: string;
  userMessage: CodexUserMessage;
  hasGitHubAuth: boolean;
}) {
  const userPrompt =
    modelMessageContent(input.userMessage.modelMessage) ?? input.userMessage.content;
  return [
    "You are running inside an OpenCompany Codex-backed session.",
    "Start in an empty work area. Do not assume any repository has already been cloned.",
    input.hasGitHubAuth
      ? "GitHub authentication is available through GH_TOKEN and git HTTPS extraheader auth. Do not rely on GH_REPO."
      : "No workspace GitHub installation token is available. Public repositories may still be cloned if needed.",
    "Use the user's request to decide whether and what repository to clone or inspect.",
    "",
    "Agent instructions:",
    input.agentInstructions.trim() || "No additional agent instructions.",
    "",
    "User request:",
    userPrompt.trim() || input.userMessage.content.trim(),
  ].join("\n");
}

function modelMessageContent(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const content = (value as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function codexAssistantContent(input: {
  status: "success" | "error" | "timeout" | "unknown";
  result: string;
  error: string | null;
}) {
  const result = input.result.trim();
  if (input.status === "success") {
    return result || "Codex completed.";
  }
  const error = input.error ?? "Codex failed before finishing.";
  return result ? `${result}\n\nCodex error: ${error}` : `Codex error: ${error}`;
}

// The engine session id is persisted whenever Codex produced one, regardless of turn status: a
// failed or timed-out turn still leaves a resumable Codex thread (partial rollout), so the user's
// next message continues the same context instead of starting cold.
export function resumableCodexSessionId(input: Pick<CodexCliSummary, "sessionId">) {
  return input.sessionId;
}

async function finalizeFailedCodexAssistantBestEffort(input: {
  ctx: ReturnType<typeof createRunContext>;
  sessionId: string;
  assistantMessageId: string;
  message: string;
}) {
  try {
    const content = codexAssistantContent({
      status: "error",
      result: "",
      error: input.message,
    });
    const modelMessage = { role: "assistant", content: [{ type: "text", text: content }] };
    await completeAssistantMessageForLease({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      leaseId: input.ctx.leaseId,
      leaseOwner: input.ctx.leaseOwner,
      content,
      modelMessage,
    });
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.ctx.leaseId,
        leaseOwner: input.ctx.leaseOwner,
        type: "message.completed",
        payload: {
          messageId: input.assistantMessageId,
          content,
          modelMessage,
        },
      }),
    );
    await appendCodexActivity({
      ctx: input.ctx,
      assistantMessageId: input.assistantMessageId,
      status: "failed",
      activity: input.message,
    });
  } catch (finalizeError) {
    if (finalizeError instanceof StaleRunLeaseError || finalizeError instanceof RunLeaseLostError) {
      return;
    }
    logger.warn("Failed to finalize Codex assistant after runner error", {
      event: "opencompany.runner_codex_turn_finalize_failed",
      session_id: input.sessionId,
      assistant_message_id: input.assistantMessageId,
      error: finalizeError,
    });
  }
}

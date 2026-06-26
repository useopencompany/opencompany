import {
  codexCliModelNameForModelId,
  isCodexReasoningEffort,
  newAgentSessionMessageId,
  normalizeAgentConfig,
  shellQuote,
} from "@opencompany/agent-runtime";
import type { CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { flushBraintrust, traceBraintrust } from "@opencompany/observability/braintrust";
import { and, eq, isNull } from "drizzle-orm";
import { setActiveRun } from "./active-runs";
import { loadConnectedGitHubInstallation } from "./amp-tool";
import { type CodexAppServerSummary, runCodexAppServerTurn } from "./codex-app-server";
import {
  type CodexAttachment,
  materializeCodexAttachmentsForSession,
} from "./codex-attachment-materialize";
import {
  type CodexCliAuth,
  codexApiKeyFallbackEnabled,
  codexHostedToolUsage,
  codexRuntimeEventsFromJsonEvent,
  ensureCodexInstalled,
  loadWorkspaceCodexCliAuth,
  persistRefreshedWorkspaceCodexAuth,
} from "./codex-tool";
import { createKnownSecretRedactor, gitAuthHeader, truncateText } from "./coding-agent-shared";
import { getDb } from "./db";
import { completeDelegatedChildRunForParent } from "./delegation";
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
import { RunAbortError, RunLeaseBusyError, RunLeaseLostError } from "./run-control";
import { MessageTurnFailedError } from "./runner-errors";
import { commandExitResult, killSandbox, type SandboxHandle, sandboxLayout } from "./sandbox";
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

// CODEX_HOME for session runs lives OUTSIDE the work root the model operates in (Codex is
// launched with `--cd ${codexWorkRoot}`). It must still be user-writable because Codex refreshes
// file-backed ChatGPT credentials during runs, so it intentionally does not live under the
// root-owned OpenCompany metadata directory at `/home/user/.opencompany`.
const CODEX_SESSION_HOME = "/home/user/.opencompany-codex/session";
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
type CodexSessionSummary = CodexAppServerSummary & {
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
  // A delegated (source="agent") codex child: at run end it rolls usage up to the parent and wakes
  // a parent parked awaiting it. Fired from finally so every exit path (success/fail/abort) covers
  // it once the session status is durably terminal.
  let delegatedChildRun = false;

  try {
    const row = await observeRunStep(ctx, "load_session", () => loadSession(input.sessionId));
    const agentConfig = normalizeAgentConfig(row.agent.config);
    delegatedChildRun = row.session.source === "agent";
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
    const planModeReasoningEffort = row.session.codexPlanModeEnabled
      ? codexReasoningEffortForSession(row.session.codexPlanModeReasoningEffort)
      : null;
    if (row.session.codexPlanModeEnabled) {
      await observeRunStep(ctx, "consume_codex_plan_mode", () =>
        consumeCodexPlanModeForLease({
          sessionId: input.sessionId,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
        }),
      );
    }

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
    const attachments = await observeRunStep(ctx, "materialize_codex_attachments", () =>
      materializeCodexAttachmentsForSession({
        sandbox: sandbox!,
        sessionId: input.sessionId,
        messageId: input.messageId,
        workdir: row.session.workdir,
        blobToken: input.env.blobReadWriteToken,
      }),
    );
    const task = buildCodexTask({
      agentInstructions: agentConfig.instructions,
      userMessage: codexUserMessage,
      hasGitHubAuth: Boolean(githubAuth.githubToken),
      attachments,
    });
    const summary = await runCodexAppServerSession({
      ctx,
      sandbox,
      row,
      task,
      model: codexModel,
      reasoningEffort: codexReasoningEffortForSession(row.session.codexReasoningEffort),
      planModeReasoningEffort,
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
    if (delegatedChildRun) {
      await completeDelegatedChildRunForParent({ childSessionId: input.sessionId }).catch(() => {
        // Best-effort: the backstop sweep re-wakes the parent if this parent-notify is lost.
      });
    }
  }
}

async function runCodexAppServerSession(input: {
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
}): Promise<CodexSessionSummary> {
  const runWithAuth = async (auth: CodexCliAuth) => {
    const layout = sandboxLayout(input.row.session.workdir, input.row.agent.isDefault);
    const codexWorkRoot = layout.codexRoot;
    const codexHome = CODEX_SESSION_HOME;
    const serializedAuthJson = auth.kind === "chatgpt" ? JSON.stringify(auth.authJson) : null;
    const redact = createKnownSecretRedactor([
      auth.kind === "api" ? auth.apiKeyValue : null,
      serializedAuthJson,
      input.env.openaiCodexApiKey,
      input.githubAuth.githubToken,
      input.githubAuth.githubAuthHeader,
    ]);

    await runCodexCommandStage("CLI setup", redact, () => ensureCodexInstalled(input.sandbox));
    await runCodexCommandStage("workspace setup", redact, () =>
      input.sandbox.commands.run(
        [
          `mkdir -p ${shellQuote(codexWorkRoot)} ${shellQuote(codexHome)}`,
          `chmod 700 ${shellQuote(codexHome)}`,
        ].join(" && "),
        { timeoutMs: 30_000 },
      ),
    );
    if (serializedAuthJson) {
      await input.sandbox.files.write(`${codexHome}/auth.json`, serializedAuthJson);
    }

    const summary = await runCodexAppServerTurn({
      sandbox: input.sandbox,
      codexWorkRoot,
      codexHome,
      task: input.task,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      planModeReasoningEffort: input.planModeReasoningEffort,
      existingEngineSessionId: input.existingEngineSessionId,
      auth,
      githubAuth: input.githubAuth,
      timeoutMs: input.env.codexTimeoutMs,
      checkAbort: input.checkAbort,
      onRuntimeEvents: async (events) =>
        appendCodexRuntimeEvents({
          ctx: input.ctx,
          assistantMessageId: input.assistantMessageId,
          events: events.map((event) => redactJsonEvent(event, redact)),
        }),
      onActivity: async (activity) =>
        appendCodexActivity({
          ctx: input.ctx,
          assistantMessageId: input.assistantMessageId,
          status: "running",
          activity: truncateText(redact(activity.trim()), 500),
        }),
    });
    await persistRefreshedWorkspaceCodexAuth({
      sandbox: input.sandbox,
      codexHome,
      workspaceId: input.row.workspace.id,
      auth,
    });
    return {
      ...summary,
      result: redact(summary.result),
      error: summary.error ? redact(summary.error) : null,
      brokered: auth.brokered,
      subscriptionBacked: auth.kind === "chatgpt",
    };
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

async function runCodexCommandStage<T>(
  stage: string,
  redact: (value: string) => string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const exitResult = commandExitResult(error);
    if (!exitResult) throw error;
    throw new Error(formatCodexCommandStageFailure(stage, exitResult, redact), { cause: error });
  }
}

function formatCodexCommandStageFailure(
  stage: string,
  result: { exitCode: number; stdout: string; stderr: string },
  redact: (value: string) => string,
) {
  const details = [
    result.stderr.trim() ? `stderr: ${redact(result.stderr.trim())}` : null,
    result.stdout.trim() ? `stdout: ${redact(result.stdout.trim())}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const suffix = details ? `\n${truncateText(details, 2_000)}` : "";
  return `Codex ${stage} failed with exit code ${result.exitCode}.${suffix}`;
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

export async function consumeCodexPlanModeForLease(input: {
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
}) {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ codexPlanModeEnabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.runLeaseId, input.leaseId),
        eq(agentSessions.runLeaseOwner, input.leaseOwner),
        eq(agentSessions.codexPlanModeEnabled, true),
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

function redactJsonEvent(event: Record<string, unknown>, redact: (value: string) => string) {
  try {
    return JSON.parse(redact(JSON.stringify(event))) as Record<string, unknown>;
  } catch {
    return event;
  }
}

function buildCodexTask(input: {
  agentInstructions: string;
  userMessage: CodexUserMessage;
  hasGitHubAuth: boolean;
  attachments?: CodexAttachment[];
}) {
  const userPrompt =
    modelMessageContent(input.userMessage.modelMessage) ?? input.userMessage.content;
  const attachmentLines =
    input.attachments && input.attachments.length > 0
      ? [
          "",
          "Attached files:",
          ...input.attachments.map(
            (attachment, index) =>
              `${index + 1}. ${attachment.filename} (${attachment.kind}, ${attachment.mediaType}) at ${attachment.path}`,
          ),
          "Use these local file paths when the request depends on the attached content.",
        ]
      : [];
  return [
    "You are running inside an OpenCompany Codex-backed session.",
    "Start in an empty work area. Do not assume any repository has already been cloned.",
    input.hasGitHubAuth
      ? "GitHub authentication is available through GH_TOKEN and git HTTPS extraheader auth. Do not rely on GH_REPO."
      : "No workspace GitHub installation token is available. Public repositories may still be cloned if needed.",
    "Use the user's request to decide whether and what repository to clone or inspect.",
    "When the user asks you to start a background or long-running process that should survive future turns, detach it from the command shell, for example `nohup setsid <command> >/tmp/<name>.log 2>&1 < /dev/null & echo $!`. Do not report transient shell job ids from plain `<command> &` as durable process ids.",
    "",
    "Agent instructions:",
    input.agentInstructions.trim() || "No additional agent instructions.",
    "",
    "User request:",
    userPrompt.trim() || input.userMessage.content.trim(),
    ...attachmentLines,
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
export function resumableCodexSessionId(input: Pick<CodexSessionSummary, "sessionId">) {
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

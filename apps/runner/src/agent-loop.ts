import {
  BUILTIN_USE_TOOL_NAME,
  newAgentSessionMessageId,
  normalizeAgentConfig,
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  RUNTIME_TOOL_DEFINITIONS,
  type RuntimeToolDefinition,
  type RuntimeToolName,
  resolveAgentRuntimeConfig,
} from "@opencompany/agent-runtime";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { agentSessionMessages } from "@opencompany/db/schema";
import {
  captureException,
  createLogger,
  startTimingTrace,
  timeAsync,
} from "@opencompany/observability";
import {
  type BraintrustSpan,
  flushBraintrust,
  logBraintrustCurrentSpan,
  logBraintrustSpan,
  traceBraintrust,
  traceBraintrustStep,
} from "@opencompany/observability/braintrust";
import type { ModelMessage } from "ai";
import { asc, eq } from "drizzle-orm";
import { setActiveRun } from "./active-runs";
import { syncAgentBundleFromSandbox } from "./agent-bundle";
import { hydrateMessageAttachments } from "./attachment-hydration";
import { syncBrainFromSandbox } from "./brain";
import { createAgentDelegationHandler } from "./delegation";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { validateHostedToolEnvironment } from "./hosted-tools";
import {
  acquireRunLease,
  appendRuntimeEventForLease,
  createAssistantMessageForLease,
  failRunLease,
  insertToolMessageForLease,
  releaseRunLease,
  requireLeaseWrite,
  StaleRunLeaseError,
  suspendRunLease,
  updateSandboxForLease,
} from "./lease-writes";
import { createMcpToolSet } from "./mcp-tools";
import {
  appendAssistantTextPart,
  buildModelMessages,
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";
import {
  assertTurnComplete,
  detectIncompleteTurn,
  isToolStepLimitExceeded,
  persistAssistantCompletion,
  streamAssistantResponse,
} from "./model-turn";
import {
  braintrustError,
  captureTurnCompletedAnalytics,
  createLeaseAbortCheck,
  createRunContext,
  finalizeRun,
  observeRunStep,
  type RunContext,
  recordSandboxUsageBestEffort,
  type SandboxBillingSnapshot,
} from "./run-context";
import {
  RunAbortError,
  type RunControlCheck,
  RunLeaseBusyError,
  RunLeaseLostError,
} from "./run-control";
import { MessageTurnFailedError, RunSuspendedError } from "./runner-errors";
import { killSandbox, type SandboxHandle } from "./sandbox";
import {
  appendAfterSessionSkipped,
  buildAfterSessionPrompt,
  completeAfterSessionRun,
  createAfterSessionRun,
  ensureSandbox,
  isSessionArchived,
  type LoadedSession,
  loadAssistantResponseForMessage,
  loadLatestUserMessage,
  loadNextSteerMessage,
  loadSession,
  loadUserMessage,
  optionalUserContext,
  resolveSandboxBilling,
  setStatus,
} from "./session-lifecycle";
import {
  buildQuestionAnswerToolOutput,
  buildUnansweredQuestionToolOutput,
  loadSessionQuestion,
} from "./session-questions";
import { loadToolApproval } from "./tool-approvals";
import {
  createHostedToolBudget,
  createToolSet,
  dispatchBuiltinUseTool,
  executeRuntimeTool,
  persistDeniedToolResult,
} from "./tool-dispatcher";
import { loadWorkspaceToolPolicy } from "./tool-policies";
import { createToolStartCoordinator } from "./tool-start-coordinator";

export {
  buildAmpCommand,
  buildAmpCommandEnv,
  createAmpActivityFormatter,
  createAmpStreamAccumulator,
  createKnownSecretRedactor,
  selectPublishBranch,
} from "./amp-tool";
export { createAgentDelegationHandler } from "./delegation";
export {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
} from "./lease-writes";
export { collectAssistantStream } from "./model-stream-runner";
export { assertTurnComplete, MAX_MODEL_STEPS } from "./model-turn";
export { ToolStepLimitExceededError } from "./runner-errors";
export { abortSession, archiveSession, startSession } from "./session-lifecycle";
export {
  normalizeReasoningSummary,
  readReasoningTextDelta,
  throwIfStreamErrorPart,
} from "./stream-helpers";
export { createHostedToolBudget, executeRuntimeTool } from "./tool-dispatcher";
export { createToolStartCoordinator } from "./tool-start-coordinator";
export { recordStepUsage, recordToolUsage } from "./usage-recorder";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export async function runMessage(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
  delegationDepth?: number;
}) {
  // Each turn answers one user message under its own lease. A steer message sent
  // while a run was in flight is answered as the next turn, so every turn stays a
  // complete, idempotent pass through the existing path. See
  // docs/agent-turn-vocabulary.md.
  let messageId: string | undefined = input.messageId;
  while (messageId) {
    const result = await runMessageTurn({ ...input, messageId });
    messageId = result?.nextSteerMessageId;
  }
}

async function runMessageTurn(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
  delegationDepth?: number;
}): Promise<{ nextSteerMessageId?: string | undefined } | void> {
  const ctx = createRunContext("runner.run_message", input);
  try {
    return await traceBraintrust(
      {
        name: "runner.run_message",
        type: "task",
        tags: ["runner", "agent-session"],
        metadata: {
          run_type: "message",
          session_id: input.sessionId,
          message_id: input.messageId,
          run_lease_id: ctx.leaseId,
          runner_instance_id: input.env.instanceId,
          delegation_depth: input.delegationDepth ?? 0,
        },
      },
      (span) => runMessageWithContext(input, ctx, span),
    );
  } finally {
    // The runner is a long-lived worker, so the Braintrust background logger uses async flushing.
    // Flush after each run so the full trace — including spans whose output/usage/end are logged at
    // the very end of the run — is delivered promptly instead of lingering "in progress".
    await flushBraintrust();
  }
}

async function runMessageWithContext(
  input: {
    sessionId: string;
    messageId: string;
    env: RunnerEnv;
    externalSignal?: AbortSignal;
    delegationDepth?: number;
  },
  ctx: RunContext,
  braintrustSpan: BraintrustSpan | undefined,
) {
  let assistantMessageId = newAgentSessionMessageId();
  let leaseAcquired = false;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let agentId: string | undefined;
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  const sandboxRef: { id: string | undefined } = { id: undefined };
  let outcome = "unknown";
  let sandboxAcquirer: ReturnType<typeof createSandboxAcquirer> | undefined;
  let nextSteerMessageId: string | undefined;

  try {
    const row = await observeRunStep(ctx, "load_session", () => loadSession(input.sessionId));
    const agentConfig = normalizeAgentConfig(row.agent.config);
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    workspaceId = row.workspace.id;
    userId = row.session.userId;
    agentId = row.agent.id;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        agent_path: row.agent.path,
        session_status: row.session.status,
      },
    });

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
    logBraintrustSpan(braintrustSpan, {
      metadata: { assistant_message_id: assistantMessageId },
    });

    const suspendable = (input.delegationDepth ?? 0) === 0;
    const toolPolicy = await observeRunStep(ctx, "load_tool_policy", () =>
      loadWorkspaceToolPolicy(row.workspace.id),
    );
    const runtime = resolveAgentRuntimeConfig({
      agent: agentConfig,
      modelOverride: row.session.modelName ?? undefined,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserContext(row.user),
      toolPolicy: { policy: toolPolicy, suspendable },
    });
    modelProvider = runtime.model.provider;
    modelName = runtime.model.name;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        model_provider: modelProvider,
        model_name: modelName,
        enabled_tools: runtime.tools,
      },
    });

    const lease = await observeRunStep(ctx, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: input.messageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        modelProvider: runtime.model.provider,
        modelName: runtime.model.name,
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
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

    await requireLeaseWrite(
      timeAsync(ctx.trace, "append_running_status", () =>
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "session.status",
          payload: { status: "running", message: "Agent is running" },
        }),
      ),
    );
    logger.info("Runner session running", {
      event: "opencompany.runner_session_running",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      model_provider: modelProvider,
      model_name: modelName,
    });

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

    const storedMessages = await observeRunStep(ctx, "load_model_messages", () =>
      ctx.db
        .select()
        .from(agentSessionMessages)
        .where(eq(agentSessionMessages.sessionId, input.sessionId))
        .orderBy(asc(agentSessionMessages.createdAt)),
    );
    const visibleStoredMessages = await hydrateMessageAttachments(
      storedMessages.filter((message) => message.id !== assistantMessageId && !message.internal),
      { db: ctx.db, blobToken: ctx.env.blobReadWriteToken },
    );
    const messages = buildModelMessages(visibleStoredMessages);

    sandboxAcquirer = createSandboxAcquirer({
      row,
      env: input.env,
      trace: ctx.trace,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      checkAbort,
      onHydrated: (sandbox) => {
        sandboxRef.id = sandbox.sandboxId;
      },
    });

    // Warm the sandbox up front (non-blocking) so the create/connect + materialization
    // overlaps the model's first tokens instead of stalling the first tool call by ~10s.
    // Gated on the turn actually exposing sandbox tools; never billed or synced unless a
    // tool truly uses it (see createSandboxAcquirer / wasUsed).
    if (runtimeHasSandboxTools(runtime.tools)) {
      sandboxAcquirer.warm();
    }

    const toolStartCoordinator = createToolStartCoordinator();
    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      runLeaseId: ctx.leaseId,
      runLeaseOwner: ctx.leaseOwner,
      workspaceId: row.workspace.id,
      agentConfig,
      getSandbox: sandboxAcquirer.get,
      workdir: row.session.workdir,
      env: input.env,
      enabledTools: runtime.tools,
      repository: row.repository,
      signal: ctx.controller.signal,
      checkAbort,
      toolStartCoordinator,
      observabilityContext: { workspaceId, userId, agentId, modelProvider, modelName },
      toolBudget: createHostedToolBudget(),
      delegateToAgent: createAgentDelegationHandler({
        parentSessionId: input.sessionId,
        parentMessageId: assistantMessageId,
        parentRunLeaseId: ctx.leaseId,
        parentRunLeaseOwner: ctx.leaseOwner,
        workspaceId: row.workspace.id,
        userId: row.session.userId,
        env: input.env,
        signal: ctx.controller.signal,
        checkAbort,
        depth: input.delegationDepth ?? 0,
        agentReferences: agentConfig.agents ?? [],
        runChildMessage: runDelegatedChildMessage,
      }),
    });

    // A top-level run (user or scheduled) has a resumable session a human can approve in,
    // so its "ask" tool calls suspend durably. Delegated children have a parent blocking
    // on them and cannot pause, so their "ask" collapses to "deny" (resolved in
    // collectAssistantStream / resolveToolDecision).

    const turn = await executeStreamingTurn({
      ctx,
      row,
      runtime,
      system: runtime.systemPrompt,
      messages,
      tools,
      mcpContext: {
        workspaceId: row.workspace.id,
        agentConfig: row.agent.config,
        signal: ctx.controller.signal,
        checkAbort,
        observabilityContext: { workspaceId, userId, agentId, modelProvider, modelName },
      },
      assistantMessageId,
      toolStartCoordinator,
      checkAbort,
      policy: toolPolicy,
      suspendable,
      sandboxAcquirer,
      internal: false,
      brainStep: "sync_brain_after_message",
      bundleStep: "sync_agent_bundle_after_message",
      appendCompletedEvent: () =>
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "session.status",
          payload: { status: "completed", message: "Agent completed" },
        }),
      // Stop at the next model-step boundary if the user steered this run with a new
      // message. In-flight tool calls in the current step still finish and persist.
      extraStopConditions: [
        async () =>
          Boolean(
            await loadNextSteerMessage({
              sessionId: input.sessionId,
              afterCreatedAt: userMessage.createdAt,
            }),
          ),
      ],
    });
    if (turn.outcome === "suspended") {
      outcome = "suspended";
      return;
    }
    outcome = "completed";
    // If the user steered mid-run, answer that message as the next turn. The lease
    // is already released, so the next turn acquires its own. See
    // docs/agent-turn-vocabulary.md.
    const steer = await loadNextSteerMessage({
      sessionId: input.sessionId,
      afterCreatedAt: userMessage.createdAt,
    });
    nextSteerMessageId = steer?.id;
    logger.info("Runner session completed", {
      event: "opencompany.runner_session_completed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxRef.id,
      model_provider: modelProvider,
      model_name: modelName,
    });
    await observeRunStep(ctx, "capture_turn_analytics", () =>
      captureTurnCompletedAnalytics({
        ctx,
        userId,
        workspaceId,
        agentId,
        sessionId: input.sessionId,
        userMessageId: input.messageId,
        assistantMessageId,
        modelProvider,
        modelName,
      }).catch((error) => {
        logger.warn("Failed to capture turn analytics", {
          event: "opencompany.runner_turn_analytics_failed",
          workspace_id: workspaceId,
          user_id: userId,
          agent_id: agentId,
          session_id: input.sessionId,
          message_id: input.messageId,
          assistant_message_id: assistantMessageId,
          error,
        });
      }),
    );
  } catch (error) {
    if (error instanceof RunLeaseBusyError) {
      logBraintrustCurrentSpan({
        error: braintrustError(error),
        metadata: { outcome, assistant_message_id: assistantMessageId },
      });
      throw error;
    }

    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      logBraintrustCurrentSpan({
        error: braintrustError(error),
        metadata: { outcome, assistant_message_id: assistantMessageId },
      });
      return;
    }

    if (ctx.controller.signal.aborted || error instanceof RunAbortError) {
      outcome = "aborted";
      logBraintrustCurrentSpan({
        error: braintrustError(error),
        metadata: { outcome, assistant_message_id: assistantMessageId },
      });
      if (leaseAcquired) {
        await failRunLease(
          input.sessionId,
          ctx.leaseId,
          ctx.leaseOwner,
          "aborting",
          "Run aborted.",
        );
      }
      logger.info("Runner session aborted", {
        event: "opencompany.runner_session_aborted",
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        session_id: input.sessionId,
        message_id: input.messageId,
        assistant_message_id: assistantMessageId,
        sandbox_id: sandboxRef.id,
        model_provider: modelProvider,
        model_name: modelName,
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown runner error";
    logBraintrustCurrentSpan({
      error: braintrustError(error),
      metadata: {
        outcome: "failed",
        assistant_message_id: assistantMessageId,
        sandbox_id: sandboxRef.id,
      },
    });
    captureException(error, {
      event: "opencompany.runner_message_failed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxRef.id,
      model_provider: modelProvider,
      model_name: modelName,
    });
    if (leaseAcquired) {
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.error",
        payload: { message },
      });
    }
    const updated = leaseAcquired
      ? await failRunLease(
          input.sessionId,
          ctx.leaseId,
          ctx.leaseOwner,
          ctx.controller.signal.aborted ? "aborting" : "failed",
          message,
        )
      : false;
    if (!updated && (await isSessionArchived(input.sessionId))) return;
    outcome = "failed";
    logger.error("Runner session failed", {
      event: "opencompany.runner_session_failed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxRef.id,
      model_provider: modelProvider,
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
      // Await any in-flight warm-up so a warmed-but-unused sandbox is still parked
      // (idle timeout re-armed to 30s) rather than left on its 60-minute active timeout.
      sandbox: (await sandboxAcquirer?.settle()) ?? null,
    });
  }

  return { nextSteerMessageId };
}

// Persist a clean suspension point when a run unwinds at an "ask" gate, then park the
// session as `awaiting_approval` and release the lease. The partial assistant message
// (ending in the pending tool-call) is persisted from the error payload so the resume
// run can pair it with the tool-result. Brain is synced first so any allowed sibling
// tool call that mutated the sandbox before the gate is not lost when the sandbox is torn
// down (the resume run re-hydrates from brain).
async function suspendRunForInput(input: {
  ctx: RunContext;
  row: LoadedSession;
  sandbox: SandboxHandle | null;
  sandboxBilling: SandboxBillingSnapshot | null;
  assistantMessageId: string;
  error: RunSuspendedError;
}) {
  const { ctx, row, assistantMessageId, error } = input;

  if (input.sandbox) {
    const activeSandbox = input.sandbox;
    await observeRunStep(ctx, "sync_brain_before_suspend", () =>
      syncBrainFromSandbox({
        sandbox: activeSandbox,
        sessionId: ctx.sessionId,
        workspaceId: row.workspace.id,
        workdir: row.session.workdir,
      }),
    );
  }

  await persistAssistantCompletion({
    sessionId: ctx.sessionId,
    assistantMessageId,
    leaseId: ctx.leaseId,
    leaseOwner: ctx.leaseOwner,
    assistantContent: error.assistantContent,
    assistantReplayParts: error.assistantReplayParts,
    reasoningSummary: error.reasoningSummary,
    reasoningContent: error.reasoningContent,
    internal: false,
  });

  const status = error.reason === "question" ? "awaiting_input" : "awaiting_approval";
  const message = error.reason === "question" ? "Waiting for your answer" : "Waiting for approval";
  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: ctx.sessionId,
      messageId: null,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      type: "session.status",
      payload: { status, message },
    }),
  );
  // Bill the sandbox active window while the lease is still held (see executeStreamingTurn).
  await recordSandboxUsageBestEffort({
    ctx,
    assistantMessageId,
    sandboxBilling: input.sandboxBilling,
  });
  await requireLeaseWrite(suspendRunLease(ctx.sessionId, ctx.leaseId, ctx.leaseOwner, status));
}

// Shared "model turn" middle used by the message, after-session, and resume runs: stream the
// model (suspending durably at an "ask" gate when `suspendable`), sync brain, persist the
// assistant completion, emit the caller's completed event, and release the lease. Returns the
// outcome so the caller can run its own tail. The gating, lease acquisition, and per-run-type
// tail (steer chaining, analytics, after-session bookkeeping) stay in the callers, which is why
// those still differ between the three entry points.
async function executeStreamingTurn(input: {
  ctx: RunContext;
  row: LoadedSession;
  runtime: ReturnType<typeof resolveAgentRuntimeConfig>;
  system: string;
  messages: ModelMessage[];
  tools: ReturnType<typeof createToolSet>;
  mcpContext: Parameters<typeof streamAssistantResponse>[0]["mcpContext"];
  assistantMessageId: string;
  toolStartCoordinator: ReturnType<typeof createToolStartCoordinator>;
  checkAbort: RunControlCheck;
  policy: Awaited<ReturnType<typeof loadWorkspaceToolPolicy>>;
  suspendable: boolean;
  sandboxAcquirer: ReturnType<typeof createSandboxAcquirer>;
  internal: boolean;
  brainStep: string;
  bundleStep: string;
  appendCompletedEvent: () => Promise<boolean>;
  emptyOutputFallback?: string;
  beforeRelease?: () => Promise<void>;
  extraStopConditions?: Parameters<typeof streamAssistantResponse>[0]["extraStopConditions"];
}): Promise<{ outcome: "completed" | "suspended" }> {
  const { ctx, row, sandboxAcquirer, assistantMessageId } = input;

  let streamResult: Awaited<ReturnType<typeof streamAssistantResponse>>;
  try {
    streamResult = await streamAssistantResponse({
      ctx,
      runtime: input.runtime,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      mcpContext: input.mcpContext,
      assistantMessageId,
      toolStartCoordinator: input.toolStartCoordinator,
      checkAbort: input.checkAbort,
      policy: input.policy,
      suspendable: input.suspendable,
      ...(input.extraStopConditions ? { extraStopConditions: input.extraStopConditions } : {}),
    });
  } catch (error) {
    if (error instanceof RunSuspendedError) {
      // A suspension point fired: an "ask" approval gate (→ awaiting_approval) or an
      // ask_user_question call (→ awaiting_input). Persist the partial assistant turn (ending in
      // the pending tool-call), park the session, and release the lease. The run resumes in a
      // fresh resume_approval / resume_question job once decided. Only reachable when
      // `suspendable` is true.
      await suspendRunForInput({
        ctx,
        row,
        sandbox: sandboxAcquirer.current,
        sandboxBilling: sandboxAcquirer.billingSnapshot(),
        assistantMessageId,
        error,
      });
      return { outcome: "suspended" };
    }
    throw error;
  }

  let { assistantContent } = streamResult;
  const { assistantReplayParts, reasoningSummary, reasoningContent } = streamResult;

  if (sandboxAcquirer.wasUsed() && sandboxAcquirer.current) {
    const activeSandbox = sandboxAcquirer.current;
    await observeRunStep(ctx, input.brainStep, () =>
      syncBrainFromSandbox({
        sandbox: activeSandbox,
        sessionId: ctx.sessionId,
        workspaceId: row.workspace.id,
        workdir: row.session.workdir,
      }),
    );
    // Bundle sync is best-effort: a DB/GitHub failure here must not fail the
    // turn or drop the assistant response (persistAssistantCompletion runs
    // below). The next turn re-syncs from the sandbox.
    try {
      await observeRunStep(ctx, input.bundleStep, () =>
        syncAgentBundleFromSandbox({
          sandbox: activeSandbox,
          sessionId: ctx.sessionId,
          workspaceId: row.workspace.id,
          agentId: row.agent.id,
          workdir: row.session.workdir,
        }),
      );
    } catch (error) {
      logger.error("Agent bundle sync failed", {
        step: input.bundleStep,
        session_id: ctx.sessionId,
        workspace_id: row.workspace.id,
        agent_id: row.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await input.checkAbort({ force: true });

  let incompleteTurn: ReturnType<typeof detectIncompleteTurn> = null;
  const exceededToolStepLimit = isToolStepLimitExceeded(streamResult);
  if (input.emptyOutputFallback !== undefined) {
    if (!assistantContent && assistantReplayParts.length === 0) {
      assistantContent = input.emptyOutputFallback;
      appendAssistantTextPart(assistantReplayParts, assistantContent);
    }
  } else if (!exceededToolStepLimit) {
    assertTurnComplete(streamResult);
    // Only flag user-facing turns; internal after-session runs are exempt.
    if (!input.internal) incompleteTurn = detectIncompleteTurn(streamResult);
  }

  await persistAssistantCompletion({
    sessionId: ctx.sessionId,
    assistantMessageId,
    leaseId: ctx.leaseId,
    leaseOwner: ctx.leaseOwner,
    assistantContent,
    assistantReplayParts,
    reasoningSummary,
    reasoningContent,
    internal: input.internal,
  });

  if (input.emptyOutputFallback === undefined && exceededToolStepLimit) {
    assertTurnComplete(streamResult);
  }

  if (incompleteTurn) {
    // Surface the abandoned turn distinctly so unattended/scheduled runs don't
    // look cleanly green. We still complete the turn (failing would lose the
    // partial work and re-run side effects) — the distinct event + warning log
    // are the signal for observability and in-session review.
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: ctx.sessionId,
        messageId: assistantMessageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.incomplete",
        payload: { messageId: assistantMessageId, reason: incompleteTurn.reason },
      }),
    );
    logger.warn("Runner turn stopped mid-task", {
      event: "opencompany.runner_turn_incomplete",
      workspace_id: row.workspace.id,
      user_id: row.session.userId,
      agent_id: row.agent.id,
      session_id: ctx.sessionId,
      assistant_message_id: assistantMessageId,
      model_provider: input.runtime.model.provider,
      model_name: input.runtime.model.name,
      reason: incompleteTurn.reason,
      reason_detail: incompleteTurn.reasonDetail,
    });
  }

  await requireLeaseWrite(input.appendCompletedEvent());

  if (input.beforeRelease) await input.beforeRelease();

  // Bill the sandbox active window before releasing the lease: recordSandboxUsage is
  // lease-guarded, so it must run while we still own the lease (finalizeRun is too late).
  await recordSandboxUsageBestEffort({
    ctx,
    assistantMessageId,
    sandboxBilling: input.sandboxAcquirer.billingSnapshot(),
  });

  await requireLeaseWrite(releaseRunLease(ctx.sessionId, ctx.leaseId, ctx.leaseOwner, "completed"));

  return { outcome: "completed" };
}

export async function runAfterSession(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
}) {
  const ctx = createRunContext("runner.run_after_session", input);
  try {
    return await traceBraintrust(
      {
        name: "runner.run_after_session",
        type: "task",
        tags: ["runner", "after-session"],
        metadata: {
          run_type: "after_session",
          session_id: input.sessionId,
          message_id: input.messageId,
          run_lease_id: ctx.leaseId,
          runner_instance_id: input.env.instanceId,
        },
      },
      (span) => runAfterSessionWithContext(input, ctx, span),
    );
  } finally {
    await flushBraintrust();
  }
}

async function runAfterSessionWithContext(
  input: {
    sessionId: string;
    messageId: string;
    env: RunnerEnv;
    externalSignal?: AbortSignal;
  },
  ctx: RunContext,
  braintrustSpan: BraintrustSpan | undefined,
) {
  const assistantMessageId = newAgentSessionMessageId();
  let leaseAcquired = false;
  let afterSessionRunId: number | undefined;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let agentId: string | undefined;
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  const sandboxRef: { id: string | undefined } = { id: undefined };
  let outcome = "unknown";
  let sandboxAcquirer: ReturnType<typeof createSandboxAcquirer> | undefined;

  try {
    const row = await observeRunStep(ctx, "load_session", () => loadSession(input.sessionId));
    const agentConfig = normalizeAgentConfig(row.agent.config);
    workspaceId = row.workspace.id;
    userId = row.session.userId;
    agentId = row.agent.id;

    const afterSession = agentConfig.afterSession;
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    if (!afterSession?.enabled || !afterSession.prompt.trim()) {
      outcome = "skipped_disabled";
      return;
    }

    const latestUserMessage = await observeRunStep(ctx, "load_latest_user_message", () =>
      loadLatestUserMessage(input.sessionId),
    );
    if (!latestUserMessage || latestUserMessage.id !== input.messageId) {
      outcome = "skipped_newer_message";
      return;
    }

    if (row.session.runLeaseId) {
      outcome = "skipped_active_run";
      await appendAfterSessionSkipped({
        sessionId: input.sessionId,
        messageId: input.messageId,
        reason: "active_run",
      });
      return;
    }
    if (row.session.status !== "completed") {
      outcome = "skipped_session_not_completed";
      return;
    }

    if (
      !(await observeRunStep(ctx, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db: ctx.db, workspaceId: row.session.workspaceId }),
      ))
    ) {
      outcome = "skipped_no_credits";
      await appendAfterSessionSkipped({
        sessionId: input.sessionId,
        messageId: input.messageId,
        reason: "no_credits",
      });
      return;
    }

    const toolPolicy = await observeRunStep(ctx, "load_tool_policy", () =>
      loadWorkspaceToolPolicy(row.workspace.id),
    );
    const runtime = resolveAgentRuntimeConfig({
      agent: agentConfig,
      modelOverride: row.session.modelName ?? undefined,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserContext(row.user),
      toolPolicy: { policy: toolPolicy, suspendable: false },
    });
    modelProvider = runtime.model.provider;
    modelName = runtime.model.name;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        model_provider: modelProvider,
        model_name: modelName,
        enabled_tools: runtime.tools,
      },
    });

    const lease = await observeRunStep(ctx, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: `after-session:${input.messageId}`,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        modelProvider: runtime.model.provider,
        modelName: runtime.model.name,
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
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

    const afterRun = await observeRunStep(ctx, "create_after_session_run", () =>
      createAfterSessionRun({
        sessionId: input.sessionId,
        workspaceId: row.workspace.id,
        agentId: row.agent.id,
        lastUserMessageId: input.messageId,
        agentVersion: row.agent.version,
        runLeaseId: ctx.leaseId,
      }),
    );
    if (!afterRun) {
      outcome = "skipped_duplicate";
      await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
      return;
    }
    afterSessionRunId = afterRun.id;
    logBraintrustSpan(braintrustSpan, {
      metadata: { after_session_run_id: afterSessionRunId },
    });

    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "after_session.started",
        payload: {
          runId: afterSessionRunId,
          messageId: input.messageId,
          idleDelaySeconds: afterSession.idleDelaySeconds,
        },
      }),
    );
    logger.info("Runner after-session started", {
      event: "opencompany.runner_after_session_started",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      model_provider: modelProvider,
      model_name: modelName,
    });

    const assistantCreated = await observeRunStep(ctx, "create_internal_assistant_message", () =>
      createAssistantMessageForLease({
        id: assistantMessageId,
        sessionId: input.sessionId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        internal: true,
      }),
    );
    if (!assistantCreated) {
      outcome = "skipped_assistant_exists";
      await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
      return;
    }

    const storedMessages = await observeRunStep(ctx, "load_model_messages", () =>
      ctx.db
        .select()
        .from(agentSessionMessages)
        .where(eq(agentSessionMessages.sessionId, input.sessionId))
        .orderBy(asc(agentSessionMessages.createdAt)),
    );
    const visibleStoredMessages = await hydrateMessageAttachments(
      storedMessages.filter((message) => message.id !== assistantMessageId && !message.internal),
      { db: ctx.db, blobToken: ctx.env.blobReadWriteToken },
    );
    const messages: ModelMessage[] = buildModelMessages(visibleStoredMessages);
    messages.push({
      role: "user",
      content: buildAfterSessionPrompt({ prompt: afterSession.prompt }),
    });

    sandboxAcquirer = createSandboxAcquirer({
      row,
      env: input.env,
      trace: ctx.trace,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      checkAbort,
      onHydrated: (sandbox) => {
        sandboxRef.id = sandbox.sandboxId;
      },
    });

    const toolStartCoordinator = createToolStartCoordinator();
    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      runLeaseId: ctx.leaseId,
      runLeaseOwner: ctx.leaseOwner,
      internalMessages: true,
      workspaceId: row.workspace.id,
      agentConfig,
      getSandbox: sandboxAcquirer.get,
      workdir: row.session.workdir,
      env: input.env,
      enabledTools: runtime.tools,
      repository: row.repository,
      signal: ctx.controller.signal,
      checkAbort,
      toolStartCoordinator,
      observabilityContext: { workspaceId, userId, agentId, modelProvider, modelName },
      toolBudget: createHostedToolBudget(),
    });

    // Snapshot the now-resolved run id into a const so the closures below capture a narrowed
    // `number` (a captured `let` would widen back to `number | undefined`).
    const completedRunId = afterSessionRunId;
    const turn = await executeStreamingTurn({
      ctx,
      row,
      runtime: {
        ...runtime,
        tools: runtime.tools.filter((tool) => tool !== "delegate_to_agent"),
      },
      system: `${runtime.systemPrompt}\n\nThis is an internal after-session run. Do not address the user; any final text is stored internally and not shown in chat, so keep it brief. Capture anything worth carrying forward in your agent folder (agent/memory.md for durable learnings), and skip the update if nothing is worth preserving. Use ./brain only for shared company knowledge in mounted Brain files.`,
      messages,
      tools,
      mcpContext: {
        internalMessages: true,
        workspaceId: row.workspace.id,
        agentConfig: row.agent.config,
        signal: ctx.controller.signal,
        checkAbort,
        observabilityContext: { workspaceId, userId, agentId, modelProvider, modelName },
      },
      assistantMessageId,
      toolStartCoordinator,
      checkAbort,
      policy: toolPolicy,
      // After-session runs are background brain updates with no resumable user-facing
      // turn, so they cannot suspend; "ask" tools collapse to "deny".
      suspendable: false,
      sandboxAcquirer,
      internal: true,
      brainStep: "sync_brain_after_session",
      bundleStep: "sync_agent_bundle_after_session",
      emptyOutputFallback: "After-session run completed without changes.",
      appendCompletedEvent: () =>
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "after_session.completed",
          payload: { runId: completedRunId, messageId: input.messageId },
        }),
      beforeRelease: async () => {
        await completeAfterSessionRun(completedRunId, { status: "completed" });
      },
    });
    if (turn.outcome === "suspended") {
      outcome = "suspended";
      return;
    }
    outcome = "completed";
    logger.info("Runner after-session completed", {
      event: "opencompany.runner_after_session_completed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxRef.id,
      model_provider: modelProvider,
      model_name: modelName,
    });
  } catch (error) {
    if (error instanceof RunLeaseBusyError) {
      logBraintrustCurrentSpan({
        error: braintrustError(error),
        metadata: { outcome, assistant_message_id: assistantMessageId },
      });
      throw error;
    }

    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      logBraintrustCurrentSpan({
        error: braintrustError(error),
        metadata: { outcome, assistant_message_id: assistantMessageId },
      });
      return;
    }

    const message =
      ctx.controller.signal.aborted || error instanceof RunAbortError
        ? "After-session run aborted."
        : error instanceof Error
          ? error.message
          : "Unknown after-session error";
    logBraintrustCurrentSpan({
      error: braintrustError(error),
      metadata: {
        outcome:
          ctx.controller.signal.aborted || error instanceof RunAbortError ? "aborted" : "failed",
        assistant_message_id: assistantMessageId,
        after_session_run_id: afterSessionRunId,
        sandbox_id: sandboxRef.id,
      },
    });
    captureException(error, {
      event: "opencompany.runner_after_session_failed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxRef.id,
      model_provider: modelProvider,
      model_name: modelName,
    });
    if (leaseAcquired) {
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "after_session.failed",
        payload: {
          ...(afterSessionRunId ? { runId: afterSessionRunId } : {}),
          messageId: input.messageId,
          message,
        },
      });
      await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
    } else {
      await appendRuntimeEvent(ctx.db, {
        sessionId: input.sessionId,
        type: "after_session.failed",
        payload: {
          ...(afterSessionRunId ? { runId: afterSessionRunId } : {}),
          messageId: input.messageId,
          message,
        },
      });
    }
    if (afterSessionRunId) {
      await completeAfterSessionRun(afterSessionRunId, { status: "failed", lastError: message });
    }
    outcome = "failed";
    logger.error("Runner after-session failed", {
      event: "opencompany.runner_after_session_failed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxRef.id,
      model_provider: modelProvider,
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
      // Await any in-flight warm-up so a warmed-but-unused sandbox is still parked
      // (idle timeout re-armed to 30s) rather than left on its 60-minute active timeout.
      sandbox: (await sandboxAcquirer?.settle()) ?? null,
    });
  }
}

// Resume a turn that suspended at an "ask" gate, once the approval row is decided (by the
// user or the 7-day backstop). Executes the now-decided tool body outside the model stream
// (approved → run it; denied → synthesize the permission_denied result), then continues
// the turn with a fresh model step over the full history (assistant-with-tool-call +
// tool-result). The approval row is the source of truth, so this is crash-safe and
// idempotent: a tool-result already persisted for the call short-circuits to the
// continuation.
export async function resumeApproval(input: {
  sessionId: string;
  toolCallId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
}) {
  const ctx = createRunContext("runner.resume_approval", {
    sessionId: input.sessionId,
    messageId: input.toolCallId,
    env: input.env,
    ...(input.externalSignal ? { externalSignal: input.externalSignal } : {}),
  });
  try {
    return await traceBraintrust(
      {
        name: "runner.resume_approval",
        type: "task",
        tags: ["runner", "agent-session"],
        metadata: {
          run_type: "resume_approval",
          session_id: input.sessionId,
          tool_call_id: input.toolCallId,
          run_lease_id: ctx.leaseId,
          runner_instance_id: input.env.instanceId,
        },
      },
      (span) => resumeApprovalWithContext(input, ctx, span),
    );
  } finally {
    await flushBraintrust();
  }
}

async function resumeApprovalWithContext(
  input: {
    sessionId: string;
    toolCallId: string;
    env: RunnerEnv;
    externalSignal?: AbortSignal;
  },
  ctx: RunContext,
  braintrustSpan: BraintrustSpan | undefined,
) {
  let leaseAcquired = false;
  let outcome = "unknown";
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  let sandboxAcquirer: ReturnType<typeof createSandboxAcquirer> | undefined;

  try {
    const approval = await loadToolApproval(input.sessionId, input.toolCallId);
    if (!approval) {
      outcome = "skipped_missing_approval";
      return;
    }
    // Decision hasn't landed yet (resume fired before the row was updated). Drop it; the
    // web action / backstop re-triggers a resume once the row is decided.
    if (approval.status === "pending") {
      outcome = "skipped_pending_approval";
      return;
    }

    const row = await observeRunStep(ctx, "load_session", () => loadSession(input.sessionId));
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    // A session torn down (aborted/archiving) while paused must not be revived by a late
    // resume (e.g. the backstop sweep racing an abort).
    if (row.session.status === "aborting" || row.session.status === "archiving") {
      outcome = "skipped_aborted";
      return;
    }
    const agentConfig = normalizeAgentConfig(row.agent.config);
    const workspaceId = row.workspace.id;
    const userId = row.session.userId;
    const agentId = row.agent.id;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        agent_path: row.agent.path,
        session_status: row.session.status,
      },
    });

    if (
      !(await observeRunStep(ctx, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db: ctx.db, workspaceId: row.session.workspaceId }),
      ))
    ) {
      outcome = "skipped_no_credits";
      await setStatus(input.sessionId, "ready");
      return;
    }

    const toolPolicy = await observeRunStep(ctx, "load_tool_policy", () =>
      loadWorkspaceToolPolicy(row.workspace.id),
    );
    const runtime = resolveAgentRuntimeConfig({
      agent: agentConfig,
      modelOverride: row.session.modelName ?? undefined,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserContext(row.user),
      toolPolicy: { policy: toolPolicy, suspendable: true },
    });
    modelProvider = runtime.model.provider;
    modelName = runtime.model.name;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        model_provider: modelProvider,
        model_name: modelName,
        enabled_tools: runtime.tools,
      },
    });

    const lease = await observeRunStep(ctx, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: input.toolCallId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        modelProvider: runtime.model.provider,
        modelName: runtime.model.name,
      }),
    );
    if (!lease) {
      outcome = "skipped_lease_busy";
      throw new RunLeaseBusyError();
    }
    leaseAcquired = true;
    setActiveRun(input.sessionId, ctx.leaseId, ctx.leaseOwner, ctx.controller);

    const checkAbort = createLeaseAbortCheck(ctx);
    await checkAbort({ force: true });
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.status",
        payload: { status: "running", message: "Agent is running" },
      }),
    );

    // The suspended assistant message (carries the pending tool-call) is the parent for
    // the tool's started/completed events so its card renders under the original turn.
    const suspendedAssistantMessageId = approval.messageId ?? "";
    const storedMessages = await observeRunStep(ctx, "load_model_messages", () =>
      ctx.db
        .select()
        .from(agentSessionMessages)
        .where(eq(agentSessionMessages.sessionId, input.sessionId))
        .orderBy(asc(agentSessionMessages.createdAt)),
    );

    sandboxAcquirer = createSandboxAcquirer({
      row,
      env: input.env,
      trace: ctx.trace,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      checkAbort,
      onHydrated: () => {},
    });

    const observabilityContext = { workspaceId, userId, agentId, modelProvider, modelName };

    // Idempotency: a prior resume that crashed after persisting the tool-result skips the
    // execution and goes straight to the continuation.
    const toolResultAlreadyPersisted = storedMessages.some(
      (message) => message.role === "tool" && message.toolCallId === input.toolCallId,
    );

    if (!toolResultAlreadyPersisted) {
      const toolCall = findSuspendedToolCall(
        storedMessages,
        suspendedAssistantMessageId,
        input.toolCallId,
      );
      const toolName = toolCall?.toolName ?? approval.toolName;
      const toolArgs = toolCall?.input;

      // Approval resolution is the user's decision, not the tool's completion. Emit it before
      // executing the resumed tool so long-running or failing tools do not leave the approval card
      // stuck in a pending/resolving state.
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: suspendedAssistantMessageId,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "tool.approval_resolved",
          payload: {
            messageId: suspendedAssistantMessageId,
            toolCallId: input.toolCallId,
            name: toolName,
            decision: approval.status === "approved" ? "approved" : "denied",
            decisionSource: approval.decisionSource ?? "user",
          },
        }),
      );

      if (approval.status === "approved") {
        await requireLeaseWrite(
          appendRuntimeEventForLease({
            sessionId: input.sessionId,
            messageId: suspendedAssistantMessageId,
            leaseId: ctx.leaseId,
            leaseOwner: ctx.leaseOwner,
            type: "tool.started",
            payload: {
              messageId: suspendedAssistantMessageId,
              toolCallId: input.toolCallId,
              name: toolName,
              input: toolArgs,
            },
          }),
        );

        if (toolName.includes("__")) {
          // MCP tool: connect and run the body with the same persistence tail as the
          // in-stream path.
          const mcpToolSet = await createMcpToolSet({
            sessionId: input.sessionId,
            assistantMessageId: suspendedAssistantMessageId,
            runLeaseId: ctx.leaseId,
            runLeaseOwner: ctx.leaseOwner,
            workspaceId: row.workspace.id,
            agentConfig: row.agent.config,
            integrationCredentialEncryptionKey: input.env.integrationCredentialEncryptionKey,
            signal: ctx.controller.signal,
            checkAbort,
            toolStartCoordinator: createToolStartCoordinator(),
            policy: toolPolicy,
            suspendable: true,
            observabilityContext,
          });
          try {
            const run = mcpToolSet.runApprovedTool({
              toolName,
              toolCallId: input.toolCallId,
              args: toolArgs,
            });
            if (!run) {
              throw new Error(`MCP tool ${toolName} is no longer available to resume.`);
            }
            await run;
          } finally {
            await mcpToolSet.close();
          }
        } else if (toolName === BUILTIN_USE_TOOL_NAME) {
          // The suspended call was the built-in dispatcher. Re-dispatch the underlying tool with
          // the same persistence tail as the in-stream path (result paired with `use_tool`).
          await dispatchBuiltinUseTool({
            sessionId: input.sessionId,
            assistantMessageId: suspendedAssistantMessageId,
            runLeaseId: ctx.leaseId,
            runLeaseOwner: ctx.leaseOwner,
            workspaceId: row.workspace.id,
            agentConfig,
            toolCallId: input.toolCallId,
            args: toolArgs,
            getSandbox: sandboxAcquirer.get,
            workdir: row.session.workdir,
            env: input.env,
            enabledTools: runtime.tools,
            repository: row.repository,
            signal: ctx.controller.signal,
            checkAbort,
            observabilityContext,
            toolBudget: createHostedToolBudget(),
          });
        } else {
          const definition = RUNTIME_TOOL_DEFINITIONS.find(
            (candidate: RuntimeToolDefinition) => candidate.name === toolName,
          );
          if (!definition) {
            throw new Error(`Runtime tool ${toolName} is no longer available to resume.`);
          }
          await executeRuntimeTool({
            sessionId: input.sessionId,
            assistantMessageId: suspendedAssistantMessageId,
            runLeaseId: ctx.leaseId,
            runLeaseOwner: ctx.leaseOwner,
            workspaceId: row.workspace.id,
            agentConfig,
            toolCallId: input.toolCallId,
            definition,
            args: toolArgs,
            getSandbox: sandboxAcquirer.get,
            workdir: row.session.workdir,
            env: input.env,
            enabledTools: runtime.tools,
            repository: row.repository,
            signal: ctx.controller.signal,
            checkAbort,
            observabilityContext,
            toolBudget: createHostedToolBudget(),
          });
        }
      } else {
        // Denied (by the user or the backstop): synthesize the permission_denied result and
        // continue so the model can explain / adapt.
        await persistDeniedToolResult({
          sessionId: input.sessionId,
          assistantMessageId: suspendedAssistantMessageId,
          runLeaseId: ctx.leaseId,
          runLeaseOwner: ctx.leaseOwner,
          toolCallId: input.toolCallId,
          toolName,
          verdict: {
            decision: "deny",
            providerKey: approval.providerKey,
            group: approval.permissionGroup,
            source: approval.decisionSource === "timeout" ? "timeout" : "user",
          },
        });
      }
    }

    // Continue the turn with a fresh assistant message over the reconciled history.
    outcome = await continueTurnAfterToolResult({
      ctx,
      row,
      agentConfig,
      runtime,
      toolPolicy,
      sandboxAcquirer,
      observabilityContext,
      checkAbort,
      env: input.env,
      sessionId: input.sessionId,
    });
  } catch (error) {
    if (error instanceof RunLeaseBusyError) {
      logBraintrustCurrentSpan({ error: braintrustError(error), metadata: { outcome } });
      throw error;
    }

    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      logBraintrustCurrentSpan({ error: braintrustError(error), metadata: { outcome } });
      return;
    }
    if (ctx.controller.signal.aborted || error instanceof RunAbortError) {
      outcome = "aborted";
      logBraintrustCurrentSpan({ error: braintrustError(error), metadata: { outcome } });
      if (leaseAcquired) {
        await failRunLease(
          input.sessionId,
          ctx.leaseId,
          ctx.leaseOwner,
          "aborting",
          "Run aborted.",
        );
      }
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown runner error";
    logBraintrustCurrentSpan({
      error: braintrustError(error),
      metadata: { outcome: "failed", tool_call_id: input.toolCallId },
    });
    if (leaseAcquired) {
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.error",
        payload: { message },
      });
      await failRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "failed", message);
    }
    captureException(error, {
      event: "opencompany.runner_resume_approval_failed",
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
    });
    outcome = "failed";
    throw leaseAcquired ? new MessageTurnFailedError(error) : error;
  } finally {
    await finalizeRun({
      ctx,
      outcome,
      modelProvider,
      modelName,
      // Await any in-flight warm-up so a warmed-but-unused sandbox is still parked
      // (idle timeout re-armed to 30s) rather than left on its 60-minute active timeout.
      sandbox: (await sandboxAcquirer?.settle()) ?? null,
    });
  }
}

// The shared tail of both resume paths: once the now-decided tool-result is persisted, continue
// the suspended turn with a fresh assistant message over the reconciled history (assistant +
// tool-result), streaming the next model step. Returns the run outcome string. Extracted so the
// approval and question resumes share identical continuation behaviour.
async function continueTurnAfterToolResult(input: {
  ctx: RunContext;
  row: LoadedSession;
  agentConfig: ReturnType<typeof normalizeAgentConfig>;
  runtime: ReturnType<typeof resolveAgentRuntimeConfig>;
  toolPolicy: Awaited<ReturnType<typeof loadWorkspaceToolPolicy>>;
  sandboxAcquirer: ReturnType<typeof createSandboxAcquirer>;
  observabilityContext: NonNullable<Parameters<typeof createToolSet>[0]["observabilityContext"]>;
  checkAbort: RunControlCheck;
  env: RunnerEnv;
  sessionId: string;
}): Promise<"completed" | "suspended" | "skipped_assistant_exists"> {
  const { ctx, row, sandboxAcquirer, checkAbort } = input;
  const continuationAssistantMessageId = newAgentSessionMessageId();
  const created = await observeRunStep(ctx, "create_assistant_message", () =>
    createAssistantMessageForLease({
      id: continuationAssistantMessageId,
      sessionId: input.sessionId,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
    }),
  );
  if (!created) {
    await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
    return "skipped_assistant_exists";
  }

  const continuationStoredMessages = (
    await ctx.db
      .select()
      .from(agentSessionMessages)
      .where(eq(agentSessionMessages.sessionId, input.sessionId))
      .orderBy(asc(agentSessionMessages.createdAt))
  ).filter((message) => message.id !== continuationAssistantMessageId && !message.internal);
  const continuationMessages = buildModelMessages(
    await hydrateMessageAttachments(continuationStoredMessages, {
      db: ctx.db,
      blobToken: ctx.env.blobReadWriteToken,
    }),
  );

  const toolStartCoordinator = createToolStartCoordinator();
  const tools = createToolSet({
    sessionId: input.sessionId,
    assistantMessageId: continuationAssistantMessageId,
    runLeaseId: ctx.leaseId,
    runLeaseOwner: ctx.leaseOwner,
    workspaceId: row.workspace.id,
    agentConfig: input.agentConfig,
    getSandbox: sandboxAcquirer.get,
    workdir: row.session.workdir,
    env: input.env,
    enabledTools: input.runtime.tools,
    repository: row.repository,
    signal: ctx.controller.signal,
    checkAbort,
    toolStartCoordinator,
    observabilityContext: input.observabilityContext,
    toolBudget: createHostedToolBudget(),
  });

  const turn = await executeStreamingTurn({
    ctx,
    row,
    runtime: input.runtime,
    system: input.runtime.systemPrompt,
    messages: continuationMessages,
    tools,
    mcpContext: {
      workspaceId: row.workspace.id,
      agentConfig: row.agent.config,
      signal: ctx.controller.signal,
      checkAbort,
      observabilityContext: input.observabilityContext,
    },
    assistantMessageId: continuationAssistantMessageId,
    toolStartCoordinator,
    checkAbort,
    policy: input.toolPolicy,
    suspendable: true,
    sandboxAcquirer,
    internal: false,
    brainStep: "sync_brain_after_resume",
    bundleStep: "sync_agent_bundle_after_resume",
    appendCompletedEvent: () =>
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.status",
        payload: { status: "completed", message: "Agent completed" },
      }),
  });
  return turn.outcome === "suspended" ? "suspended" : "completed";
}

// Resume a turn that suspended on an ask_user_question call, once the question row is decided (the
// user answered, cancelled via the X, was superseded by a new message, or the 7-day backstop
// fired). Synthesizes the tool-result from the persisted answers (or an "unanswered" result when
// cancelled) outside the model stream, then continues the turn over the full history. The question
// row is the source of truth, so this is crash-safe and idempotent: a tool-result already persisted
// short-circuits to the continuation. Mirrors resumeApproval.
export async function resumeQuestionResponse(input: {
  sessionId: string;
  toolCallId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
}) {
  const ctx = createRunContext("runner.resume_question", {
    sessionId: input.sessionId,
    messageId: input.toolCallId,
    env: input.env,
    ...(input.externalSignal ? { externalSignal: input.externalSignal } : {}),
  });
  try {
    return await traceBraintrust(
      {
        name: "runner.resume_question",
        type: "task",
        tags: ["runner", "agent-session"],
        metadata: {
          run_type: "resume_question",
          session_id: input.sessionId,
          tool_call_id: input.toolCallId,
          run_lease_id: ctx.leaseId,
          runner_instance_id: input.env.instanceId,
        },
      },
      (span) => resumeQuestionResponseWithContext(input, ctx, span),
    );
  } finally {
    await flushBraintrust();
  }
}

async function resumeQuestionResponseWithContext(
  input: {
    sessionId: string;
    toolCallId: string;
    env: RunnerEnv;
    externalSignal?: AbortSignal;
  },
  ctx: RunContext,
  braintrustSpan: BraintrustSpan | undefined,
) {
  let leaseAcquired = false;
  let outcome = "unknown";
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  let sandboxAcquirer: ReturnType<typeof createSandboxAcquirer> | undefined;

  try {
    const question = await loadSessionQuestion(input.sessionId, input.toolCallId);
    if (!question) {
      outcome = "skipped_missing_question";
      return;
    }
    // Decision hasn't landed yet (resume fired before the row was updated). Drop it; the web
    // action / backstop re-triggers a resume once the row is decided.
    if (question.status === "pending") {
      outcome = "skipped_pending_question";
      return;
    }

    // The user dismissed the question (the X) instead of answering. We still persist the
    // "unanswered" tool-result below so the model sees the question went unanswered, but we must
    // NOT continue the turn — the run resolves quietly and the agent only speaks again on the
    // user's next message. Re-derived from the row (not a job flag) so it survives a runner restart;
    // timeout (cancelled+timeout) and answered (answered+user) still continue the turn below.
    const isQuietDecline = question.status === "cancelled" && question.resolutionSource === "user";

    const row = await observeRunStep(ctx, "load_session", () => loadSession(input.sessionId));
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    // A session torn down (aborted/archiving) while paused must not be revived by a late resume.
    if (row.session.status === "aborting" || row.session.status === "archiving") {
      outcome = "skipped_aborted";
      return;
    }
    const agentConfig = normalizeAgentConfig(row.agent.config);
    const workspaceId = row.workspace.id;
    const userId = row.session.userId;
    const agentId = row.agent.id;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        agent_path: row.agent.path,
        session_status: row.session.status,
      },
    });

    if (
      !(await observeRunStep(ctx, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db: ctx.db, workspaceId: row.session.workspaceId }),
      ))
    ) {
      outcome = "skipped_no_credits";
      await setStatus(input.sessionId, "ready");
      return;
    }

    const toolPolicy = await observeRunStep(ctx, "load_tool_policy", () =>
      loadWorkspaceToolPolicy(row.workspace.id),
    );
    const runtime = resolveAgentRuntimeConfig({
      agent: agentConfig,
      modelOverride: row.session.modelName ?? undefined,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserContext(row.user),
      toolPolicy: { policy: toolPolicy, suspendable: true },
    });
    modelProvider = runtime.model.provider;
    modelName = runtime.model.name;
    logBraintrustSpan(braintrustSpan, {
      metadata: {
        model_provider: modelProvider,
        model_name: modelName,
        enabled_tools: runtime.tools,
      },
    });

    const lease = await observeRunStep(ctx, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: input.toolCallId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        modelProvider: runtime.model.provider,
        modelName: runtime.model.name,
      }),
    );
    if (!lease) {
      outcome = "skipped_lease_busy";
      throw new RunLeaseBusyError();
    }
    leaseAcquired = true;
    setActiveRun(input.sessionId, ctx.leaseId, ctx.leaseOwner, ctx.controller);

    const checkAbort = createLeaseAbortCheck(ctx);
    await checkAbort({ force: true });
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

    // A quiet decline resolves straight to "completed"; emitting "running" first would flash a
    // working indicator for no reason. Every other path runs the model, so announce it.
    if (!isQuietDecline) {
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "session.status",
          payload: { status: "running", message: "Agent is running" },
        }),
      );
    }

    // The suspended assistant message (carries the pending tool-call) is the parent for the
    // question.answered event so its card renders under the original turn.
    const suspendedAssistantMessageId = question.messageId ?? "";
    const storedMessages = await observeRunStep(ctx, "load_model_messages", () =>
      ctx.db
        .select()
        .from(agentSessionMessages)
        .where(eq(agentSessionMessages.sessionId, input.sessionId))
        .orderBy(asc(agentSessionMessages.createdAt)),
    );

    sandboxAcquirer = createSandboxAcquirer({
      row,
      env: input.env,
      trace: ctx.trace,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      checkAbort,
      onHydrated: () => {},
    });

    const observabilityContext = { workspaceId, userId, agentId, modelProvider, modelName };

    // Idempotency: a prior resume that crashed after persisting the tool-result skips straight to
    // the continuation.
    const toolResultAlreadyPersisted = storedMessages.some(
      (message) => message.role === "tool" && message.toolCallId === input.toolCallId,
    );

    if (!toolResultAlreadyPersisted) {
      // There is no tool body to execute — the answer (or an "unanswered" notice) IS the result.
      const output =
        question.status === "answered"
          ? buildQuestionAnswerToolOutput(question.questions, question.answers)
          : buildUnansweredQuestionToolOutput(question.resolutionSource);
      await requireLeaseWrite(
        insertToolMessageForLease({
          id: newAgentSessionMessageId(),
          sessionId: input.sessionId,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          content: serializeToolOutputForStorage(output),
          modelMessage: toPersistedModelMessage(
            buildToolModelMessage({
              toolCallId: input.toolCallId,
              toolName: "ask_user_question",
              output,
            }),
          ),
          toolName: "ask_user_question",
          toolCallId: input.toolCallId,
          internal: false,
        }),
      );
    }

    // Emit the resolution event unconditionally: the tool-result message and this event are
    // separate writes, so a resume that crashed between them would otherwise skip the event on
    // retry (tool result already persisted) and leave the question card stuck `pending` in the
    // event-derived UI. The reducer keys off toolCallId, so a duplicate event is idempotent.
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: suspendedAssistantMessageId,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "question.answered",
        payload: {
          messageId: suspendedAssistantMessageId,
          toolCallId: input.toolCallId,
          answered: question.status === "answered",
          answers: question.answers ?? [],
          resolutionSource: question.resolutionSource ?? "user",
        },
      }),
    );

    if (isQuietDecline) {
      // Park the session exactly as a completed turn would, but WITHOUT generating an assistant
      // message: the composer returns and the agent stays silent until the user's next message,
      // which then replays over assistant(ask) → tool(unanswered) → user(...). Placed after the
      // idempotency block so a crash-then-retry still releases the lease.
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId: ctx.leaseId,
          leaseOwner: ctx.leaseOwner,
          type: "session.status",
          payload: { status: "completed", message: "Agent completed" },
        }),
      );
      await releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed");
      outcome = "resolved_quiet_decline";
      return;
    }

    // Continue the turn with a fresh assistant message over the reconciled history.
    outcome = await continueTurnAfterToolResult({
      ctx,
      row,
      agentConfig,
      runtime,
      toolPolicy,
      sandboxAcquirer,
      observabilityContext,
      checkAbort,
      env: input.env,
      sessionId: input.sessionId,
    });
  } catch (error) {
    if (error instanceof RunLeaseBusyError) {
      logBraintrustCurrentSpan({ error: braintrustError(error), metadata: { outcome } });
      throw error;
    }

    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      logBraintrustCurrentSpan({ error: braintrustError(error), metadata: { outcome } });
      return;
    }
    if (ctx.controller.signal.aborted || error instanceof RunAbortError) {
      outcome = "aborted";
      logBraintrustCurrentSpan({ error: braintrustError(error), metadata: { outcome } });
      if (leaseAcquired) {
        await failRunLease(
          input.sessionId,
          ctx.leaseId,
          ctx.leaseOwner,
          "aborting",
          "Run aborted.",
        );
      }
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown runner error";
    logBraintrustCurrentSpan({
      error: braintrustError(error),
      metadata: { outcome: "failed", tool_call_id: input.toolCallId },
    });
    if (leaseAcquired) {
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "session.error",
        payload: { message },
      });
      await failRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "failed", message);
    }
    captureException(error, {
      event: "opencompany.runner_resume_question_failed",
      session_id: input.sessionId,
      tool_call_id: input.toolCallId,
    });
    outcome = "failed";
    throw leaseAcquired ? new MessageTurnFailedError(error) : error;
  } finally {
    await finalizeRun({
      ctx,
      outcome,
      modelProvider,
      modelName,
      // Await any in-flight warm-up so a warmed-but-unused sandbox is still parked
      // (idle timeout re-armed to 30s) rather than left on its 60-minute active timeout.
      sandbox: (await sandboxAcquirer?.settle()) ?? null,
    });
  }
}

// Pull the persisted tool-call (name + input) for a suspended approval out of the
// assistant message that the suspend run left ending in that tool-call.
function findSuspendedToolCall(
  storedMessages: Array<{ id: string; modelMessage: unknown }>,
  assistantMessageId: string,
  toolCallId: string,
): { toolName: string; input: unknown } | null {
  const message = storedMessages.find((candidate) => candidate.id === assistantMessageId);
  const modelMessage = message?.modelMessage;
  if (!modelMessage || typeof modelMessage !== "object") return null;
  const content = (modelMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "tool-call" &&
      (part as { toolCallId?: unknown }).toolCallId === toolCallId
    ) {
      return {
        toolName: String((part as { toolName?: unknown }).toolName ?? ""),
        input: (part as { input?: unknown }).input,
      };
    }
  }
  return null;
}

async function runDelegatedChildMessage(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  depth: number;
}) {
  const heartbeat = setInterval(() => {
    void input.checkAbort().catch(() => {
      // checkAbort aborts the parent run controller when the lease is lost.
    });
  }, 5_000);
  try {
    await runMessage({
      sessionId: input.sessionId,
      messageId: input.messageId,
      env: input.env,
      externalSignal: input.signal,
      delegationDepth: input.depth + 1,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    return {
      ok: false,
      status: "failed",
      error: error instanceof Error ? error.message : "Delegated agent failed.",
    };
  } finally {
    clearInterval(heartbeat);
  }

  return null;
}

type SandboxAcquirer = {
  // Kick off the sandbox create/connect + workspace materialization in the background so
  // the ~10s warm-up overlaps the model's first tokens instead of stalling the first tool
  // call. Fire-and-forget and idempotent; it does NOT open the billing window or mark the
  // sandbox "used" — only a real tool call via get() does. Safe to call on a turn that may
  // never touch the sandbox.
  warm: () => void;
  get: () => Promise<SandboxHandle>;
  // The live sandbox handle once it has been warmed or used (null until then). Read at
  // teardown to park it (re-arm the idle timeout) whether or not a tool actually used it.
  readonly current: SandboxHandle | null;
  // True only once a tool actually acquired the sandbox via get(). Gates post-turn brain/
  // bundle sync so a warmed-but-unused turn doesn't sync needlessly.
  wasUsed: () => boolean;
  // Await any in-flight warm-up and hand back the handle to park at teardown (or null if
  // the warm-up failed or never ran). Never throws.
  settle: () => Promise<SandboxHandle | null>;
  // The active-runtime window for billing: present only once the sandbox has been
  // hydrated (used) during this run. Null for turns that warm but never touch it.
  billingSnapshot: () => SandboxBillingSnapshot | null;
};

function createSandboxAcquirer(input: {
  row: LoadedSession;
  env: RunnerEnv;
  trace: ReturnType<typeof startTimingTrace>;
  leaseId: string;
  leaseOwner: string;
  checkAbort: RunControlCheck;
  onHydrated: (sandbox: SandboxHandle) => void;
}): SandboxAcquirer {
  let sandbox: SandboxHandle | null = null;
  let acquirePromise: Promise<SandboxHandle> | null = null;
  let hydratedAt: Date | null = null;
  const billing = resolveSandboxBilling(input.row, input.env);

  // Create/connect the sandbox, materialize the workspace, and claim it under the run
  // lease — everything except opening the billing window. Memoized so warm() and the
  // first tool-call get() share one in-flight promise (no double-create, no races).
  const acquire = () => {
    if (sandbox) return Promise.resolve(sandbox);
    if (acquirePromise) return acquirePromise;

    acquirePromise = (async () => {
      const hydrated = await traceBraintrustStep(
        "ensure_sandbox",
        () =>
          timeAsync(input.trace, "ensure_sandbox", () => ensureSandbox(input.row, input.env), {
            existing_sandbox: Boolean(input.row.session.e2bSandboxId),
          }),
        { existing_sandbox: Boolean(input.row.session.e2bSandboxId) },
      );
      await input.checkAbort();
      const updated = await traceBraintrustStep(
        "update_sandbox_for_lease",
        () =>
          timeAsync(input.trace, "update_sandbox_for_lease", () =>
            updateSandboxForLease(
              input.row.session.id,
              input.leaseId,
              input.leaseOwner,
              hydrated.sandboxId,
            ),
          ),
        { sandbox_id: hydrated.sandboxId },
      );
      logBraintrustCurrentSpan({
        metadata: {
          sandbox_id: hydrated.sandboxId,
          sandbox_hydrated: true,
          existing_sandbox: Boolean(input.row.session.e2bSandboxId),
        },
      });
      if (!updated) {
        await killSandbox(hydrated.sandboxId);
        throw new StaleRunLeaseError();
      }
      sandbox = hydrated;
      input.onHydrated(hydrated);
      return hydrated;
    })().catch((error) => {
      acquirePromise = null;
      throw error;
    });

    return acquirePromise;
  };

  const get = async () => {
    const hydrated = await acquire();
    // The billing window opens on first real use, not on warm-up.
    if (!hydratedAt) hydratedAt = new Date();
    return hydrated;
  };

  const warm = () => {
    // Swallow rejections here so an unobserved warm-up can't surface as an unhandled
    // rejection; get()/settle() await the same promise and still see any error.
    acquire().catch(() => {});
  };

  const settle = async () => {
    if (!acquirePromise) return sandbox;
    try {
      return await acquirePromise;
    } catch {
      return null;
    }
  };

  return {
    warm,
    get,
    get current() {
      return sandbox;
    },
    wasUsed() {
      return hydratedAt !== null;
    },
    settle,
    billingSnapshot() {
      if (!sandbox || !hydratedAt) return null;
      return {
        sandboxId: sandbox.sandboxId,
        hydratedAt,
        template: billing.template,
        vcpu: billing.vcpu,
        ramMib: billing.ramMib,
      };
    },
  };
}

// Whether a turn's enabled tools include any sandbox-backed tool, i.e. anything that can
// trigger a sandbox warm-up. The core tools (shell, read/write_file, gh, …) are all
// sandbox-kind, so this is true for essentially every agent — but it correctly skips a
// turn whose toolset is purely hosted/internal, where warming would only waste compute.
function runtimeHasSandboxTools(tools: readonly RuntimeToolName[]) {
  return tools.some((name) => RUNTIME_TOOL_DEFINITION_BY_NAME.get(name)?.kind === "sandbox");
}

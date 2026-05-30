import {
  newAgentSessionId,
  newAgentSessionMessageId,
  newRunLeaseId,
  normalizeAgentConfig,
  resolveAgentRuntimeConfig,
} from "@opencompany/agent-runtime";
import type { AgentReference } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
  workspaceCreditLedger,
} from "@opencompany/db/schema";
import {
  captureException,
  createLogger,
  endTimingTrace,
  type LogFields,
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
import type { ModelMessage, StopCondition, ToolSet } from "ai";
import * as ai from "ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { clearActiveRun, setActiveRun } from "./active-runs";
import { syncBrainFromSandbox } from "./brain";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { validateHostedToolEnvironment } from "./hosted-tools";
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
import { createMcpToolSet } from "./mcp-tools";
import {
  appendAssistantTextPart,
  buildAssistantModelMessage,
  buildModelMessages,
  toPersistedModelMessage,
} from "./model-messages";
import { collectAssistantStream } from "./model-stream-runner";
import {
  createRunControlGate,
  RunAbortError,
  type RunControlCheck,
  RunLeaseLostError,
} from "./run-control";
import { ToolStepLimitExceededError } from "./runner-errors";
import { killSandbox, type SandboxHandle } from "./sandbox";
import {
  abortSession,
  appendAfterSessionSkipped,
  archiveSession,
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
  optionalUserName,
  parkSandboxWhenIdle,
  setStatus,
  startSession,
} from "./session-lifecycle";
import { buildCacheableSystemPrompt, normalizeReasoningSummary } from "./stream-helpers";
import { createHostedToolBudget, createToolSet, pickRuntimeTools } from "./tool-dispatcher";
import { createToolStartCoordinator, type ToolStartCoordinator } from "./tool-start-coordinator";

export {
  buildAmpCommand,
  buildAmpCommandEnv,
  createAmpActivityFormatter,
  createAmpStreamAccumulator,
  createKnownSecretRedactor,
  selectPublishBranch,
} from "./amp-tool";
export {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
} from "./lease-writes";
export { collectAssistantStream } from "./model-stream-runner";
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
const MAX_AGENT_DELEGATION_DEPTH = 2;
export const MAX_MODEL_STEPS = 16;

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

    const runtime = resolveAgentRuntimeConfig({
      agent: agentConfig,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserName(row.user),
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
      return;
    }

    leaseAcquired = true;
    setActiveRun(input.sessionId, ctx.leaseId, ctx.controller);

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
    const messages = buildModelMessages(
      storedMessages.filter((message) => message.id !== assistantMessageId && !message.internal),
    );

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
      }),
    });

    const streamResult = await streamAssistantResponse({
      ctx,
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
    const { assistantContent, assistantReplayParts, reasoningSummary } = streamResult;

    if (sandboxAcquirer.current) {
      const activeSandbox = sandboxAcquirer.current;
      await observeRunStep(ctx, "sync_brain_after_message", () =>
        syncBrainFromSandbox({
          sandbox: activeSandbox,
          sessionId: input.sessionId,
          workspaceId: row.workspace.id,
          workdir: row.session.workdir,
          repository: row.repository,
        }),
      );
    }

    await checkAbort({ force: true });
    assertTurnComplete(streamResult);

    await persistAssistantCompletion({
      sessionId: input.sessionId,
      assistantMessageId,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      assistantContent,
      assistantReplayParts,
      reasoningSummary,
      internal: false,
    });

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
    await requireLeaseWrite(
      releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed"),
    );
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
    throw error;
  } finally {
    await finalizeRun({
      ctx,
      outcome,
      modelProvider,
      modelName,
      sandbox: sandboxAcquirer?.current ?? null,
    });
  }

  return { nextSteerMessageId };
}

export function assertTurnComplete(
  streamResult: Pick<
    Awaited<ReturnType<typeof collectAssistantStream>>,
    "assistantContent" | "assistantReplayParts" | "lastStepEndedWithToolCalls" | "stepCount"
  >,
) {
  if (!streamResult.assistantContent && streamResult.assistantReplayParts.length === 0) {
    throw new Error("Model stream completed without text or tool calls.");
  }

  if (streamResult.lastStepEndedWithToolCalls && streamResult.stepCount >= MAX_MODEL_STEPS) {
    throw new ToolStepLimitExceededError();
  }
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
      return;
    }
    afterSessionRunId = afterRun.id;
    logBraintrustSpan(braintrustSpan, {
      metadata: { after_session_run_id: afterSessionRunId },
    });

    if (
      !(await observeRunStep(ctx, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db: ctx.db, workspaceId: row.session.workspaceId }),
      ))
    ) {
      outcome = "skipped_no_credits";
      await completeAfterSessionRun(afterSessionRunId, {
        status: "skipped",
        skippedReason: "no_credits",
      });
      await appendAfterSessionSkipped({
        sessionId: input.sessionId,
        messageId: input.messageId,
        reason: "no_credits",
      });
      return;
    }

    const runtime = resolveAgentRuntimeConfig({
      agent: agentConfig,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserName(row.user),
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
      await completeAfterSessionRun(afterSessionRunId, {
        status: "skipped",
        skippedReason: "active_run",
      });
      await appendAfterSessionSkipped({
        sessionId: input.sessionId,
        messageId: input.messageId,
        reason: "active_run",
      });
      return;
    }

    leaseAcquired = true;
    setActiveRun(input.sessionId, ctx.leaseId, ctx.controller);

    const checkAbort = createLeaseAbortCheck(ctx);
    await observeRunStep(ctx, "initial_run_control_check", () => checkAbort({ force: true }));
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

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
    const visibleStoredMessages = storedMessages.filter(
      (message) => message.id !== assistantMessageId && !message.internal,
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

    let { assistantContent, assistantReplayParts, reasoningSummary } =
      await streamAssistantResponse({
        ctx,
        runtime: {
          ...runtime,
          tools: runtime.tools.filter((tool) => tool !== "delegate_to_agent"),
        },
        system: `${runtime.systemPrompt}\n\nThis is an internal after-session run. Do not address the user; any final text is stored internally and not shown in chat, so keep it brief. Use mounted Brain files under ./brain to capture durable, long-lived context from the transcript when worthwhile, and skip the update if nothing is worth preserving.`,
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
      });

    if (sandboxAcquirer.current) {
      const activeSandbox = sandboxAcquirer.current;
      await observeRunStep(ctx, "sync_brain_after_session", () =>
        syncBrainFromSandbox({
          sandbox: activeSandbox,
          sessionId: input.sessionId,
          workspaceId: row.workspace.id,
          workdir: row.session.workdir,
          repository: row.repository,
        }),
      );
    }

    await checkAbort({ force: true });
    if (!assistantContent && assistantReplayParts.length === 0) {
      assistantContent = "After-session run completed without changes.";
      appendAssistantTextPart(assistantReplayParts, assistantContent);
    }

    await persistAssistantCompletion({
      sessionId: input.sessionId,
      assistantMessageId,
      leaseId: ctx.leaseId,
      leaseOwner: ctx.leaseOwner,
      assistantContent,
      assistantReplayParts,
      reasoningSummary,
      internal: true,
    });

    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId: ctx.leaseId,
        leaseOwner: ctx.leaseOwner,
        type: "after_session.completed",
        payload: { runId: afterSessionRunId, messageId: input.messageId },
      }),
    );
    await completeAfterSessionRun(afterSessionRunId, { status: "completed" });
    await requireLeaseWrite(
      releaseRunLease(input.sessionId, ctx.leaseId, ctx.leaseOwner, "completed"),
    );
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
    throw error;
  } finally {
    await finalizeRun({
      ctx,
      outcome,
      modelProvider,
      modelName,
      sandbox: sandboxAcquirer?.current ?? null,
    });
  }
}

type RunContext = {
  sessionId: string;
  env: RunnerEnv;
  db: ReturnType<typeof getDb>;
  trace: ReturnType<typeof startTimingTrace>;
  controller: AbortController;
  leaseId: string;
  leaseOwner: string;
  runLease: { sessionId: string; leaseId: string; leaseOwner: string };
};

function createRunContext(
  traceName: string,
  input: { sessionId: string; messageId: string; env: RunnerEnv; externalSignal?: AbortSignal },
): RunContext {
  const controller = new AbortController();
  linkExternalAbortSignal(controller, input.externalSignal);
  const leaseId = newRunLeaseId();
  const leaseOwner = input.env.instanceId;
  return {
    sessionId: input.sessionId,
    env: input.env,
    db: getDb(),
    trace: startTimingTrace(traceName, {
      session_id: input.sessionId,
      message_id: input.messageId,
      runner_instance_id: input.env.instanceId,
    }),
    controller,
    leaseId,
    leaseOwner,
    runLease: { sessionId: input.sessionId, leaseId, leaseOwner },
  };
}

async function observeRunStep<T>(
  ctx: RunContext,
  step: string,
  run: (span: BraintrustSpan | undefined) => Promise<T>,
  metadata?: LogFields,
  options?: Parameters<typeof traceBraintrustStep>[3],
) {
  return traceBraintrustStep(
    step,
    (span) => timeAsync(ctx.trace, step, () => run(span), metadata),
    metadata,
    options,
  );
}

function createLeaseAbortCheck(ctx: RunContext): RunControlCheck {
  return createRunControlGate({ runLease: ctx.runLease, controller: ctx.controller });
}

export function createAgentDelegationHandler(input: {
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  workspaceId: string;
  userId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  depth: number;
  agentReferences: AgentReference[];
  runChildMessage?: typeof runDelegatedChildMessage;
}) {
  const runChildMessage = input.runChildMessage ?? runDelegatedChildMessage;
  return async ({
    agent,
    sessionId,
    prompt,
    toolCallId,
  }: {
    agent?: string;
    sessionId?: string;
    prompt: string;
    toolCallId: string;
  }) => {
    if (input.depth >= MAX_AGENT_DELEGATION_DEPTH) {
      return {
        ok: false,
        status: "failed",
        error: `Agent delegation depth limit of ${MAX_AGENT_DELEGATION_DEPTH} was reached.`,
      };
    }

    if (sessionId) {
      return resumeDelegatedAgentSession({
        childSessionId: sessionId,
        prompt,
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        parentRunLeaseId: input.parentRunLeaseId,
        parentRunLeaseOwner: input.parentRunLeaseOwner,
        parentToolCallId: toolCallId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        env: input.env,
        signal: input.signal,
        checkAbort: input.checkAbort,
        depth: input.depth,
        runChildMessage,
      });
    }

    if (!agent) {
      return {
        ok: false,
        status: "failed",
        error: "Agent is required when starting a delegated session.",
      };
    }

    const targetReference = resolveDelegatedAgentReference(agent, input.agentReferences);
    if (!targetReference) {
      return {
        ok: false,
        status: "failed",
        error: `Agent ${agent} is not configured for delegation in this agent.`,
      };
    }

    const target = await loadDelegatedAgent(input.workspaceId, targetReference.path);
    if (!target) {
      return {
        ok: false,
        status: "failed",
        agentPath: targetReference.path,
        error: `Agent ${targetReference.path} was not found in this workspace.`,
      };
    }

    const childSessionId = newAgentSessionId();
    const childMessageId = newAgentSessionMessageId();
    await createDelegatedAgentSession({
      sessionId: childSessionId,
      messageId: childMessageId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: target.id,
      agentName: target.name,
      modelProvider: target.config.model.provider,
      modelName: target.config.model.name,
      prompt,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      toolCallId,
    });

    const runResult = await traceBraintrustStep(
      "delegate_to_agent.run_child_message",
      () =>
        runChildMessage({
          sessionId: childSessionId,
          messageId: childMessageId,
          env: input.env,
          signal: input.signal,
          checkAbort: input.checkAbort,
          depth: input.depth,
        }),
      {
        parent_session_id: input.parentSessionId,
        parent_message_id: input.parentMessageId,
        child_session_id: childSessionId,
        child_message_id: childMessageId,
        child_agent_id: target.id,
        child_agent_path: target.path,
        tool_call_id: toolCallId,
        delegation_depth: input.depth + 1,
      },
    );
    if (runResult) {
      await emitDelegatedUsageRollupForLease({
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        parentRunLeaseId: input.parentRunLeaseId,
        parentRunLeaseOwner: input.parentRunLeaseOwner,
        childSessionId,
        parentToolCallId: toolCallId,
      });
      return {
        ...runResult,
        childSessionId,
        agentName: target.name,
        agentPath: target.path,
      };
    }

    const assistant = await loadAssistantResponseForMessage(childSessionId, childMessageId);
    if (!assistant?.content.trim()) {
      await emitDelegatedUsageRollupForLease({
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        parentRunLeaseId: input.parentRunLeaseId,
        parentRunLeaseOwner: input.parentRunLeaseOwner,
        childSessionId,
        parentToolCallId: toolCallId,
      });
      return {
        ok: false,
        status: "failed",
        childSessionId,
        agentName: target.name,
        agentPath: target.path,
        error: "Delegated agent completed without a final answer.",
      };
    }

    await emitDelegatedUsageRollupForLease({
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentRunLeaseId: input.parentRunLeaseId,
      parentRunLeaseOwner: input.parentRunLeaseOwner,
      childSessionId,
      parentToolCallId: toolCallId,
    });

    return {
      ok: true,
      status: "completed",
      childSessionId,
      agentName: target.name,
      agentPath: target.path,
      answer: assistant.content,
    };
  };
}

async function resumeDelegatedAgentSession(input: {
  childSessionId: string;
  prompt: string;
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  parentToolCallId: string;
  workspaceId: string;
  userId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  depth: number;
  runChildMessage: typeof runDelegatedChildMessage;
}) {
  const child = await loadDelegatedChildSession({
    sessionId: input.childSessionId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!child) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      error: `Delegated child session ${input.childSessionId} was not found.`,
    };
  }
  if (child.parentSessionId !== input.parentSessionId) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      error: `Session ${input.childSessionId} is not a child session of this agent session.`,
    };
  }
  if (child.archivedAt) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath,
      error: `Delegated child session ${input.childSessionId} is archived.`,
    };
  }
  if (isDelegatedChildSessionBusy(child)) {
    return {
      ok: false,
      status: "failed",
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath,
      error: `Delegated child session ${input.childSessionId} is already running.`,
    };
  }

  const childMessageId = await appendDelegatedChildUserMessage({
    sessionId: input.childSessionId,
    prompt: input.prompt,
  });

  const runResult = await traceBraintrustStep(
    "delegate_to_agent.resume_child_message",
    () =>
      input.runChildMessage({
        sessionId: input.childSessionId,
        messageId: childMessageId,
        env: input.env,
        signal: input.signal,
        checkAbort: input.checkAbort,
        depth: input.depth,
      }),
    {
      parent_session_id: input.parentSessionId,
      parent_message_id: input.parentMessageId,
      child_session_id: input.childSessionId,
      child_message_id: childMessageId,
      tool_call_id: input.parentToolCallId,
      delegation_depth: input.depth + 1,
    },
  );
  if (runResult) {
    await emitDelegatedUsageRollupForLease({
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentRunLeaseId: input.parentRunLeaseId,
      parentRunLeaseOwner: input.parentRunLeaseOwner,
      childSessionId: input.childSessionId,
      parentToolCallId: input.parentToolCallId,
    });
    return {
      ...runResult,
      childSessionId: input.childSessionId,
      agentName: child.agentName,
      agentPath: child.agentPath,
    };
  }

  const assistant = await loadAssistantResponseForMessage(input.childSessionId, childMessageId);
  if (!assistant?.content.trim()) {
    await emitDelegatedUsageRollupForLease({
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentRunLeaseId: input.parentRunLeaseId,
      parentRunLeaseOwner: input.parentRunLeaseOwner,
      childSessionId: input.childSessionId,
      parentToolCallId: input.parentToolCallId,
    });
    return {
      ok: false,
      status: "failed",
      resumed: true,
      childSessionId: input.childSessionId,
      messageId: childMessageId,
      agentName: child.agentName,
      agentPath: child.agentPath,
      error: "Delegated agent completed without a final answer.",
    };
  }

  await emitDelegatedUsageRollupForLease({
    parentSessionId: input.parentSessionId,
    parentMessageId: input.parentMessageId,
    parentRunLeaseId: input.parentRunLeaseId,
    parentRunLeaseOwner: input.parentRunLeaseOwner,
    childSessionId: input.childSessionId,
    parentToolCallId: input.parentToolCallId,
  });

  return {
    ok: true,
    status: "completed",
    resumed: true,
    childSessionId: input.childSessionId,
    messageId: childMessageId,
    agentName: child.agentName,
    agentPath: child.agentPath,
    answer: assistant.content,
  };
}

async function emitDelegatedUsageRollupForLease(input: {
  parentSessionId: string;
  parentMessageId: string;
  parentRunLeaseId: string;
  parentRunLeaseOwner: string;
  childSessionId: string;
  parentToolCallId: string;
}) {
  const rollup = await loadSessionTreeUsageRollup(input.childSessionId);
  if (!hasUsageRollupValue(rollup)) return;
  const alreadyEmitted = await loadEmittedDelegatedUsageRollup({
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
  });
  const delta = subtractSessionTreeUsageRollup(rollup, alreadyEmitted);
  if (!hasUsageRollupValue(delta)) return;

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.parentSessionId,
      messageId: input.parentMessageId,
      leaseId: input.parentRunLeaseId,
      leaseOwner: input.parentRunLeaseOwner,
      type: "session.delegated_usage",
      payload: {
        childSessionId: input.childSessionId,
        parentToolCallId: input.parentToolCallId,
        usage: delta.usage,
        toolUsage: delta.toolUsage,
        cost: delta.cost,
      },
    }),
  );
}

type SessionTreeUsageRollup = {
  usage: {
    inputTokens: number;
    inputNoCacheTokens: number;
    inputCacheReadTokens: number;
    inputCacheWriteTokens: number;
    outputTokens: number;
    outputTextTokens: number;
    outputReasoningTokens: number;
    totalTokens: number;
  };
  toolUsage: {
    totalCostUsdMicros: number;
    byProviderOperation: Array<{
      provider: string;
      operation: string;
      costUsdMicros: number;
      calls: number;
    }>;
  };
  cost: {
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    totalCostUsdMicros: number;
    modelCostUsdMicros: number;
    toolCostUsdMicros: number;
  };
};

async function loadEmittedDelegatedUsageRollup(input: {
  parentSessionId: string;
  childSessionId: string;
}): Promise<SessionTreeUsageRollup> {
  const result = await getDb().execute(sql`
    SELECT payload AS "payload"
    FROM agent_session_events
    WHERE session_id = ${input.parentSessionId}
      AND type = 'session.delegated_usage'
      AND payload->>'childSessionId' = ${input.childSessionId}
  `);

  return rowsFromExecute<{ payload?: unknown }>(result).reduce(
    (total, row) => addSessionTreeUsageRollup(total, parseDelegatedUsagePayload(row.payload)),
    emptySessionTreeUsageRollup(),
  );
}

function parseDelegatedUsagePayload(value: unknown): SessionTreeUsageRollup {
  const payload = readJsonObject(value);
  const usage = readJsonObject(payload.usage);
  const toolUsage = readJsonObject(payload.toolUsage);
  const cost = readJsonObject(payload.cost);
  return {
    usage: {
      inputTokens: readNumber(usage.inputTokens),
      inputNoCacheTokens: readNumber(usage.inputNoCacheTokens),
      inputCacheReadTokens: readNumber(usage.inputCacheReadTokens),
      inputCacheWriteTokens: readNumber(usage.inputCacheWriteTokens),
      outputTokens: readNumber(usage.outputTokens),
      outputTextTokens: readNumber(usage.outputTextTokens),
      outputReasoningTokens: readNumber(usage.outputReasoningTokens),
      totalTokens: readNumber(usage.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: readNumber(toolUsage.totalCostUsdMicros),
      byProviderOperation: readToolUsageOperations(toolUsage.byProviderOperation),
    },
    cost: {
      providerCostUsdMicros: readNumber(cost.providerCostUsdMicros),
      platformFeeUsdMicros: readNumber(cost.platformFeeUsdMicros),
      totalCostUsdMicros: readNumber(cost.totalCostUsdMicros),
      modelCostUsdMicros: readNumber(cost.modelCostUsdMicros),
      toolCostUsdMicros: readNumber(cost.toolCostUsdMicros),
    },
  };
}

function emptySessionTreeUsageRollup(): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: 0,
      inputNoCacheTokens: 0,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      outputTextTokens: 0,
      outputReasoningTokens: 0,
      totalTokens: 0,
    },
    toolUsage: {
      totalCostUsdMicros: 0,
      byProviderOperation: [],
    },
    cost: {
      providerCostUsdMicros: 0,
      platformFeeUsdMicros: 0,
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
    },
  };
}

function addSessionTreeUsageRollup(
  left: SessionTreeUsageRollup,
  right: SessionTreeUsageRollup,
): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: left.usage.inputTokens + right.usage.inputTokens,
      inputNoCacheTokens: left.usage.inputNoCacheTokens + right.usage.inputNoCacheTokens,
      inputCacheReadTokens: left.usage.inputCacheReadTokens + right.usage.inputCacheReadTokens,
      inputCacheWriteTokens: left.usage.inputCacheWriteTokens + right.usage.inputCacheWriteTokens,
      outputTokens: left.usage.outputTokens + right.usage.outputTokens,
      outputTextTokens: left.usage.outputTextTokens + right.usage.outputTextTokens,
      outputReasoningTokens: left.usage.outputReasoningTokens + right.usage.outputReasoningTokens,
      totalTokens: left.usage.totalTokens + right.usage.totalTokens,
    },
    toolUsage: {
      totalCostUsdMicros: left.toolUsage.totalCostUsdMicros + right.toolUsage.totalCostUsdMicros,
      byProviderOperation: addToolUsageOperations(
        left.toolUsage.byProviderOperation,
        right.toolUsage.byProviderOperation,
      ),
    },
    cost: {
      providerCostUsdMicros: left.cost.providerCostUsdMicros + right.cost.providerCostUsdMicros,
      platformFeeUsdMicros: left.cost.platformFeeUsdMicros + right.cost.platformFeeUsdMicros,
      totalCostUsdMicros: left.cost.totalCostUsdMicros + right.cost.totalCostUsdMicros,
      modelCostUsdMicros: left.cost.modelCostUsdMicros + right.cost.modelCostUsdMicros,
      toolCostUsdMicros: left.cost.toolCostUsdMicros + right.cost.toolCostUsdMicros,
    },
  };
}

function subtractSessionTreeUsageRollup(
  total: SessionTreeUsageRollup,
  emitted: SessionTreeUsageRollup,
): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: subtractMetric(total.usage.inputTokens, emitted.usage.inputTokens),
      inputNoCacheTokens: subtractMetric(
        total.usage.inputNoCacheTokens,
        emitted.usage.inputNoCacheTokens,
      ),
      inputCacheReadTokens: subtractMetric(
        total.usage.inputCacheReadTokens,
        emitted.usage.inputCacheReadTokens,
      ),
      inputCacheWriteTokens: subtractMetric(
        total.usage.inputCacheWriteTokens,
        emitted.usage.inputCacheWriteTokens,
      ),
      outputTokens: subtractMetric(total.usage.outputTokens, emitted.usage.outputTokens),
      outputTextTokens: subtractMetric(
        total.usage.outputTextTokens,
        emitted.usage.outputTextTokens,
      ),
      outputReasoningTokens: subtractMetric(
        total.usage.outputReasoningTokens,
        emitted.usage.outputReasoningTokens,
      ),
      totalTokens: subtractMetric(total.usage.totalTokens, emitted.usage.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: subtractMetric(
        total.toolUsage.totalCostUsdMicros,
        emitted.toolUsage.totalCostUsdMicros,
      ),
      byProviderOperation: subtractToolUsageOperations(
        total.toolUsage.byProviderOperation,
        emitted.toolUsage.byProviderOperation,
      ),
    },
    cost: {
      providerCostUsdMicros: subtractMetric(
        total.cost.providerCostUsdMicros,
        emitted.cost.providerCostUsdMicros,
      ),
      platformFeeUsdMicros: subtractMetric(
        total.cost.platformFeeUsdMicros,
        emitted.cost.platformFeeUsdMicros,
      ),
      totalCostUsdMicros: subtractMetric(
        total.cost.totalCostUsdMicros,
        emitted.cost.totalCostUsdMicros,
      ),
      modelCostUsdMicros: subtractMetric(
        total.cost.modelCostUsdMicros,
        emitted.cost.modelCostUsdMicros,
      ),
      toolCostUsdMicros: subtractMetric(
        total.cost.toolCostUsdMicros,
        emitted.cost.toolCostUsdMicros,
      ),
    },
  };
}

function addToolUsageOperations(
  left: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
  right: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
) {
  const byKey = new Map<string, (typeof left)[number]>();
  for (const row of [...left, ...right]) {
    const key = `${row.provider}:${row.operation}`;
    const current = byKey.get(key) ?? {
      provider: row.provider,
      operation: row.operation,
      costUsdMicros: 0,
      calls: 0,
    };
    current.costUsdMicros += row.costUsdMicros;
    current.calls += row.calls;
    byKey.set(key, current);
  }
  return Array.from(byKey.values()).sort((leftRow, rightRow) =>
    `${leftRow.provider}:${leftRow.operation}`.localeCompare(
      `${rightRow.provider}:${rightRow.operation}`,
    ),
  );
}

function subtractToolUsageOperations(
  total: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
  emitted: SessionTreeUsageRollup["toolUsage"]["byProviderOperation"],
) {
  const emittedByKey = new Map(
    emitted.map((row) => [`${row.provider}:${row.operation}`, row] as const),
  );
  return total
    .map((row) => {
      const emittedRow = emittedByKey.get(`${row.provider}:${row.operation}`);
      return {
        provider: row.provider,
        operation: row.operation,
        costUsdMicros: subtractMetric(row.costUsdMicros, emittedRow?.costUsdMicros ?? 0),
        calls: subtractMetric(row.calls, emittedRow?.calls ?? 0),
      };
    })
    .filter((row) => row.costUsdMicros > 0 || row.calls > 0);
}

function subtractMetric(total: number, emitted: number) {
  return Math.max(total - emitted, 0);
}

async function loadSessionTreeUsageRollup(sessionId: string): Promise<SessionTreeUsageRollup> {
  const result = await getDb().execute(sql`
    WITH RECURSIVE session_tree(id, path) AS (
      SELECT id, ARRAY[id]::text[]
      FROM agent_sessions
      WHERE id = ${sessionId}
      UNION ALL
      SELECT child.id, session_tree.path || child.id
      FROM agent_sessions child
      INNER JOIN session_tree ON child.parent_session_id = session_tree.id
      WHERE NOT child.id = ANY(session_tree.path)
    ),
    usage_totals AS (
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(input_no_cache_tokens), 0) AS input_no_cache_tokens,
        COALESCE(SUM(input_cache_read_tokens), 0) AS input_cache_read_tokens,
        COALESCE(SUM(input_cache_write_tokens), 0) AS input_cache_write_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(output_text_tokens), 0) AS output_text_tokens,
        COALESCE(SUM(output_reasoning_tokens), 0) AS output_reasoning_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM agent_session_usage
      WHERE session_id IN (SELECT id FROM session_tree)
    ),
    cost_totals AS (
      SELECT
        COALESCE(SUM(provider_cost_usd_micros), 0) AS provider_cost_usd_micros,
        COALESCE(SUM(platform_fee_usd_micros), 0) AS platform_fee_usd_micros,
        COALESCE(SUM(-amount_usd_micros), 0) AS total_cost_usd_micros,
        COALESCE(SUM(-amount_usd_micros) FILTER (WHERE source = 'model_usage'), 0) AS model_cost_usd_micros,
        COALESCE(SUM(-amount_usd_micros) FILTER (WHERE source = 'tool_usage'), 0) AS tool_cost_usd_micros
      FROM workspace_credit_ledger
      WHERE session_id IN (SELECT id FROM session_tree)
        AND amount_usd_micros < 0
    ),
    tool_usage_rows AS (
      SELECT
        provider,
        operation,
        COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
        COUNT(*)::int AS calls
      FROM agent_session_tool_usage
      WHERE session_id IN (SELECT id FROM session_tree)
      GROUP BY provider, operation
    ),
    tool_totals AS (
      SELECT
        COALESCE(SUM(cost_usd_micros), 0) AS tool_usage_cost_usd_micros,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'provider', provider,
              'operation', operation,
              'costUsdMicros', cost_usd_micros,
              'calls', calls
            )
            ORDER BY provider, operation
          ),
          '[]'::jsonb
        ) AS tool_usage_by_provider_operation
      FROM tool_usage_rows
    )
    SELECT
      usage_totals.input_tokens AS "inputTokens",
      usage_totals.input_no_cache_tokens AS "inputNoCacheTokens",
      usage_totals.input_cache_read_tokens AS "inputCacheReadTokens",
      usage_totals.input_cache_write_tokens AS "inputCacheWriteTokens",
      usage_totals.output_tokens AS "outputTokens",
      usage_totals.output_text_tokens AS "outputTextTokens",
      usage_totals.output_reasoning_tokens AS "outputReasoningTokens",
      usage_totals.total_tokens AS "totalTokens",
      cost_totals.provider_cost_usd_micros AS "providerCostUsdMicros",
      cost_totals.platform_fee_usd_micros AS "platformFeeUsdMicros",
      cost_totals.total_cost_usd_micros AS "totalCostUsdMicros",
      cost_totals.model_cost_usd_micros AS "modelCostUsdMicros",
      cost_totals.tool_cost_usd_micros AS "toolCostUsdMicros",
      tool_totals.tool_usage_cost_usd_micros AS "toolUsageTotalCostUsdMicros",
      tool_totals.tool_usage_by_provider_operation AS "toolUsageByProviderOperation"
    FROM usage_totals
    CROSS JOIN cost_totals
    CROSS JOIN tool_totals
  `);

  const row = rowsFromExecute<Record<string, unknown>>(result)[0] ?? {};
  return parseSessionTreeUsageRollup(row);
}

function parseSessionTreeUsageRollup(row: Record<string, unknown>): SessionTreeUsageRollup {
  return {
    usage: {
      inputTokens: readNumber(row.inputTokens),
      inputNoCacheTokens: readNumber(row.inputNoCacheTokens),
      inputCacheReadTokens: readNumber(row.inputCacheReadTokens),
      inputCacheWriteTokens: readNumber(row.inputCacheWriteTokens),
      outputTokens: readNumber(row.outputTokens),
      outputTextTokens: readNumber(row.outputTextTokens),
      outputReasoningTokens: readNumber(row.outputReasoningTokens),
      totalTokens: readNumber(row.totalTokens),
    },
    toolUsage: {
      totalCostUsdMicros: readNumber(row.toolUsageTotalCostUsdMicros),
      byProviderOperation: readToolUsageOperations(row.toolUsageByProviderOperation),
    },
    cost: {
      providerCostUsdMicros: readNumber(row.providerCostUsdMicros),
      platformFeeUsdMicros: readNumber(row.platformFeeUsdMicros),
      totalCostUsdMicros: readNumber(row.totalCostUsdMicros),
      modelCostUsdMicros: readNumber(row.modelCostUsdMicros),
      toolCostUsdMicros: readNumber(row.toolCostUsdMicros),
    },
  };
}

function hasUsageRollupValue(rollup: SessionTreeUsageRollup) {
  return (
    rollup.usage.totalTokens > 0 ||
    rollup.cost.totalCostUsdMicros > 0 ||
    rollup.toolUsage.byProviderOperation.length > 0
  );
}

function readToolUsageOperations(value: unknown) {
  return readJsonArray(value)
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      provider: typeof row.provider === "string" ? row.provider : "",
      operation: typeof row.operation === "string" ? row.operation : "",
      costUsdMicros: readNumber(row.costUsdMicros),
      calls: readNumber(row.calls),
    }))
    .filter((row) => row.provider && row.operation);
}

function readJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function resolveDelegatedAgentReference(agent: string, references: AgentReference[]) {
  const normalized = normalizeDelegatedAgentKey(agent);
  return references.find((reference) => {
    const path = reference.path;
    const slug =
      path.startsWith("agents/") && path.endsWith(".agent")
        ? path.slice("agents/".length, -".agent".length)
        : "";
    const mention = path.startsWith("agents/") && path.endsWith(".agent") ? `agent/${slug}` : "";
    return (
      normalizeDelegatedAgentKey(path) === normalized ||
      normalizeDelegatedAgentKey(mention) === normalized ||
      normalizeDelegatedAgentKey(slug) === normalized ||
      normalizeDelegatedAgentKey(reference.name) === normalized
    );
  });
}

function normalizeDelegatedAgentKey(value: string) {
  return value
    .trim()
    .replace(/^@/, "")
    .replace(/\.agent$/i, "")
    .toLowerCase();
}

async function loadDelegatedAgent(workspaceId: string, path: string) {
  const [agent] = await getDb()
    .select({
      id: agents.id,
      name: agents.name,
      path: agents.path,
      config: agents.config,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.path, path)))
    .limit(1);

  return agent ? { ...agent, config: normalizeAgentConfig(agent.config) } : null;
}

async function loadDelegatedChildSession(input: {
  sessionId: string;
  workspaceId: string;
  userId: string;
}) {
  const [session] = await getDb()
    .select({
      id: agentSessions.id,
      workspaceId: agentSessions.workspaceId,
      userId: agentSessions.userId,
      agentId: agentSessions.agentId,
      agentName: agents.name,
      agentPath: agents.path,
      status: agentSessions.status,
      source: agentSessions.source,
      parentSessionId: agentSessions.parentSessionId,
      runLeaseId: agentSessions.runLeaseId,
      archivedAt: agentSessions.archivedAt,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        eq(agentSessions.id, input.sessionId),
        eq(agentSessions.workspaceId, input.workspaceId),
        eq(agentSessions.userId, input.userId),
        eq(agentSessions.source, "agent"),
      ),
    )
    .limit(1);

  return session ?? null;
}

function isDelegatedChildSessionBusy(
  session: NonNullable<Awaited<ReturnType<typeof loadDelegatedChildSession>>>,
) {
  return (
    Boolean(session.runLeaseId) ||
    ["provisioning", "running", "aborting", "archiving"].includes(session.status)
  );
}

async function appendDelegatedChildUserMessage(input: { sessionId: string; prompt: string }) {
  const now = new Date();
  const messageId = newAgentSessionMessageId();

  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessionMessages).values({
      id: messageId,
      sessionId: input.sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      messageId,
      type: "message.created",
      payload: {
        messageId,
        role: "user",
        content: input.prompt,
        status: "completed",
      },
    });
  });

  return messageId;
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

async function createDelegatedAgentSession(input: {
  sessionId: string;
  messageId: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  agentName: string;
  modelProvider: string;
  modelName: string;
  prompt: string;
  parentSessionId: string;
  parentMessageId: string;
  toolCallId: string;
}) {
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      id: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      title: delegationSessionTitle(input.agentName, input.prompt),
      source: "agent",
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      parentSessionId: input.parentSessionId,
      parentMessageId: input.parentMessageId,
      parentToolCallId: input.toolCallId,
    });
    await tx.insert(agentSessionMessages).values({
      id: input.messageId,
      sessionId: input.sessionId,
      role: "user",
      status: "completed",
      content: input.prompt,
      modelMessage: { role: "user", content: input.prompt },
      completedAt: now,
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      type: "session.status",
      payload: {
        status: "created",
        message: "Delegated agent session created",
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        toolCallId: input.toolCallId,
      },
    });
    await tx.insert(agentSessionEvents).values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      type: "message.created",
      payload: {
        messageId: input.messageId,
        role: "user",
        content: input.prompt,
        status: "completed",
      },
    });
  });
}

function delegationSessionTitle(agentName: string, prompt: string) {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const suffix = firstLine ? `: ${firstLine}` : "";
  const title = `${agentName}${suffix}`;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

type SandboxAcquirer = {
  get: () => Promise<SandboxHandle>;
  readonly current: SandboxHandle | null;
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
  let sandboxPromise: Promise<SandboxHandle> | null = null;

  const get = async () => {
    if (sandbox) return sandbox;
    if (sandboxPromise) return sandboxPromise;

    sandboxPromise = (async () => {
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
      sandboxPromise = null;
      throw error;
    });

    return sandboxPromise;
  };

  return {
    get,
    get current() {
      return sandbox;
    },
  };
}

async function streamAssistantResponse(input: {
  ctx: RunContext;
  runtime: ReturnType<typeof resolveAgentRuntimeConfig>;
  system: string;
  messages: ModelMessage[];
  tools: ReturnType<typeof createToolSet>;
  mcpContext: {
    internalMessages?: boolean;
    workspaceId: string;
    agentConfig: LoadedSession["agent"]["config"];
    signal: AbortSignal;
    checkAbort: RunControlCheck;
    observabilityContext?: {
      workspaceId?: string;
      userId?: string;
      agentId?: string;
      modelProvider?: string;
      modelName?: string;
    };
  };
  assistantMessageId: string;
  toolStartCoordinator: ToolStartCoordinator;
  checkAbort: RunControlCheck;
  extraStopConditions?: StopCondition<ToolSet>[];
}) {
  const gateway = ai.createGateway({ apiKey: input.ctx.env.vercelAiGatewayApiKey });
  const mcpToolSet = await observeRunStep(input.ctx, "create_mcp_tool_set", () =>
    createMcpToolSet({
      sessionId: input.ctx.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.ctx.leaseId,
      runLeaseOwner: input.ctx.leaseOwner,
      ...input.mcpContext,
      toolStartCoordinator: input.toolStartCoordinator,
    }),
  );
  const modelSystem = buildCacheableSystemPrompt(input.system, input.runtime.model.name);
  const selectedTools = {
    ...pickRuntimeTools(input.tools, input.runtime.tools),
    ...mcpToolSet.tools,
  };
  // Instrument the model call as an `llm` span manually rather than via Braintrust's `wrapAISDK`.
  // wrapAISDK closes the streaming span only when its patched result stream drains to completion
  // (there is no error/cancel handler on that path), so any abort, tool/stream error, or early
  // exit while we consume `result.fullStream` ourselves leaves the span stuck "in progress" with
  // no usage logged. `observeRunStep` -> `traceBraintrustStep` always calls `span.end()` in a
  // finally, so the span closes deterministically and we log usage/cost from data we collect.
  const modelInput = [
    ...(modelSystem ? [{ role: "system", content: modelSystem }] : []),
    ...input.messages,
  ];
  try {
    const streamStartedAt = Date.now();
    let firstStreamPartAt: number | undefined;
    return await observeRunStep(
      input.ctx,
      "model_stream_total",
      async (span) => {
        const result = ai.streamText({
          model: gateway(input.runtime.model.name),
          system: modelSystem,
          messages: input.messages,
          tools: selectedTools,
          stopWhen: [ai.stepCountIs(MAX_MODEL_STEPS), ...(input.extraStopConditions ?? [])],
          abortSignal: input.ctx.controller.signal,
          ...(input.runtime.model.providerOptions
            ? { providerOptions: input.runtime.model.providerOptions }
            : {}),
        });

        const collected = await collectAssistantStream({
          stream: result.fullStream,
          readFirstPart: async (iterator) => {
            return observeRunStep(input.ctx, "model_first_stream_part", () => iterator.next(), {
              model_provider: input.runtime.model.provider,
              model_name: input.runtime.model.name,
            });
          },
          onFirstOutputPart: () => {
            firstStreamPartAt ??= Date.now();
          },
          sessionId: input.ctx.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.ctx.leaseId,
          runLeaseOwner: input.ctx.leaseOwner,
          modelProvider: input.runtime.model.provider,
          modelName: input.runtime.model.name,
          exposeReasoningSummary: input.runtime.model.exposeReasoningSummary,
          signal: input.ctx.controller.signal,
          checkAbort: input.checkAbort,
          toolStartCoordinator: input.toolStartCoordinator,
        });
        // Log on the explicit span object (not `currentSpan()`): the AI SDK stream consumption can
        // run outside this span's async-context, which would silently drop a `currentSpan()` log
        // to a no-op span — leaving the span with no output/usage and stuck "in progress".
        logBraintrustSpan(span, {
          output: collected.reasoningSummary
            ? {
                role: "assistant",
                content: collected.assistantContent,
                reasoning: collected.reasoningSummary,
              }
            : { role: "assistant", content: collected.assistantContent },
          metrics: modelStreamMetrics(collected.modelSteps, streamStartedAt, firstStreamPartAt),
          metadata: {
            // Braintrust derives estimated cost from `metadata.model` + token metrics.
            model: input.runtime.model.name,
            assistant_message_id: input.assistantMessageId,
            model_provider: input.runtime.model.provider,
            model_name: input.runtime.model.name,
          },
        });
        return collected;
      },
      {
        model_provider: input.runtime.model.provider,
        model_name: input.runtime.model.name,
        assistant_message_id: input.assistantMessageId,
      },
      { type: "llm", input: modelInput },
    );
  } finally {
    await mcpToolSet.close();
  }
}

async function persistAssistantCompletion(input: {
  sessionId: string;
  assistantMessageId: string;
  leaseId: string;
  leaseOwner: string;
  assistantContent: string;
  assistantReplayParts: Awaited<ReturnType<typeof collectAssistantStream>>["assistantReplayParts"];
  reasoningSummary: Awaited<ReturnType<typeof collectAssistantStream>>["reasoningSummary"];
  internal: boolean;
}) {
  const persistedAssistantModelMessage = toPersistedModelMessage(
    buildAssistantModelMessage({
      content: input.assistantContent,
      parts: input.assistantReplayParts,
    }),
  );
  await requireLeaseWrite(
    completeAssistantMessageForLease({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      content: input.assistantContent,
      modelMessage: persistedAssistantModelMessage,
    }),
  );
  const normalizedReasoningSummary = normalizeReasoningSummary(input.reasoningSummary);
  logBraintrustCurrentSpan({
    output: {
      content: input.assistantContent,
      replayParts: input.assistantReplayParts,
      ...(normalizedReasoningSummary ? { reasoningSummary: normalizedReasoningSummary } : {}),
    },
    metadata: {
      assistant_message_id: input.assistantMessageId,
      internal: input.internal,
    },
  });
  if (normalizedReasoningSummary) {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        type: "message.reasoning_summary",
        payload: { messageId: input.assistantMessageId, summary: normalizedReasoningSummary },
      }),
    );
  }
  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      type: "message.completed",
      payload: {
        messageId: input.assistantMessageId,
        ...(input.internal ? { internal: true } : {}),
      },
    }),
  );
}

function modelStreamMetrics(
  modelSteps: Awaited<ReturnType<typeof collectAssistantStream>>["modelSteps"],
  streamStartedAt: number,
  firstStreamPartAt: number | undefined,
): LogFields {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;

  for (const step of modelSteps) {
    const usage = isRecord(step.usage) ? step.usage : {};
    inputTokens += readMetricNumber(usage.inputTokens) ?? readMetricNumber(usage.promptTokens) ?? 0;
    outputTokens +=
      readMetricNumber(usage.outputTokens) ?? readMetricNumber(usage.completionTokens) ?? 0;
    totalTokens += readMetricNumber(usage.totalTokens) ?? 0;
    cachedTokens += readMetricNumber(usage.cachedInputTokens) ?? 0;
    reasoningTokens += readMetricNumber(usage.reasoningTokens) ?? 0;
  }

  if (totalTokens === 0) totalTokens = inputTokens + outputTokens;

  return {
    ...(firstStreamPartAt
      ? { time_to_first_token: (firstStreamPartAt - streamStartedAt) / 1000 }
      : {}),
    ...(totalTokens ? { tokens: totalTokens } : {}),
    ...(inputTokens ? { prompt_tokens: inputTokens } : {}),
    ...(outputTokens ? { completion_tokens: outputTokens } : {}),
    ...(cachedTokens ? { prompt_cached_tokens: cachedTokens } : {}),
    ...(reasoningTokens ? { completion_reasoning_tokens: reasoningTokens } : {}),
    steps: modelSteps.length,
  };
}

function readMetricNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function finalizeRun(input: {
  ctx: RunContext;
  outcome: string;
  modelProvider: string | undefined;
  modelName: string | undefined;
  sandbox: SandboxHandle | null;
}) {
  clearActiveRun(input.ctx.sessionId, input.ctx.controller);
  logBraintrustCurrentSpan({
    metadata: {
      outcome: input.outcome,
      model_provider: input.modelProvider,
      model_name: input.modelName,
      sandbox_id: input.sandbox?.sandboxId,
      sandbox_hydrated: Boolean(input.sandbox),
    },
  });
  endTimingTrace(input.ctx.trace, {
    outcome: input.outcome,
    model_provider: input.modelProvider,
    model_name: input.modelName,
    sandbox_hydrated: Boolean(input.sandbox),
  });
  if (input.sandbox) {
    const sandbox = input.sandbox;
    await observeRunStep(
      input.ctx,
      "park_sandbox",
      () => parkSandboxWhenIdle(sandbox, input.ctx.env),
      { sandbox_id: sandbox.sandboxId },
    );
  }
}

async function captureTurnCompletedAnalytics(input: {
  ctx: RunContext;
  userId: string | undefined;
  workspaceId: string | undefined;
  agentId: string | undefined;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  modelProvider: string | undefined;
  modelName: string | undefined;
}) {
  if (
    !input.userId ||
    !input.workspaceId ||
    !input.agentId ||
    !input.modelProvider ||
    !input.modelName
  ) {
    return;
  }

  const [cost] = await input.ctx.db
    .select({
      providerCostUsdMicros: sql<number>`COALESCE(SUM(${workspaceCreditLedger.providerCostUsdMicros}), 0)`,
      platformFeeUsdMicros: sql<number>`COALESCE(SUM(${workspaceCreditLedger.platformFeeUsdMicros}), 0)`,
      totalCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}), 0)`,
      modelCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}) FILTER (WHERE ${workspaceCreditLedger.source} = 'model_usage'), 0)`,
      toolCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}) FILTER (WHERE ${workspaceCreditLedger.source} = 'tool_usage'), 0)`,
    })
    .from(workspaceCreditLedger)
    .where(
      and(
        eq(workspaceCreditLedger.workspaceId, input.workspaceId),
        eq(workspaceCreditLedger.sessionId, input.sessionId),
        eq(workspaceCreditLedger.messageId, input.assistantMessageId),
      ),
    );

  await captureServerEvent("session_turn_completed", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    session_id: input.sessionId,
    user_message_id: input.userMessageId,
    assistant_message_id: input.assistantMessageId,
    model_provider: input.modelProvider,
    model_name: input.modelName,
    provider_cost_usd_micros: cost?.providerCostUsdMicros ?? 0,
    platform_fee_usd_micros: cost?.platformFeeUsdMicros ?? 0,
    total_cost_usd_micros: cost?.totalCostUsdMicros ?? 0,
    model_cost_usd_micros: cost?.modelCostUsdMicros ?? 0,
    tool_cost_usd_micros: cost?.toolCostUsdMicros ?? 0,
  });
}

function linkExternalAbortSignal(controller: AbortController, signal: AbortSignal | undefined) {
  if (!signal) return;
  if (signal.aborted) {
    controller.abort();
    return;
  }
  signal.addEventListener("abort", () => controller.abort(), { once: true });
}

function braintrustError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

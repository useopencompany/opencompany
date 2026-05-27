import {
  newAgentSessionMessageId,
  newRunLeaseId,
  resolveAgentRuntimeConfig,
} from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { agentSessionMessages, workspaceCreditLedger } from "@opencompany/db/schema";
import {
  captureException,
  createLogger,
  endTimingTrace,
  startTimingTrace,
  timeAsync,
} from "@opencompany/observability";
import { createGateway, type ModelMessage, stepCountIs, streamText } from "ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { clearActiveRun, setActiveRun } from "./active-runs";
import { syncBrainFromSandbox } from "./brain";
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
import {
  appendAssistantTextPart,
  buildAssistantModelMessage,
  buildModelMessages,
  toPersistedModelMessage,
} from "./model-messages";
import { collectAssistantStream } from "./model-stream-runner";
import {
  checkRunControl,
  maybeHeartbeatRunLease,
  RunAbortError,
  RunLeaseLostError,
} from "./run-control";
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
  loadSession,
  loadUserMessage,
  optionalUserName,
  parkSandboxWhenIdle,
  setStatus,
  startSession,
} from "./session-lifecycle";
import { buildCacheableSystemPrompt, normalizeReasoningSummary } from "./stream-helpers";
import { createHostedToolBudget, createToolSet, pickRuntimeTools } from "./tool-dispatcher";

export {
  buildAmpCommand,
  createAmpActivityFormatter,
  createAmpStreamAccumulator,
} from "./amp-tool";
export {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
} from "./lease-writes";
export { abortSession, archiveSession, startSession } from "./session-lifecycle";
export {
  normalizeReasoningSummary,
  readReasoningTextDelta,
  throwIfStreamErrorPart,
} from "./stream-helpers";
export { createHostedToolBudget, executeRuntimeTool } from "./tool-dispatcher";
export { recordStepUsage, recordToolUsage } from "./usage-recorder";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export async function runMessage(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
}) {
  const ctx = createRunContext("runner.run_message", input);
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

  try {
    const row = await timeAsync(ctx.trace, "load_session", () => loadSession(input.sessionId));
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    workspaceId = row.workspace.id;
    userId = row.session.userId;
    agentId = row.agent.id;

    if (
      !(await timeAsync(ctx.trace, "check_workspace_credits", () =>
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

    const userMessage = await timeAsync(ctx.trace, "load_user_message", () =>
      loadUserMessage(input.sessionId, input.messageId),
    );
    if (!userMessage) {
      outcome = "skipped_missing_user_message";
      return;
    }

    const existingAssistantResponse = await timeAsync(
      ctx.trace,
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

    const runtime = resolveAgentRuntimeConfig({
      agent: row.agent.config,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserName(row.user),
    });
    modelProvider = runtime.model.provider;
    modelName = runtime.model.name;

    const lease = await timeAsync(ctx.trace, "acquire_run_lease", () =>
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
    await timeAsync(ctx.trace, "initial_run_control_check", checkAbort);
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

    const assistantCreated = await timeAsync(ctx.trace, "create_assistant_message", () =>
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

    const storedMessages = await timeAsync(ctx.trace, "load_model_messages", () =>
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

    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      runLeaseId: ctx.leaseId,
      runLeaseOwner: ctx.leaseOwner,
      workspaceId: row.workspace.id,
      agentConfig: row.agent.config,
      getSandbox: sandboxAcquirer.get,
      workdir: row.session.workdir,
      env: input.env,
      enabledTools: runtime.tools,
      repository: row.repository,
      signal: ctx.controller.signal,
      checkAbort,
      observabilityContext: { workspaceId, userId, agentId, modelProvider, modelName },
      toolBudget: createHostedToolBudget(),
    });

    const { assistantContent, assistantReplayParts, reasoningSummary } =
      await streamAssistantResponse({
        ctx,
        runtime,
        system: runtime.systemPrompt,
        messages,
        tools,
        assistantMessageId,
        checkAbort,
      });

    if (sandboxAcquirer.current) {
      const activeSandbox = sandboxAcquirer.current;
      await timeAsync(ctx.trace, "sync_brain_after_message", () =>
        syncBrainFromSandbox({
          sandbox: activeSandbox,
          sessionId: input.sessionId,
          workspaceId: row.workspace.id,
          workdir: row.session.workdir,
          repository: row.repository,
        }),
      );
    }

    await checkAbort();
    if (!assistantContent && assistantReplayParts.length === 0) {
      throw new Error("Model stream completed without text or tool calls.");
    }

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
    await timeAsync(ctx.trace, "capture_turn_analytics", () =>
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
}

export async function runAfterSession(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
  externalSignal?: AbortSignal;
}) {
  const ctx = createRunContext("runner.run_after_session", input);
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
    const row = await timeAsync(ctx.trace, "load_session", () => loadSession(input.sessionId));
    workspaceId = row.workspace.id;
    userId = row.session.userId;
    agentId = row.agent.id;

    const afterSession = row.agent.config.afterSession;
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    if (!afterSession?.enabled || !afterSession.prompt.trim()) {
      outcome = "skipped_disabled";
      return;
    }

    const latestUserMessage = await timeAsync(ctx.trace, "load_latest_user_message", () =>
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

    const afterRun = await createAfterSessionRun({
      sessionId: input.sessionId,
      workspaceId: row.workspace.id,
      agentId: row.agent.id,
      lastUserMessageId: input.messageId,
      agentVersion: row.agent.version,
      runLeaseId: ctx.leaseId,
    });
    if (!afterRun) {
      outcome = "skipped_duplicate";
      return;
    }
    afterSessionRunId = afterRun.id;

    if (
      !(await timeAsync(ctx.trace, "check_workspace_credits", () =>
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
      agent: row.agent.config,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
      ...optionalUserName(row.user),
    });
    modelProvider = runtime.model.provider;
    modelName = runtime.model.name;

    const lease = await timeAsync(ctx.trace, "acquire_run_lease", () =>
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
    await timeAsync(ctx.trace, "initial_run_control_check", checkAbort);
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

    const assistantCreated = await timeAsync(ctx.trace, "create_internal_assistant_message", () =>
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

    const storedMessages = await timeAsync(ctx.trace, "load_model_messages", () =>
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

    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      runLeaseId: ctx.leaseId,
      runLeaseOwner: ctx.leaseOwner,
      internalMessages: true,
      workspaceId: row.workspace.id,
      agentConfig: row.agent.config,
      getSandbox: sandboxAcquirer.get,
      workdir: row.session.workdir,
      env: input.env,
      enabledTools: runtime.tools,
      repository: row.repository,
      signal: ctx.controller.signal,
      checkAbort,
      observabilityContext: { workspaceId, userId, agentId, modelProvider, modelName },
      toolBudget: createHostedToolBudget(),
    });

    let { assistantContent, assistantReplayParts, reasoningSummary } =
      await streamAssistantResponse({
        ctx,
        runtime,
        system: `${runtime.systemPrompt}\n\nThis is an internal after-session run. Do not address the user; any final text is stored internally and not shown in chat, so keep it brief. Use mounted Brain files under ./brain to capture durable, long-lived context from the transcript when worthwhile, and skip the update if nothing is worth preserving.`,
        messages,
        tools,
        assistantMessageId,
        checkAbort,
      });

    if (sandboxAcquirer.current) {
      const activeSandbox = sandboxAcquirer.current;
      await timeAsync(ctx.trace, "sync_brain_after_session", () =>
        syncBrainFromSandbox({
          sandbox: activeSandbox,
          sessionId: input.sessionId,
          workspaceId: row.workspace.id,
          workdir: row.session.workdir,
          repository: row.repository,
        }),
      );
    }

    await checkAbort();
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
      return;
    }

    const message =
      ctx.controller.signal.aborted || error instanceof RunAbortError
        ? "After-session run aborted."
        : error instanceof Error
          ? error.message
          : "Unknown after-session error";
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

function createLeaseAbortCheck(ctx: RunContext) {
  let lastHeartbeatAt = Date.now();
  return async () => {
    const heartbeat = await maybeHeartbeatRunLease({ ...ctx.runLease, lastHeartbeatAt });
    lastHeartbeatAt = heartbeat.heartbeatAt;
    if (!heartbeat.leaseActive) {
      ctx.controller.abort();
      throw new RunLeaseLostError();
    }
    await checkRunControl({ ...ctx.runLease, controller: ctx.controller });
  };
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
  checkAbort: () => Promise<void>;
  onHydrated: (sandbox: SandboxHandle) => void;
}): SandboxAcquirer {
  let sandbox: SandboxHandle | null = null;
  let sandboxPromise: Promise<SandboxHandle> | null = null;

  const get = async () => {
    if (sandbox) return sandbox;
    if (sandboxPromise) return sandboxPromise;

    sandboxPromise = (async () => {
      const hydrated = await timeAsync(
        input.trace,
        "ensure_sandbox",
        () => ensureSandbox(input.row, input.env),
        { existing_sandbox: Boolean(input.row.session.e2bSandboxId) },
      );
      await input.checkAbort();
      const updated = await timeAsync(input.trace, "update_sandbox_for_lease", () =>
        updateSandboxForLease(
          input.row.session.id,
          input.leaseId,
          input.leaseOwner,
          hydrated.sandboxId,
        ),
      );
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
  assistantMessageId: string;
  checkAbort: () => Promise<void>;
}) {
  const gateway = createGateway({ apiKey: input.ctx.env.vercelAiGatewayApiKey });
  const result = streamText({
    model: gateway(input.runtime.model.name),
    system: buildCacheableSystemPrompt(input.system, input.runtime.model.name),
    messages: input.messages,
    tools: pickRuntimeTools(input.tools, input.runtime.tools),
    stopWhen: stepCountIs(8),
    abortSignal: input.ctx.controller.signal,
    ...(input.runtime.model.providerOptions
      ? { providerOptions: input.runtime.model.providerOptions }
      : {}),
  });

  return timeAsync(input.ctx.trace, "model_stream_total", () =>
    collectAssistantStream({
      stream: result.fullStream,
      readFirstPart: (iterator) =>
        timeAsync(input.ctx.trace, "model_first_stream_part", () => iterator.next(), {
          model_provider: input.runtime.model.provider,
          model_name: input.runtime.model.name,
        }),
      sessionId: input.ctx.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.ctx.leaseId,
      runLeaseOwner: input.ctx.leaseOwner,
      modelProvider: input.runtime.model.provider,
      modelName: input.runtime.model.name,
      exposeReasoningSummary: input.runtime.model.exposeReasoningSummary,
      signal: input.ctx.controller.signal,
      checkAbort: input.checkAbort,
    }),
  );
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
        content: input.assistantContent,
        modelMessage: persistedAssistantModelMessage,
        ...(input.internal ? { internal: true } : {}),
      },
    }),
  );
}

async function finalizeRun(input: {
  ctx: RunContext;
  outcome: string;
  modelProvider: string | undefined;
  modelName: string | undefined;
  sandbox: SandboxHandle | null;
}) {
  clearActiveRun(input.ctx.sessionId, input.ctx.controller);
  endTimingTrace(input.ctx.trace, {
    outcome: input.outcome,
    model_provider: input.modelProvider,
    model_name: input.modelName,
    sandbox_hydrated: Boolean(input.sandbox),
  });
  if (input.sandbox) {
    const sandbox = input.sandbox;
    await timeAsync(input.ctx.trace, "park_sandbox", () =>
      parkSandboxWhenIdle(sandbox, input.ctx.env),
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

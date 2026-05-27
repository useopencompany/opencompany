import {
  newAgentSessionMessageId,
  newRunLeaseId,
  resolveAgentRuntimeConfig,
} from "@opencompany/agent-runtime";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { agentSessionMessages } from "@opencompany/db/schema";
import {
  captureException,
  createLogger,
  endTimingTrace,
  startTimingTrace,
  timeAsync,
} from "@opencompany/observability";
import { createGateway, type ModelMessage, stepCountIs, streamText } from "ai";
import { asc, eq } from "drizzle-orm";
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

export async function runMessage(input: { sessionId: string; messageId: string; env: RunnerEnv }) {
  const db = getDb();
  const trace = startTimingTrace("runner.run_message", {
    session_id: input.sessionId,
    message_id: input.messageId,
    runner_instance_id: input.env.instanceId,
  });
  const controller = new AbortController();
  const leaseId = newRunLeaseId();
  const leaseOwner = input.env.instanceId;
  const runLease = { sessionId: input.sessionId, leaseId, leaseOwner };
  let assistantMessageId = newAgentSessionMessageId();
  let sandbox: SandboxHandle | null = null;
  let sandboxPromise: Promise<SandboxHandle> | null = null;
  let leaseAcquired = false;
  let lastHeartbeatAt = 0;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let agentId: string | undefined;
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  let sandboxId: string | undefined;
  let outcome = "unknown";

  try {
    const row = await timeAsync(trace, "load_session", () => loadSession(input.sessionId));
    if (row.session.archivedAt) {
      outcome = "skipped_archived";
      return;
    }
    workspaceId = row.workspace.id;
    userId = row.session.userId;
    agentId = row.agent.id;
    if (
      !(await timeAsync(trace, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db, workspaceId: row.session.workspaceId }),
      ))
    ) {
      outcome = "skipped_no_credits";
      await setStatus(input.sessionId, "ready");
      await appendRuntimeEvent(db, {
        sessionId: input.sessionId,
        type: "session.status",
        payload: { status: "ready", message: "Add workspace credits to continue running agents." },
      });
      return;
    }

    const userMessage = await timeAsync(trace, "load_user_message", () =>
      loadUserMessage(input.sessionId, input.messageId),
    );
    if (!userMessage) {
      outcome = "skipped_missing_user_message";
      return;
    }

    const existingAssistantResponse = await timeAsync(
      trace,
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

    const lease = await timeAsync(trace, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: input.messageId,
        leaseId,
        leaseOwner,
        modelProvider: runtime.model.provider,
        modelName: runtime.model.name,
      }),
    );
    if (!lease) {
      outcome = "skipped_lease_busy";
      return;
    }

    leaseAcquired = true;
    lastHeartbeatAt = Date.now();
    setActiveRun(input.sessionId, leaseId, controller);

    const checkAbort = async () => {
      const heartbeat = await maybeHeartbeatRunLease({ ...runLease, lastHeartbeatAt });
      lastHeartbeatAt = heartbeat.heartbeatAt;
      if (!heartbeat.leaseActive) {
        controller.abort();
        throw new RunLeaseLostError();
      }
      await checkRunControl({ ...runLease, controller });
    };

    await timeAsync(trace, "initial_run_control_check", checkAbort);
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

    await requireLeaseWrite(
      timeAsync(trace, "append_running_status", () =>
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: null,
          leaseId,
          leaseOwner,
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

    const gateway = createGateway({ apiKey: input.env.vercelAiGatewayApiKey });

    const assistantCreated = await timeAsync(trace, "create_assistant_message", () =>
      createAssistantMessageForLease({
        id: assistantMessageId,
        sessionId: input.sessionId,
        responseToMessageId: input.messageId,
        leaseId,
        leaseOwner,
      }),
    );
    if (!assistantCreated) {
      outcome = "skipped_assistant_exists";
      await releaseRunLease(input.sessionId, leaseId, leaseOwner, "completed");
      return;
    }

    const storedMessages = await timeAsync(trace, "load_model_messages", () =>
      db
        .select()
        .from(agentSessionMessages)
        .where(eq(agentSessionMessages.sessionId, input.sessionId))
        .orderBy(asc(agentSessionMessages.createdAt)),
    );
    const messages = buildModelMessages(
      storedMessages.filter((message) => message.id !== assistantMessageId && !message.internal),
    );
    const getSandbox = async () => {
      if (sandbox) return sandbox;
      if (sandboxPromise) return sandboxPromise;

      sandboxPromise = (async () => {
        const hydratedSandbox = await timeAsync(
          trace,
          "ensure_sandbox",
          () => ensureSandbox(row, input.env),
          {
            existing_sandbox: Boolean(row.session.e2bSandboxId),
          },
        );
        await checkAbort();
        const updated = await timeAsync(trace, "update_sandbox_for_lease", () =>
          updateSandboxForLease(input.sessionId, leaseId, leaseOwner, hydratedSandbox.sandboxId),
        );
        if (!updated) {
          await killSandbox(hydratedSandbox.sandboxId);
          throw new StaleRunLeaseError();
        }

        sandbox = hydratedSandbox;
        sandboxId = hydratedSandbox.sandboxId;
        return hydratedSandbox;
      })().catch((error) => {
        sandboxPromise = null;
        throw error;
      });

      return sandboxPromise;
    };
    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      runLeaseId: leaseId,
      runLeaseOwner: leaseOwner,
      workspaceId: row.workspace.id,
      agentConfig: row.agent.config,
      getSandbox,
      workdir: row.session.workdir,
      env: input.env,
      enabledTools: runtime.tools,
      repository: row.repository,
      signal: controller.signal,
      checkAbort,
      observabilityContext: {
        workspaceId,
        userId,
        agentId,
        modelProvider,
        modelName,
      },
      toolBudget: createHostedToolBudget(),
    });

    const result = streamText({
      model: gateway(runtime.model.name),
      system: buildCacheableSystemPrompt(runtime.systemPrompt, runtime.model.name),
      messages,
      tools: pickRuntimeTools(tools, runtime.tools),
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      ...(runtime.model.providerOptions ? { providerOptions: runtime.model.providerOptions } : {}),
    });
    const { assistantContent, assistantReplayParts, reasoningSummary } = await timeAsync(
      trace,
      "model_stream_total",
      () =>
        collectAssistantStream({
          stream: result.fullStream,
          readFirstPart: (iterator) =>
            timeAsync(trace, "model_first_stream_part", () => iterator.next(), {
              model_provider: runtime.model.provider,
              model_name: runtime.model.name,
            }),
          sessionId: input.sessionId,
          assistantMessageId,
          runLeaseId: leaseId,
          runLeaseOwner: leaseOwner,
          modelProvider: runtime.model.provider,
          modelName: runtime.model.name,
          exposeReasoningSummary: runtime.model.exposeReasoningSummary,
          signal: controller.signal,
          checkAbort,
        }),
    );

    if (sandbox) {
      const activeSandbox = sandbox;
      await timeAsync(trace, "sync_brain_after_message", () =>
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

    const assistantModelMessage = buildAssistantModelMessage({
      content: assistantContent,
      parts: assistantReplayParts,
    });
    const persistedAssistantModelMessage = toPersistedModelMessage(assistantModelMessage);

    await requireLeaseWrite(
      completeAssistantMessageForLease({
        sessionId: input.sessionId,
        assistantMessageId,
        leaseId,
        leaseOwner,
        content: assistantContent,
        modelMessage: persistedAssistantModelMessage,
      }),
    );
    const normalizedReasoningSummary = normalizeReasoningSummary(reasoningSummary);
    if (normalizedReasoningSummary) {
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          leaseId,
          leaseOwner,
          type: "message.reasoning_summary",
          payload: { messageId: assistantMessageId, summary: normalizedReasoningSummary },
        }),
      );
    }
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        leaseId,
        leaseOwner,
        type: "message.completed",
        payload: {
          messageId: assistantMessageId,
          content: assistantContent,
          modelMessage: persistedAssistantModelMessage,
        },
      }),
    );
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId,
        leaseOwner,
        type: "session.status",
        payload: { status: "completed", message: "Agent completed" },
      }),
    );
    await requireLeaseWrite(releaseRunLease(input.sessionId, leaseId, leaseOwner, "completed"));
    outcome = "completed";
    logger.info("Runner session completed", {
      event: "opencompany.runner_session_completed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxId,
      model_provider: modelProvider,
      model_name: modelName,
    });
  } catch (error) {
    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      return;
    }

    if (controller.signal.aborted || error instanceof RunAbortError) {
      outcome = "aborted";
      if (leaseAcquired) {
        await failRunLease(input.sessionId, leaseId, leaseOwner, "aborting", "Run aborted.");
      }
      logger.info("Runner session aborted", {
        event: "opencompany.runner_session_aborted",
        workspace_id: workspaceId,
        user_id: userId,
        agent_id: agentId,
        session_id: input.sessionId,
        message_id: input.messageId,
        assistant_message_id: assistantMessageId,
        sandbox_id: sandboxId,
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
      sandbox_id: sandboxId,
      model_provider: modelProvider,
      model_name: modelName,
    });
    if (leaseAcquired) {
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId,
        leaseOwner,
        type: "session.error",
        payload: { message },
      });
    }
    const updated = leaseAcquired
      ? await failRunLease(
          input.sessionId,
          leaseId,
          leaseOwner,
          controller.signal.aborted ? "aborting" : "failed",
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
      sandbox_id: sandboxId,
      model_provider: modelProvider,
      model_name: modelName,
      error,
    });
    throw error;
  } finally {
    clearActiveRun(input.sessionId, controller);
    endTimingTrace(trace, {
      outcome,
      model_provider: modelProvider,
      model_name: modelName,
      sandbox_hydrated: Boolean(sandbox),
    });
    const sandboxToPark = sandbox;
    if (sandboxToPark) {
      await timeAsync(trace, "park_sandbox", () => parkSandboxWhenIdle(sandboxToPark, input.env));
    }
  }
}

export async function runAfterSession(input: {
  sessionId: string;
  messageId: string;
  env: RunnerEnv;
}) {
  const db = getDb();
  const trace = startTimingTrace("runner.run_after_session", {
    session_id: input.sessionId,
    message_id: input.messageId,
    runner_instance_id: input.env.instanceId,
  });
  const controller = new AbortController();
  const leaseId = newRunLeaseId();
  const leaseOwner = input.env.instanceId;
  const runLease = { sessionId: input.sessionId, leaseId, leaseOwner };
  const assistantMessageId = newAgentSessionMessageId();
  let sandbox: SandboxHandle | null = null;
  let sandboxPromise: Promise<SandboxHandle> | null = null;
  let leaseAcquired = false;
  let lastHeartbeatAt = 0;
  let afterSessionRunId: number | undefined;
  let workspaceId: string | undefined;
  let userId: string | undefined;
  let agentId: string | undefined;
  let modelProvider: string | undefined;
  let modelName: string | undefined;
  let sandboxId: string | undefined;
  let outcome = "unknown";

  try {
    const row = await timeAsync(trace, "load_session", () => loadSession(input.sessionId));
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

    const latestUserMessage = await timeAsync(trace, "load_latest_user_message", () =>
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
      runLeaseId: leaseId,
    });
    if (!afterRun) {
      outcome = "skipped_duplicate";
      return;
    }
    afterSessionRunId = afterRun.id;

    if (
      !(await timeAsync(trace, "check_workspace_credits", () =>
        hasPositiveWorkspaceBalance({ db, workspaceId: row.session.workspaceId }),
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

    const lease = await timeAsync(trace, "acquire_run_lease", () =>
      acquireRunLease({
        sessionId: input.sessionId,
        messageId: `after-session:${input.messageId}`,
        leaseId,
        leaseOwner,
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
    lastHeartbeatAt = Date.now();
    setActiveRun(input.sessionId, leaseId, controller);

    const checkAbort = async () => {
      const heartbeat = await maybeHeartbeatRunLease({ ...runLease, lastHeartbeatAt });
      lastHeartbeatAt = heartbeat.heartbeatAt;
      if (!heartbeat.leaseActive) {
        controller.abort();
        throw new RunLeaseLostError();
      }
      await checkRunControl({ ...runLease, controller });
    };

    await timeAsync(trace, "initial_run_control_check", checkAbort);
    validateHostedToolEnvironment({ enabledTools: runtime.tools, env: input.env });

    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId,
        leaseOwner,
        type: "after_session.started",
        payload: {
          runId: afterSessionRunId!,
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

    const gateway = createGateway({ apiKey: input.env.vercelAiGatewayApiKey });
    const assistantCreated = await timeAsync(trace, "create_internal_assistant_message", () =>
      createAssistantMessageForLease({
        id: assistantMessageId,
        sessionId: input.sessionId,
        leaseId,
        leaseOwner,
        internal: true,
      }),
    );
    if (!assistantCreated) {
      outcome = "skipped_assistant_exists";
      await releaseRunLease(input.sessionId, leaseId, leaseOwner, "completed");
      return;
    }

    const storedMessages = await timeAsync(trace, "load_model_messages", () =>
      db
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
      content: buildAfterSessionPrompt({
        prompt: afterSession.prompt,
      }),
    });

    const getSandbox = async () => {
      if (sandbox) return sandbox;
      if (sandboxPromise) return sandboxPromise;

      sandboxPromise = (async () => {
        const hydratedSandbox = await timeAsync(
          trace,
          "ensure_sandbox",
          () => ensureSandbox(row, input.env),
          {
            existing_sandbox: Boolean(row.session.e2bSandboxId),
          },
        );
        await checkAbort();
        const updated = await timeAsync(trace, "update_sandbox_for_lease", () =>
          updateSandboxForLease(input.sessionId, leaseId, leaseOwner, hydratedSandbox.sandboxId),
        );
        if (!updated) {
          await killSandbox(hydratedSandbox.sandboxId);
          throw new StaleRunLeaseError();
        }

        sandbox = hydratedSandbox;
        sandboxId = hydratedSandbox.sandboxId;
        return hydratedSandbox;
      })().catch((error) => {
        sandboxPromise = null;
        throw error;
      });

      return sandboxPromise;
    };
    const tools = createToolSet({
      sessionId: input.sessionId,
      assistantMessageId,
      runLeaseId: leaseId,
      runLeaseOwner: leaseOwner,
      internalMessages: true,
      workspaceId: row.workspace.id,
      agentConfig: row.agent.config,
      getSandbox,
      workdir: row.session.workdir,
      env: input.env,
      enabledTools: runtime.tools,
      repository: row.repository,
      signal: controller.signal,
      checkAbort,
      observabilityContext: {
        workspaceId,
        userId,
        agentId,
        modelProvider,
        modelName,
      },
      toolBudget: createHostedToolBudget(),
    });

    const result = streamText({
      model: gateway(runtime.model.name),
      system: buildCacheableSystemPrompt(
        `${runtime.systemPrompt}\n\nThis is an internal after-session run. Do not address the user; any final text is stored internally and not shown in chat, so keep it brief. Use mounted Brain files under ./brain to capture durable, long-lived context from the transcript when worthwhile, and skip the update if nothing is worth preserving.`,
        runtime.model.name,
      ),
      messages,
      tools: pickRuntimeTools(tools, runtime.tools),
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      ...(runtime.model.providerOptions ? { providerOptions: runtime.model.providerOptions } : {}),
    });
    let { assistantContent, assistantReplayParts, reasoningSummary } = await timeAsync(
      trace,
      "model_stream_total",
      () =>
        collectAssistantStream({
          stream: result.fullStream,
          readFirstPart: (iterator) =>
            timeAsync(trace, "model_first_stream_part", () => iterator.next(), {
              model_provider: runtime.model.provider,
              model_name: runtime.model.name,
            }),
          sessionId: input.sessionId,
          assistantMessageId,
          runLeaseId: leaseId,
          runLeaseOwner: leaseOwner,
          modelProvider: runtime.model.provider,
          modelName: runtime.model.name,
          exposeReasoningSummary: runtime.model.exposeReasoningSummary,
          signal: controller.signal,
          checkAbort,
        }),
    );

    if (sandbox) {
      const activeSandbox = sandbox;
      await timeAsync(trace, "sync_brain_after_session", () =>
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

    const persistedAssistantModelMessage = toPersistedModelMessage(
      buildAssistantModelMessage({
        content: assistantContent,
        parts: assistantReplayParts,
      }),
    );
    await requireLeaseWrite(
      completeAssistantMessageForLease({
        sessionId: input.sessionId,
        assistantMessageId,
        leaseId,
        leaseOwner,
        content: assistantContent,
        modelMessage: persistedAssistantModelMessage,
      }),
    );

    const normalizedReasoningSummary = normalizeReasoningSummary(reasoningSummary);
    if (normalizedReasoningSummary) {
      await requireLeaseWrite(
        appendRuntimeEventForLease({
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          leaseId,
          leaseOwner,
          type: "message.reasoning_summary",
          payload: { messageId: assistantMessageId, summary: normalizedReasoningSummary },
        }),
      );
    }

    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        leaseId,
        leaseOwner,
        type: "message.completed",
        payload: {
          messageId: assistantMessageId,
          content: assistantContent,
          modelMessage: persistedAssistantModelMessage,
          internal: true,
        },
      }),
    );
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId,
        leaseOwner,
        type: "after_session.completed",
        payload: { runId: afterSessionRunId!, messageId: input.messageId },
      }),
    );
    await completeAfterSessionRun(afterSessionRunId!, { status: "completed" });
    await requireLeaseWrite(releaseRunLease(input.sessionId, leaseId, leaseOwner, "completed"));
    outcome = "completed";
    logger.info("Runner after-session completed", {
      event: "opencompany.runner_after_session_completed",
      workspace_id: workspaceId,
      user_id: userId,
      agent_id: agentId,
      session_id: input.sessionId,
      message_id: input.messageId,
      assistant_message_id: assistantMessageId,
      sandbox_id: sandboxId,
      model_provider: modelProvider,
      model_name: modelName,
    });
  } catch (error) {
    if (error instanceof StaleRunLeaseError || error instanceof RunLeaseLostError) {
      outcome = "stale_lease";
      return;
    }

    const message =
      controller.signal.aborted || error instanceof RunAbortError
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
      sandbox_id: sandboxId,
      model_provider: modelProvider,
      model_name: modelName,
    });
    if (leaseAcquired) {
      await appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: null,
        leaseId,
        leaseOwner,
        type: "after_session.failed",
        payload: {
          ...(afterSessionRunId ? { runId: afterSessionRunId } : {}),
          messageId: input.messageId,
          message,
        },
      });
      await releaseRunLease(input.sessionId, leaseId, leaseOwner, "completed");
    } else {
      await appendRuntimeEvent(db, {
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
      sandbox_id: sandboxId,
      model_provider: modelProvider,
      model_name: modelName,
      error,
    });
    throw error;
  } finally {
    clearActiveRun(input.sessionId, controller);
    endTimingTrace(trace, {
      outcome,
      model_provider: modelProvider,
      model_name: modelName,
      sandbox_hydrated: Boolean(sandbox),
    });
    const sandboxToPark = sandbox;
    if (sandboxToPark) {
      await timeAsync(trace, "park_sandbox", () => parkSandboxWhenIdle(sandboxToPark, input.env));
    }
  }
}

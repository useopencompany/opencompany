import {
  newAgentSessionMessageId,
  newRunLeaseId,
  RUNTIME_TOOL_DEFINITIONS,
  type RuntimeToolDefinition,
  type RuntimeToolName,
  resolveAgentRuntimeConfig,
  serializeRuntimeAgentFile,
  shellQuote,
} from "@opencompany/agent-runtime";
import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  hasPositiveWorkspaceBalance,
  recordWorkspaceUsageDebit,
} from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import {
  type AgentConfig,
  agentSessionArtifacts,
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionToolUsage,
  agentSessionUsage,
  agents,
  type WorkspaceRepository,
  workspaceGitHubIntegrationRepositories,
  workspaceRepositories,
  workspaces,
} from "@opencompany/db/schema";
import {
  captureException,
  createLogger,
  endTimingTrace,
  startTimingTrace,
  timeAsync,
} from "@opencompany/observability";
import {
  createGateway,
  type FinishReason,
  jsonSchema,
  type LanguageModelResponseMetadata,
  type LanguageModelUsage,
  type SystemModelMessage,
  stepCountIs,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import { materializeBrainForSession, syncBrainFromSandbox } from "./brain";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { createDraftPullRequest, getGitHubWorkInstallationToken } from "./github";
import {
  executeHostedTool,
  getHostedToolFailureContext,
  type HostedToolUsage,
  MissingEnvError,
  validateHostedToolEnvironment,
} from "./hosted-tools";
import {
  type AssistantReplayPart,
  appendAssistantTextPart,
  buildAssistantModelMessage,
  buildModelMessages,
  buildToolModelMessage,
  serializeToolOutputForStorage,
  toPersistedModelMessage,
} from "./model-messages";
import {
  checkRunControl,
  claimRunLease as claimDbRunLease,
  finishRunLease as finishDbRunLease,
  maybeHeartbeatRunLease,
  RunAbortError,
  RunLeaseLostError,
  withRunControlChecks,
} from "./run-control";
import {
  armSandboxIdleTimeout,
  createOrConnectSandbox,
  killSandbox,
  prepareWorkspace,
  resolveSandboxToolPath,
  runSandboxTool,
  type SandboxHandle,
  sandboxLayout,
} from "./sandbox";
import { normalizeModelUsage } from "./usage";

const activeRuns = new Map<string, { leaseId: string; controller: AbortController }>();
const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

type ToolObservabilityContext = {
  workspaceId?: string;
  userId?: string;
  agentId?: string;
  modelProvider?: string;
  modelName?: string;
};

type FailedToolOutput = {
  ok: false;
  error: {
    message: string;
    code: string;
    recoverable: true;
  };
};

export async function startSession(sessionId: string, env: RunnerEnv) {
  const db = getDb();
  const row = await loadSession(sessionId);
  if (row.session.archivedAt) return;

  if (!(await setStatus(sessionId, "provisioning"))) return;
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "provisioning", message: "Starting sandbox" },
  });

  const sandbox = await ensureSandbox(row, env);
  const [updated] = await db
    .update(agentSessions)
    .set({
      e2bSandboxId: sandbox.sandboxId,
      status: "ready",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        isNull(agentSessions.archivedAt),
        isNull(agentSessions.runLeaseId),
      ),
    )
    .returning({ id: agentSessions.id });
  if (!updated) {
    await killSandbox(sandbox.sandboxId);
    return;
  }

  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "ready", message: "Sandbox ready" },
  });
  logger.info("Runner session ready", {
    event: "opencompany.runner_session_ready",
    workspace_id: row.workspace.id,
    user_id: row.session.userId,
    agent_id: row.agent.id,
    session_id: sessionId,
    sandbox_id: sandbox.sandboxId,
  });
  await parkSandboxWhenIdle(sandbox, env);
}

export async function abortSession(sessionId: string) {
  const db = getDb();
  const [updated] = await db
    .update(agentSessions)
    .set({
      status: "aborting",
      abortRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.archivedAt)))
    .returning({ id: agentSessions.id });
  if (!updated) return;

  activeRuns.get(sessionId)?.controller.abort();
  await appendRuntimeEvent(db, {
    sessionId,
    type: "session.status",
    payload: { status: "aborting", message: "Abort requested" },
  });
  logger.info("Runner session abort requested", {
    event: "opencompany.runner_session_abort_requested",
    session_id: sessionId,
  });
}

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
  const assistantMessageId = newAgentSessionMessageId();
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

    if (
      await timeAsync(trace, "load_existing_assistant_response", () =>
        loadAssistantResponseForMessage(input.sessionId, input.messageId),
      )
    ) {
      outcome = "skipped_duplicate";
      return;
    }

    const runtime = resolveAgentRuntimeConfig({
      agent: row.agent.config,
      workspaceName: row.workspace.name,
      sessionTitle: row.session.title,
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
    activeRuns.set(input.sessionId, { leaseId, controller });

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
      storedMessages.filter((message) => message.id !== assistantMessageId),
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
    });

    let assistantContent = "";
    const assistantReplayParts: AssistantReplayPart[] = [];
    let reasoningSummary = "";
    let stepIndex = 0;
    const result = streamText({
      model: gateway(runtime.model.name),
      system: buildCacheableSystemPrompt(runtime.systemPrompt, runtime.model.name),
      messages,
      tools: pickRuntimeTools(tools, runtime.tools),
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
      ...(runtime.model.providerOptions ? { providerOptions: runtime.model.providerOptions } : {}),
    });

    await timeAsync(trace, "model_stream_total", async () => {
      const iterator = result.fullStream[Symbol.asyncIterator]();
      let next = await timeAsync(trace, "model_first_stream_part", () => iterator.next(), {
        model_provider: runtime.model.provider,
        model_name: runtime.model.name,
      });

      while (!next.done) {
        const part = next.value;
        await checkAbort();
        throwIfAborted(controller.signal);
        throwIfStreamErrorPart(part);

        if (part.type === "text-delta") {
          assistantContent += part.text;
          appendAssistantTextPart(assistantReplayParts, part.text);
        }

        if (runtime.model.exposeReasoningSummary) {
          reasoningSummary += readReasoningTextDelta(part);
        }

        if (part.type === "finish-step") {
          stepIndex += 1;
          await recordStepUsage({
            sessionId: input.sessionId,
            assistantMessageId,
            runLeaseId: leaseId,
            runLeaseOwner: leaseOwner,
            stepIndex,
            modelProvider: runtime.model.provider,
            modelName: runtime.model.name,
            response: part.response,
            usage: part.usage,
            finishReason: part.finishReason,
            rawFinishReason: part.rawFinishReason,
          });
        }

        if (part.type === "tool-call") {
          assistantReplayParts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
        }

        next = await iterator.next();
      }
    });

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
    if (activeRuns.get(input.sessionId)?.controller === controller) {
      activeRuns.delete(input.sessionId);
    }
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

export async function archiveSession(sessionId: string) {
  const db = getDb();
  activeRuns.get(sessionId)?.controller.abort();

  const [session] = await db
    .select({
      id: agentSessions.id,
      e2bSandboxId: agentSessions.e2bSandboxId,
      archivedAt: agentSessions.archivedAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.archivedAt) return;

  const previousSandboxId = session.e2bSandboxId;
  const sandboxKilled = previousSandboxId ? await killSandbox(previousSandboxId) : false;
  const now = new Date();

  await db.batch([
    db
      .update(agentSessions)
      .set({
        status: "archived",
        archivedAt: now,
        sandboxTerminatedAt: now,
        e2bSandboxId: null,
        runLeaseId: null,
        runLeaseOwner: null,
        runLeaseMessageId: null,
        runLeaseExpiresAt: null,
        runHeartbeatAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, sessionId)),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "archived", message: "Session archived" },
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.archived",
      payload: {
        sandboxId: previousSandboxId,
        sandboxKilled,
        sandboxAlreadyStopped: previousSandboxId === null || !sandboxKilled,
      },
    }),
  ]);
}

function createToolSet(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  workspaceId: string;
  agentConfig: AgentConfig;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  repository?: WorkspaceRepository | null | undefined;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
  observabilityContext?: ToolObservabilityContext | undefined;
}) {
  const tools: ToolSet = {};

  for (const definition of RUNTIME_TOOL_DEFINITIONS) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
      onInputAvailable: async ({ input: toolInput, toolCallId }) => {
        await input.checkAbort();
        await requireLeaseWrite(
          appendRuntimeEventForLease({
            sessionId: input.sessionId,
            messageId: input.assistantMessageId,
            leaseId: input.runLeaseId,
            leaseOwner: input.runLeaseOwner,
            type: "tool.started",
            payload: {
              messageId: input.assistantMessageId,
              toolCallId,
              name: definition.name,
              input: toolInput,
            },
          }),
        );
      },
      execute: async (toolInput, options) =>
        executeRuntimeTool({
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          workspaceId: input.workspaceId,
          agentConfig: input.agentConfig,
          toolCallId: options.toolCallId,
          definition,
          args: toolInput,
          getSandbox: input.getSandbox,
          workdir: input.workdir,
          env: input.env,
          enabledTools: input.enabledTools,
          repository: input.repository,
          signal: input.signal,
          checkAbort: input.checkAbort,
          observabilityContext: input.observabilityContext,
        }),
    });
  }

  return tools;
}

function pickRuntimeTools(tools: ToolSet, names: string[]) {
  const picked: ToolSet = {};
  for (const name of names) {
    if (tools[name]) picked[name] = tools[name];
  }
  return picked;
}

export async function executeRuntimeTool(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  workspaceId?: string;
  agentConfig?: AgentConfig;
  toolCallId: string;
  definition: RuntimeToolDefinition;
  args: unknown;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  repository?: WorkspaceRepository | null | undefined;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
  observabilityContext?: ToolObservabilityContext | undefined;
}) {
  let output: unknown;
  let failedOutput: FailedToolOutput | null = null;
  let usage: HostedToolUsage | undefined;
  let sandboxIdForCapture: string | undefined;
  try {
    output = await withRunControlChecks(input.checkAbort, async () => {
      throwIfAborted(input.signal);

      if (input.definition.kind === "hosted") {
        const result = await executeHostedTool({
          name: input.definition.name,
          args: input.args,
          env: input.env,
          enabledTools: input.enabledTools,
          signal: input.signal,
        });
        usage = result.usage;
        return result.output;
      }

      preflightSandboxToolArgs({
        name: input.definition.name,
        args: input.args,
        workdir: input.workdir,
      });
      const activeSandbox = await input.getSandbox();
      sandboxIdForCapture = activeSandbox.sandboxId;
      if (input.definition.name === "amp_coder") {
        if (!input.workspaceId || !input.agentConfig) {
          throw new Error("AMP requires workspace and agent configuration context.");
        }
        return runAmpCoderTool({
          sandbox: activeSandbox,
          workdir: input.workdir,
          args: input.args,
          sessionId: input.sessionId,
          messageId: input.assistantMessageId,
          workspaceId: input.workspaceId,
          toolCallId: input.toolCallId,
          agentConfig: input.agentConfig,
          env: input.env,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          onOutput: async (delta) => {
            await input.checkAbort();
            await requireLeaseWrite(
              appendRuntimeEventForLease({
                sessionId: input.sessionId,
                messageId: input.assistantMessageId,
                leaseId: input.runLeaseId,
                leaseOwner: input.runLeaseOwner,
                type: "command.output",
                payload: {
                  command: input.definition.name,
                  toolCallId: input.toolCallId,
                  stream: "stdout",
                  delta,
                },
              }),
            );
          },
        });
      }
      const brainSnapshotBefore =
        input.definition.name === "shell"
          ? await readSandboxBrainSnapshot(activeSandbox, input.workdir)
          : null;
      const sandboxOutput = await runSandboxTool({
        sandbox: activeSandbox,
        workdir: input.workdir,
        name: input.definition.name,
        args: input.args,
        onOutput: async (stream, delta) => {
          await input.checkAbort();
          await requireLeaseWrite(
            appendRuntimeEventForLease({
              sessionId: input.sessionId,
              messageId: input.assistantMessageId,
              leaseId: input.runLeaseId,
              leaseOwner: input.runLeaseOwner,
              type: "command.output",
              payload: {
                command: input.definition.name,
                toolCallId: input.toolCallId,
                stream,
                delta,
              },
            }),
          );
        },
      });
      if (
        input.definition.name === "shell" &&
        brainSnapshotBefore !== null &&
        brainSnapshotBefore !== (await readSandboxBrainSnapshot(activeSandbox, input.workdir))
      ) {
        return { output: sandboxOutput, brainChanged: true };
      }
      return sandboxOutput;
    });
  } catch (error) {
    if (isFatalToolError(error, input.definition.kind, sandboxIdForCapture, input.signal)) {
      throw error;
    }

    captureException(error, {
      event: "opencompany.runner_tool_failed",
      workspace_id: input.observabilityContext?.workspaceId,
      user_id: input.observabilityContext?.userId,
      agent_id: input.observabilityContext?.agentId,
      session_id: input.sessionId,
      message_id: input.assistantMessageId,
      tool_call_id: input.toolCallId,
      tool_name: input.definition.name,
      tool_kind: input.definition.kind,
      sandbox_id: sandboxIdForCapture,
      model_provider: input.observabilityContext?.modelProvider,
      model_name: input.observabilityContext?.modelName,
      ...(input.definition.kind === "hosted"
        ? getHostedToolFailureContext({
            name: input.definition.name,
            args: input.args,
            error,
          })
        : {}),
    });
    failedOutput = buildFailedToolOutput(error);
    output = failedOutput;
  }

  const changedPath =
    !failedOutput && isRecord(output) && Object.prototype.hasOwnProperty.call(output, "path")
      ? (output as { path: unknown }).path
      : null;
  if (input.definition.name === "write_file" && typeof changedPath === "string") {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "file.changed",
        payload: { path: changedPath, operation: "write" },
      }),
    );
  }

  const shellOutput = isRecord(output) && "brainChanged" in output ? output.output : output;
  const shellChangedBrain = isRecord(output) && output.brainChanged === true;
  if (isRecord(output) && "brainChanged" in output) {
    output = shellOutput;
  }
  const writeChangedBrain =
    input.definition.name === "write_file" &&
    typeof changedPath === "string" &&
    changedPath.replace(/^\/+/, "").startsWith("brain/");
  if (
    !failedOutput &&
    input.definition.kind === "sandbox" &&
    (writeChangedBrain || shellChangedBrain)
  ) {
    const activeSandbox = await input.getSandbox();
    await syncBrainFromSandbox({
      sandbox: activeSandbox,
      sessionId: input.sessionId,
      workspaceId: input.observabilityContext?.workspaceId ?? "",
      workdir: input.workdir,
      repository: input.repository,
    });
  }

  if (usage) {
    await recordToolUsage({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      runLeaseOwner: input.runLeaseOwner,
      toolCallId: input.toolCallId,
      toolName: input.definition.name,
      usage,
    });
  }

  const toolMessageId = newAgentSessionMessageId();
  await requireLeaseWrite(
    insertToolMessageForLease({
      id: toolMessageId,
      sessionId: input.sessionId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      content: serializeToolOutputForStorage(output),
      modelMessage: toPersistedModelMessage(
        buildToolModelMessage({
          toolCallId: input.toolCallId,
          toolName: input.definition.name,
          output,
        }),
      ),
      toolName: input.definition.name,
      toolCallId: input.toolCallId,
    }),
  );
  if (failedOutput) {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "tool.failed",
        payload: {
          messageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
          name: input.definition.name,
          error: failedOutput.error,
          output,
        },
      }),
    );
  } else {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "tool.completed",
        payload: {
          messageId: input.assistantMessageId,
          toolCallId: input.toolCallId,
          name: input.definition.name,
          output,
        },
      }),
    );
  }

  return output;
}

export async function recordStepUsage(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  stepIndex: number;
  modelProvider: string;
  modelName: string;
  response: LanguageModelResponseMetadata;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}) {
  const db = getDb();
  await requireLeaseWrite(
    isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
  );

  const usage = normalizeModelUsage(input.usage);
  const cost = calculateModelUsageCost({
    modelName: input.modelName,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
  });
  const usagePayload = {
    messageId: input.assistantMessageId,
    runLeaseId: input.runLeaseId,
    stepIndex: input.stepIndex,
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    responseModelId: input.response.modelId,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
    outputTextTokens: usage.outputTextTokens,
    outputReasoningTokens: usage.outputReasoningTokens,
    totalTokens: usage.totalTokens,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
    finishReason: input.finishReason,
    ...(input.rawFinishReason ? { rawFinishReason: input.rawFinishReason } : {}),
  };

  const [usageRow] = await db
    .insert(agentSessionUsage)
    .values({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      stepIndex: input.stepIndex,
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      responseId: input.response.id,
      responseModelId: input.response.modelId,
      finishReason: input.finishReason,
      rawFinishReason: input.rawFinishReason ?? null,
      inputTokens: usage.inputTokens,
      inputNoCacheTokens: usage.inputNoCacheTokens,
      inputCacheReadTokens: usage.inputCacheReadTokens,
      inputCacheWriteTokens: usage.inputCacheWriteTokens,
      outputTokens: usage.outputTokens,
      outputTextTokens: usage.outputTextTokens,
      outputReasoningTokens: usage.outputReasoningTokens,
      totalTokens: usage.totalTokens,
      rawUsage: usage.rawUsage,
      providerCreatedAt: input.response.timestamp,
    })
    .returning({ id: agentSessionUsage.id });

  if (usageRow && cost.billable) {
    await recordWorkspaceUsageDebit({
      db,
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      modelUsageId: usageRow.id,
      source: "model_usage",
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        runLeaseId: input.runLeaseId,
        stepIndex: input.stepIndex,
        responseId: input.response.id,
        responseModelId: input.response.modelId,
      },
    });
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.usage",
      payload: usagePayload,
    }),
  );
}

export async function recordToolUsage(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  toolCallId: string;
  toolName: string;
  usage: HostedToolUsage;
}) {
  const db = getDb();
  await requireLeaseWrite(
    isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
  );
  const cost = calculateHostedToolUsageCost({
    provider: input.usage.provider,
    operation: input.usage.operation,
    providerCostUsdMicros: input.usage.costUsdMicros,
  });

  const usagePayload = {
    messageId: input.assistantMessageId,
    runLeaseId: input.runLeaseId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    provider: input.usage.provider,
    operation: input.usage.operation,
    ...(input.usage.providerRequestId ? { providerRequestId: input.usage.providerRequestId } : {}),
    costUsdMicros: input.usage.costUsdMicros,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
  };

  const [toolUsageRow] = await db
    .insert(agentSessionToolUsage)
    .values({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      provider: input.usage.provider,
      operation: input.usage.operation,
      providerRequestId: input.usage.providerRequestId ?? null,
      costUsdMicros: input.usage.costUsdMicros,
      rawUsage: input.usage.rawUsage,
    })
    .returning({ id: agentSessionToolUsage.id });

  if (toolUsageRow && cost.billable) {
    await recordWorkspaceUsageDebit({
      db,
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      toolUsageId: toolUsageRow.id,
      source: "tool_usage",
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        runLeaseId: input.runLeaseId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        providerRequestId: input.usage.providerRequestId,
      },
    });
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.tool_usage",
      payload: usagePayload,
    }),
  );
}

async function runAmpCoderTool(input: {
  sandbox: SandboxHandle;
  workdir: string;
  args: unknown;
  sessionId: string;
  messageId: string;
  workspaceId: string;
  toolCallId: string;
  agentConfig: AgentConfig;
  env: RunnerEnv;
  runLeaseId: string;
  runLeaseOwner: string;
  onOutput?: (delta: string) => Promise<void> | void;
}) {
  const args = isRecord(input.args) ? input.args : {};
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) throw new Error("AMP task is required.");
  const requestedAmpThreadId =
    typeof args.ampThreadId === "string" && args.ampThreadId.trim()
      ? args.ampThreadId.trim()
      : null;

  const ampTool = input.agentConfig.tools.find((tool) => tool.id === "amp");
  if (!ampTool || ampTool.id !== "amp" || !ampTool.repository) {
    throw new Error("The amp_coder tool is enabled, but no GitHub repository is bound.");
  }
  const repository = input.agentConfig.integrations.github.repositories.find(
    (candidate) => candidate.id === ampTool.repository,
  );
  if (!repository) {
    throw new Error(`AMP repository binding ${ampTool.repository} was not found.`);
  }

  const ampApiKey = loadPlatformAmpApiKey(input.env);
  const layout = sandboxLayout(input.workdir);
  await input.sandbox.commands.run(
    `git config --global --add safe.directory ${shellQuote(layout.workRoot)}`,
  );
  const gitCheck = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git rev-parse --is-inside-work-tree`,
    { timeoutMs: 30_000 },
  );
  if (String(gitCheck.stdout ?? "").trim() !== "true") {
    throw new Error(
      "AMP requires a cloned GitHub repository. Check the workspace GitHub installation and repository binding.",
    );
  }
  const ampStream = createAmpStreamAccumulator();
  const ampActivity = createAmpActivityFormatter();
  const result = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && ${buildAmpCommand({
      task,
      ampThreadId: requestedAmpThreadId,
    })}`,
    {
      envs: { AMP_API_KEY: ampApiKey },
      timeoutMs: 600_000,
      onStdout: async (data: string) => {
        ampStream.push(data);
        const activity = ampActivity.push(data);
        if (activity) await input.onOutput?.(activity);
      },
      onStderr: async (data: string) => {
        await input.onOutput?.(data);
      },
    },
  );
  const remainingActivity = ampActivity.finish();
  if (remainingActivity) await input.onOutput?.(remainingActivity);
  ampStream.finish();
  const ampSummary = ampStream.summary();

  await input.sandbox.commands.run(`cd ${shellQuote(layout.workRoot)} && git add -N .`, {
    timeoutMs: 60_000,
  });
  const diffStatus = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git status --short`,
    { timeoutMs: 60_000 },
  );
  const diffStat = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git diff HEAD --stat`,
    { timeoutMs: 60_000 },
  );
  const diffPreview = await input.sandbox.commands.run(
    `cd ${shellQuote(layout.workRoot)} && git diff HEAD -- | head -400`,
    { timeoutMs: 60_000 },
  );
  const hasDiff = String(diffStatus.stdout ?? "").trim().length > 0;
  let branchName: string | null = null;
  let pullRequestUrl: string | null = null;

  if (args.createPullRequest === true && hasDiff) {
    if (!ampTool.prCapable) {
      throw new Error("AMP is not configured for pull request creation.");
    }
    const integrationRepository = await loadGitHubWorkRepository(
      input.workspaceId,
      repository.fullName,
    );
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    const token = await getGitHubWorkInstallationToken({
      installationId: integrationRepository.installationId,
      repositoryFullName: repository.fullName,
    });
    if (!token) {
      throw new Error("GitHub App credentials are required to push AMP changes.");
    }
    branchName = `opencompany/amp-${input.sessionId.slice(-8)}-${Date.now()}`;
    const commitMessage = normalizeCommitMessage(
      typeof args.pullRequestTitle === "string" ? args.pullRequestTitle : task,
    );
    await input.sandbox.commands.run(
      [
        `cd ${shellQuote(layout.workRoot)}`,
        `git config user.name ${shellQuote("OpenCompany Agent")}`,
        `git config user.email ${shellQuote("agents@opencompany.ai")}`,
        `git checkout -b ${shellQuote(branchName)}`,
        "git add -A",
        `git commit -m ${shellQuote(commitMessage)}`,
        `git remote set-url origin ${shellQuote(githubRemoteUrl(repository.fullName))}`,
      ].join(" && "),
      { timeoutMs: 120_000 },
    );
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    await input.sandbox.commands.run(
      `cd ${shellQuote(layout.workRoot)} && git ${gitAuthExtraHeaderArg()} push origin ${shellQuote(
        branchName,
      )}`,
      { envs: { GITHUB_TOKEN: token }, timeoutMs: 180_000 },
    );
    await requireLeaseWrite(
      isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
    );
    const pr = await createDraftPullRequest({
      installationId: integrationRepository.installationId,
      repositoryFullName: repository.fullName,
      title: commitMessage,
      head: branchName,
      base: repository.defaultBranch,
      body: ["Created by OpenCompany AMP.", "", `Task: ${task}`].join("\n"),
    });
    pullRequestUrl = pr.html_url ?? null;
  }

  await requireLeaseWrite(
    isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
  );
  await getDb()
    .insert(agentSessionArtifacts)
    .values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolName: "amp_coder",
      kind: "amp_run",
      title: task,
      url: pullRequestUrl,
      externalId: ampSummary.threadId,
      repositoryFullName: repository.fullName,
      branchName,
      diffStat: truncateText(formatAmpDiffStat(diffStat.stdout, diffStatus.stdout), 4000),
      diffPreview: truncateText(String(diffPreview.stdout ?? ""), 24_000),
      metadata: {
        continuedFromAmpThreadId: requestedAmpThreadId,
        ampStatus: ampSummary.status,
        ampError: ampSummary.error,
        ampDurationMs: ampSummary.durationMs,
        ampNumTurns: ampSummary.numTurns,
        ampPermissionDenials: ampSummary.permissionDenials,
        exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      },
    });

  return {
    repository: repository.fullName,
    ampThreadId: ampSummary.threadId,
    continuedFromAmpThreadId: requestedAmpThreadId,
    ampStatus: ampSummary.status,
    ampResult: truncateText(ampSummary.result, 24_000),
    ampError: ampSummary.error,
    ampDurationMs: ampSummary.durationMs,
    ampNumTurns: ampSummary.numTurns,
    ampPermissionDenials: ampSummary.permissionDenials,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    diffStat: truncateText(formatAmpDiffStat(diffStat.stdout, diffStatus.stdout), 4000),
    diffPreview: truncateText(String(diffPreview.stdout ?? ""), 24_000),
    branchName,
    pullRequestUrl,
  };
}

export function buildAmpCommand(input: { task: string; ampThreadId?: string | null }) {
  const task = shellQuote(input.task);
  const ampThreadId = input.ampThreadId?.trim();
  if (ampThreadId) {
    return [
      "amp",
      "threads",
      "continue",
      "--dangerously-allow-all",
      "--stream-json",
      "-x",
      task,
      shellQuote(ampThreadId),
    ].join(" ");
  }

  return `amp --dangerously-allow-all --stream-json -x ${task}`;
}

async function loadGitHubWorkRepository(workspaceId: string, fullName: string) {
  const [repository] = await getDb()
    .select({
      fullName: workspaceGitHubIntegrationRepositories.fullName,
      installationId: workspaceGitHubIntegrationRepositories.installationId,
    })
    .from(workspaceGitHubIntegrationRepositories)
    .where(
      and(
        eq(workspaceGitHubIntegrationRepositories.workspaceId, workspaceId),
        eq(workspaceGitHubIntegrationRepositories.fullName, fullName),
      ),
    )
    .limit(1);

  if (!repository) {
    throw new Error(`GitHub work repository ${fullName} is not available to this workspace.`);
  }

  return repository;
}

function loadPlatformAmpApiKey(env: RunnerEnv) {
  if (!env.ampApiKey) {
    throw new Error("AMP_API_KEY is required on the runner to use the AMP coding tool.");
  }
  return env.ampApiKey;
}

type AmpStreamSummary = {
  threadId: string | null;
  status: "success" | "error" | "unknown";
  result: string;
  error: string | null;
  durationMs: number | null;
  numTurns: number | null;
  permissionDenials: string[];
};

export function createAmpStreamAccumulator() {
  let buffer = "";
  let threadId: string | null = null;
  let status: AmpStreamSummary["status"] = "unknown";
  let result = "";
  let error: string | null = null;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  let lastAssistantText = "";
  let permissionDenials: string[] = [];

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(event)) return;

    const eventThreadId = readOptionalText(event.session_id);
    if (eventThreadId) threadId = eventThreadId;

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      lastAssistantText = readAmpAssistantText(message) || lastAssistantText;
      return;
    }

    if (event.type !== "result") return;

    durationMs = readOptionalFiniteNumber(event.duration_ms) ?? durationMs;
    numTurns = readOptionalFiniteNumber(event.num_turns) ?? numTurns;
    permissionDenials = readStringArray(event.permission_denials);

    if (event.is_error === true || event.subtype !== "success") {
      status = "error";
      error = readOptionalText(event.error) ?? "Amp failed without an error message.";
      result = "";
      return;
    }

    status = "success";
    result = readOptionalText(event.result) ?? lastAssistantText;
    error = null;
  }

  return {
    push(data: string) {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    finish() {
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
    },
    summary(): AmpStreamSummary {
      return {
        threadId,
        status,
        result: result || lastAssistantText,
        error,
        durationMs,
        numTurns,
        permissionDenials,
      };
    },
  };
}

export function createAmpActivityFormatter() {
  let buffer = "";
  let lastEmitted = "";

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return "";

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return truncateText(`${trimmed}\n`, 1000);
    }
    if (!isRecord(event)) return "";

    const summary = summarizeAmpEvent(event);
    if (!summary || summary === lastEmitted) return "";
    lastEmitted = summary;
    return `${summary}\n`;
  }

  return {
    push(data: string) {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.map(consumeLine).join("");
    },
    finish() {
      const output = buffer.trim() ? consumeLine(buffer) : "";
      buffer = "";
      return output;
    },
  };
}

function summarizeAmpEvent(event: Record<string, unknown>) {
  const type = readOptionalText(event.type);

  if (type === "system") {
    const subtype = readOptionalText(event.subtype);
    const threadId = readOptionalText(event.session_id);
    if (subtype === "init") {
      return threadId ? `Amp session ${threadId} started.` : "Amp session started.";
    }
    return "";
  }

  if (type === "assistant") {
    const message = isRecord(event.message) ? event.message : {};
    return readAmpAssistantActivity(message);
  }

  if (type === "result") {
    const durationMs = readOptionalFiniteNumber(event.duration_ms);
    const numTurns = readOptionalFiniteNumber(event.num_turns);
    if (event.is_error === true || event.subtype !== "success") {
      const error = readOptionalText(event.error);
      return error ? `Amp failed: ${error}` : "Amp failed.";
    }
    return `Amp completed${formatAmpDurationSuffix(durationMs, numTurns)}.`;
  }

  if (type === "tool_use" || type === "tool-call") {
    const name = readOptionalText(event.name) ?? readOptionalText(event.tool_name) ?? "tool";
    return `Amp is using ${formatAmpLabel(name)}${formatAmpInputSuffix(event.input)}.`;
  }

  if (type === "tool_result" || type === "tool-result") {
    const name = readOptionalText(event.name) ?? readOptionalText(event.tool_name);
    return name ? `Amp received ${formatAmpLabel(name)} result.` : "Amp received a tool result.";
  }

  return "";
}

function readAmpAssistantText(message: Record<string, unknown>) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
}

function readAmpAssistantActivity(message: Record<string, unknown>) {
  const content = Array.isArray(message.content) ? message.content : [];
  const summaries: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) continue;

    if (part.type === "text") {
      const text = readOptionalText(part.text);
      if (text) summaries.push(`Amp: ${compactWhitespace(text)}`);
      continue;
    }

    if (part.type === "tool_use" || part.type === "tool-call") {
      const name = readOptionalText(part.name) ?? readOptionalText(part.toolName) ?? "tool";
      summaries.push(`Amp is using ${formatAmpLabel(name)}${formatAmpInputSuffix(part.input)}.`);
    }
  }

  return summaries.length > 0 ? truncateText(summaries.join("\n"), 1000) : "";
}

function formatAmpInputSuffix(value: unknown) {
  const preview = compactWhitespace(formatCompactValue(value));
  return preview ? `: ${truncateText(preview, 180)}` : "";
}

function formatCompactValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatAmpDurationSuffix(durationMs: number | null | undefined, numTurns: number | null) {
  const parts: string[] = [];
  if (durationMs !== null && durationMs !== undefined) parts.push(formatDurationMs(durationMs));
  if (numTurns !== null && numTurns !== undefined) {
    parts.push(`${numTurns} ${numTurns === 1 ? "turn" : "turns"}`);
  }
  return parts.length > 0 ? ` in ${parts.join(", ")}` : "";
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatAmpLabel(value: string) {
  return value.replace(/[_-]+/g, " ").trim() || "tool";
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCommitMessage(value: string) {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine || "Apply AMP changes";
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

function githubRemoteUrl(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for AMP push.");
  }

  return `https://github.com/${repositoryFullName}.git`;
}

function gitAuthExtraHeaderArg() {
  return '-c http.extraheader="Authorization: Bearer $GITHUB_TOKEN"';
}

async function readSandboxBrainSnapshot(sandbox: SandboxHandle, workdir: string) {
  const result = await sandbox.commands.run(
    `cd ${shellQuote(workdir)} && if [ -d brain ]; then find brain -type f -printf '%P\t%s\t%T@\\n' | sort; fi`,
    { timeoutMs: 30_000 },
  );
  return String(result.stdout ?? "");
}

function formatAmpDiffStat(stat: unknown, status: unknown) {
  const statText = String(stat ?? "").trim();
  const statusText = String(status ?? "").trim();
  if (!statusText) return statText;
  if (!statText) return statusText;
  return `${statText}\n\n${statusText}`;
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

function readOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readOptionalFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function buildCacheableSystemPrompt(
  systemPrompt: string,
  modelName: string,
): string | SystemModelMessage {
  if (!modelName.startsWith("anthropic/")) return systemPrompt;

  return {
    role: "system",
    content: systemPrompt,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
}

export async function acquireRunLease(input: {
  sessionId: string;
  messageId: string;
  leaseId: string;
  leaseOwner: string;
  modelProvider: string;
  modelName: string;
}) {
  return claimDbRunLease(input);
}

export async function isRunLeaseCurrent(sessionId: string, leaseId: string, leaseOwner: string) {
  const [session] = await getDb()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.runLeaseId, leaseId),
        eq(agentSessions.runLeaseOwner, leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .limit(1);

  return Boolean(session);
}

async function updateSandboxForLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  sandboxId: string,
) {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ e2bSandboxId: sandboxId, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.runLeaseId, leaseId),
        eq(agentSessions.runLeaseOwner, leaseOwner),
        isNull(agentSessions.archivedAt),
      ),
    )
    .returning({ id: agentSessions.id });

  return Boolean(updated);
}

export async function createAssistantMessageForLease(input: {
  id: string;
  sessionId: string;
  responseToMessageId: string;
  leaseId: string;
  leaseOwner: string;
}) {
  await requireLeaseWrite(isRunLeaseCurrent(input.sessionId, input.leaseId, input.leaseOwner));

  const [message] = await getDb()
    .insert(agentSessionMessages)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      role: "assistant",
      status: "running",
      responseToMessageId: input.responseToMessageId,
    })
    .onConflictDoNothing({ target: agentSessionMessages.responseToMessageId })
    .returning({ id: agentSessionMessages.id });

  if (!message) return false;

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.id,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      type: "message.created",
      payload: { messageId: input.id, role: "assistant" },
    }),
  );
  return true;
}

export async function completeAssistantMessageForLease(input: {
  sessionId: string;
  assistantMessageId: string;
  leaseId: string;
  leaseOwner: string;
  content: string;
  modelMessage: Record<string, unknown>;
}) {
  await requireLeaseWrite(isRunLeaseCurrent(input.sessionId, input.leaseId, input.leaseOwner));

  const [updated] = await getDb()
    .update(agentSessionMessages)
    .set({
      status: "completed",
      content: input.content,
      modelMessage: input.modelMessage,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentSessionMessages.id, input.assistantMessageId),
        eq(agentSessionMessages.sessionId, input.sessionId),
      ),
    )
    .returning({ id: agentSessionMessages.id });

  return Boolean(updated);
}

async function insertToolMessageForLease(input: {
  id: string;
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
  content: string;
  modelMessage: Record<string, unknown>;
  toolName: string;
  toolCallId: string;
}) {
  await requireLeaseWrite(isRunLeaseCurrent(input.sessionId, input.leaseId, input.leaseOwner));

  const [message] = await getDb()
    .insert(agentSessionMessages)
    .values({
      id: input.id,
      sessionId: input.sessionId,
      role: "tool",
      status: "completed",
      content: input.content,
      modelMessage: input.modelMessage,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      completedAt: new Date(),
    })
    .returning({ id: agentSessionMessages.id });

  return Boolean(message);
}

export async function appendRuntimeEventForLease(
  input: Parameters<typeof appendRuntimeEvent>[1] & { leaseId: string; leaseOwner: string },
) {
  const { leaseId, leaseOwner, ...event } = input;
  if (!(await isRunLeaseCurrent(input.sessionId, leaseId, leaseOwner))) return false;
  await appendRuntimeEvent(getDb(), event);
  return true;
}

async function releaseRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "completed",
) {
  return finishDbRunLease({ sessionId, leaseId, leaseOwner, status, lastError: null });
}

async function failRunLease(
  sessionId: string,
  leaseId: string,
  leaseOwner: string,
  status: "aborting" | "failed",
  message: string,
) {
  return finishDbRunLease({ sessionId, leaseId, leaseOwner, status, lastError: message });
}

async function requireLeaseWrite(write: Promise<boolean> | boolean) {
  if (!(await write)) {
    throw new StaleRunLeaseError();
  }
}

class StaleRunLeaseError extends Error {
  constructor() {
    super("Run lease is no longer current.");
  }
}

class RecoverableToolError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "RecoverableToolError";
    this.code = code;
  }
}

async function ensureSandbox(row: LoadedSession, env: RunnerEnv) {
  let sandbox: SandboxHandle | null = null;
  try {
    sandbox = await createOrConnectSandbox({
      sandboxId: row.session.e2bSandboxId,
      template: resolveSandboxTemplate(row.agent.config, env),
      envs: {
        E2B_API_KEY: env.e2bApiKey,
        VERCEL_AI_GATEWAY_API_KEY: env.vercelAiGatewayApiKey,
      },
      idleTimeoutMs: env.e2bSandboxIdleTimeoutMs,
    });
    const sessionRepository = resolveSessionRepository(row);
    const githubToken = await resolveGitHubToken(row, sessionRepository);
    await prepareWorkspace({
      sandbox,
      workdir: row.session.workdir,
      agentFile: serializeRuntimeAgentFile(row.agent.config),
      repositoryFullName: sessionRepository?.fullName,
      repositoryDefaultBranch: sessionRepository?.defaultBranch,
      githubToken,
    });
    await materializeBrainForSession({
      sandbox,
      sessionId: row.session.id,
      workspaceId: row.workspace.id,
      workdir: row.session.workdir,
      references: row.agent.config.brain,
    });
    return sandbox;
  } catch (error) {
    captureException(error, {
      event: "opencompany.runner_sandbox_failed",
      workspace_id: row.workspace.id,
      user_id: row.session.userId,
      agent_id: row.agent.id,
      session_id: row.session.id,
      sandbox_id: sandbox?.sandboxId ?? row.session.e2bSandboxId,
      existing_sandbox: Boolean(row.session.e2bSandboxId),
    });
    if (sandbox) {
      await parkSandboxWhenIdle(sandbox, env);
    }
    throw error;
  }
}

function resolveSandboxTemplate(agentConfig: AgentConfig, env: RunnerEnv) {
  return agentConfig.tools.some(
    (tool) => tool.id === "amp" && typeof tool.repository === "string" && tool.repository,
  )
    ? (env.ampE2bTemplate ?? "amp")
    : env.e2bTemplate;
}

function resolveSessionRepository(row: LoadedSession) {
  const ampTool = row.agent.config.tools.find((tool) => tool.id === "amp");
  if (!ampTool || ampTool.id !== "amp" || !ampTool.repository) return null;
  return (
    row.agent.config.integrations.github.repositories.find(
      (repository) => repository.id === ampTool.repository,
    ) ?? null
  );
}

async function resolveGitHubToken(
  row: LoadedSession,
  sessionRepository: ReturnType<typeof resolveSessionRepository>,
) {
  if (!sessionRepository) return null;

  const integrationRepository = await loadGitHubWorkRepository(
    row.workspace.id,
    sessionRepository.fullName,
  );
  return getGitHubWorkInstallationToken({
    installationId: integrationRepository.installationId,
    repositoryFullName: sessionRepository.fullName,
  });
}

async function parkSandboxWhenIdle(sandbox: SandboxHandle, env: RunnerEnv) {
  try {
    const armed = await armSandboxIdleTimeout(sandbox, env.e2bSandboxIdleTimeoutMs);
    if (!armed) {
      logger.warn("E2B sandbox was gone before idle timeout could be armed", {
        sandbox_id: sandbox.sandboxId,
      });
    }
  } catch (error) {
    logger.warn("Failed to arm E2B sandbox idle timeout", {
      sandbox_id: sandbox.sandboxId,
      error,
    });
  }
}

async function loadSession(sessionId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      session: agentSessions,
      agent: agents,
      workspace: workspaces,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const [repository] = await db
    .select()
    .from(workspaceRepositories)
    .where(eq(workspaceRepositories.workspaceId, row.workspace.id))
    .limit(1);

  return { ...row, repository: repository ?? null };
}

type LoadedSession = Awaited<ReturnType<typeof loadSession>>;

async function loadUserMessage(sessionId: string, messageId: string) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.id, messageId),
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.role, "user"),
      ),
    )
    .limit(1);

  return message ?? null;
}

async function loadAssistantResponseForMessage(sessionId: string, messageId: string) {
  const [message] = await getDb()
    .select({ id: agentSessionMessages.id })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, sessionId),
        eq(agentSessionMessages.responseToMessageId, messageId),
      ),
    )
    .limit(1);

  return message ?? null;
}

async function setStatus(sessionId: string, status: "provisioning" | "ready" | "completed") {
  const [updated] = await getDb()
    .update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        isNull(agentSessions.archivedAt),
        isNull(agentSessions.runLeaseId),
      ),
    )
    .returning({ id: agentSessions.id });

  return Boolean(updated);
}

async function isSessionArchived(sessionId: string) {
  const [session] = await getDb()
    .select({ archivedAt: agentSessions.archivedAt })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return Boolean(session?.archivedAt);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}

function preflightSandboxToolArgs(input: {
  name: RuntimeToolName;
  args: unknown;
  workdir: string;
}) {
  if (input.name !== "read_file" && input.name !== "write_file" && input.name !== "list_files") {
    return;
  }

  const args = isRecord(input.args) ? input.args : {};
  const pathValue = args.path;
  if (input.name !== "list_files" && typeof pathValue !== "string") {
    throw new RecoverableToolError("Tool argument path must be a string.", "invalid_tool_input");
  }
  if (input.name === "list_files" && pathValue !== undefined && typeof pathValue !== "string") {
    throw new RecoverableToolError("Tool argument path must be a string.", "invalid_tool_input");
  }

  try {
    resolveSandboxToolPath(input.workdir, typeof pathValue === "string" ? pathValue : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid sandbox path.";
    throw new RecoverableToolError(
      `${message} Use paths prefixed with work/ for scratch files or brain/ for mounted Brain files.`,
      "invalid_sandbox_path",
    );
  }
}

function isFatalToolError(
  error: unknown,
  toolKind: RuntimeToolDefinition["kind"],
  sandboxIdForCapture: string | undefined,
  signal: AbortSignal,
) {
  if (
    signal.aborted ||
    error instanceof RunAbortError ||
    error instanceof RunLeaseLostError ||
    error instanceof StaleRunLeaseError
  ) {
    return true;
  }

  if (error instanceof MissingEnvError) return true;
  if (error instanceof RecoverableToolError) return false;
  return toolKind === "sandbox" && !sandboxIdForCapture;
}

function buildFailedToolOutput(error: unknown): FailedToolOutput {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : "Tool failed.",
      code: error instanceof RecoverableToolError ? error.code : "tool_execution_failed",
      recoverable: true,
    },
  };
}

export function throwIfStreamErrorPart(part: TextStreamPart<ToolSet>) {
  if (part.type === "abort") {
    throw new RunAbortError(part.reason || "Run aborted.");
  }

  if (part.type === "error") {
    throw toStreamError(part.error, "Model stream failed.");
  }

  if (part.type === "tool-error") {
    throw toStreamError(part.error, `Tool ${part.toolName} failed.`);
  }
}

export function readReasoningTextDelta(part: TextStreamPart<ToolSet> | Record<string, unknown>) {
  if (part.type !== "reasoning" && part.type !== "reasoning-delta") return "";
  if (typeof part.text === "string") return part.text;
  if ("delta" in part && typeof part.delta === "string") return part.delta;
  return "";
}

export function normalizeReasoningSummary(summary: string) {
  const normalized = summary
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length > 0 ? normalized : "";
}

function toStreamError(error: unknown, fallback: string) {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.trim()) return new Error(error);
  if (error === null || error === undefined) return new Error(fallback);

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return new Error(serialized);
  } catch {
    // Fall through to the fallback message.
  }

  return new Error(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

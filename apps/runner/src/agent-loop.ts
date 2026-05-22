import {
  CORE_TOOL_DEFINITIONS,
  newAgentSessionMessageId,
  newRunLeaseId,
  resolveAgentRuntimeConfig,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agentSessionUsage,
  agents,
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
  stepCountIs,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";
import { getGitHubInstallationToken } from "./github";
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
  runSandboxTool,
  type SandboxHandle,
} from "./sandbox";
import { normalizeModelUsage } from "./usage";

const activeRuns = new Map<string, { leaseId: string; controller: AbortController }>();
const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

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
      getSandbox,
      workdir: row.session.workdir,
      signal: controller.signal,
      checkAbort,
    });

    let assistantContent = "";
    const assistantReplayParts: AssistantReplayPart[] = [];
    let stepIndex = 0;
    const result = streamText({
      model: gateway(runtime.model.name),
      system: runtime.systemPrompt,
      messages,
      tools: pickRuntimeTools(tools, runtime.tools),
      stopWhen: stepCountIs(8),
      abortSignal: controller.signal,
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
          await requireLeaseWrite(
            appendRuntimeEventForLease({
              sessionId: input.sessionId,
              messageId: assistantMessageId,
              leaseId,
              leaseOwner,
              type: "message.delta",
              payload: { messageId: assistantMessageId, delta: part.text },
            }),
          );
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

    await checkAbort();
    if (!assistantContent && assistantReplayParts.length === 0) {
      throw new Error("Model stream completed without text or tool calls.");
    }

    const assistantModelMessage = buildAssistantModelMessage({
      content: assistantContent,
      parts: assistantReplayParts,
    });

    await requireLeaseWrite(
      completeAssistantMessageForLease({
        sessionId: input.sessionId,
        assistantMessageId,
        leaseId,
        leaseOwner,
        content: assistantContent,
        modelMessage: toPersistedModelMessage(assistantModelMessage),
      }),
    );
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        leaseId,
        leaseOwner,
        type: "message.completed",
        payload: { messageId: assistantMessageId, content: assistantContent },
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
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown runner error";
    captureException(error, {
      event: "opencompany.runner_message_failed",
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
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
}) {
  const tools: ToolSet = {};

  for (const definition of CORE_TOOL_DEFINITIONS) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
      onInputDelta: async ({ inputTextDelta, toolCallId }) => {
        await input.checkAbort();
        await requireLeaseWrite(
          appendRuntimeEventForLease({
            sessionId: input.sessionId,
            messageId: input.assistantMessageId,
            leaseId: input.runLeaseId,
            leaseOwner: input.runLeaseOwner,
            type: "tool.delta",
            payload: {
              messageId: input.assistantMessageId,
              toolCallId,
              delta: inputTextDelta,
            },
          }),
        );
      },
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
          toolCallId: options.toolCallId,
          name: definition.name,
          args: toolInput,
          getSandbox: input.getSandbox,
          workdir: input.workdir,
          signal: input.signal,
          checkAbort: input.checkAbort,
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

async function executeRuntimeTool(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  toolCallId: string;
  name: string;
  args: unknown;
  getSandbox: () => Promise<SandboxHandle>;
  workdir: string;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
}) {
  let output: unknown;
  let sandbox: SandboxHandle | null = null;
  try {
    const activeSandbox = await input.getSandbox();
    sandbox = activeSandbox;
    output = await withRunControlChecks(input.checkAbort, async () => {
      throwIfAborted(input.signal);

      return runSandboxTool({
        sandbox: activeSandbox,
        workdir: input.workdir,
        name: input.name,
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
                command: input.name,
                toolCallId: input.toolCallId,
                stream,
                delta,
              },
            }),
          );
        },
      });
    });
  } catch (error) {
    captureException(error, {
      event: "opencompany.runner_tool_failed",
      session_id: input.sessionId,
      message_id: input.assistantMessageId,
      tool_call_id: input.toolCallId,
      tool_name: input.name,
      sandbox_id: sandbox?.sandboxId,
    });
    throw error;
  }

  const changedPath =
    isRecord(output) && Object.prototype.hasOwnProperty.call(output, "path")
      ? (output as { path: unknown }).path
      : null;
  if (input.name === "write_file" && typeof changedPath === "string") {
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
          toolName: input.name,
          output,
        }),
      ),
      toolName: input.name,
      toolCallId: input.toolCallId,
    }),
  );
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
        name: input.name,
        output,
      },
    }),
  );

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
    finishReason: input.finishReason,
    ...(input.rawFinishReason ? { rawFinishReason: input.rawFinishReason } : {}),
  };

  await db.insert(agentSessionUsage).values({
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
  });

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

async function ensureSandbox(row: LoadedSession, env: RunnerEnv) {
  let sandbox: SandboxHandle | null = null;
  try {
    sandbox = await createOrConnectSandbox({
      sandboxId: row.session.e2bSandboxId,
      template: env.e2bTemplate,
      envs: {
        E2B_API_KEY: env.e2bApiKey,
        VERCEL_AI_GATEWAY_API_KEY: env.vercelAiGatewayApiKey,
      },
      idleTimeoutMs: env.e2bSandboxIdleTimeoutMs,
    });
    await prepareWorkspace({
      sandbox,
      workdir: row.session.workdir,
      agentFile: row.agent.body,
      repositoryFullName: row.repository?.fullName,
      githubToken: await getGitHubInstallationToken(),
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
      repository: workspaceRepositories,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
    .leftJoin(
      workspaceRepositories,
      eq(agentSessions.workspaceId, workspaceRepositories.workspaceId),
    )
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return row;
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

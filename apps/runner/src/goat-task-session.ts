import { randomUUID } from "node:crypto";
import { executeExaSearchRequest, goatTaskRunSessionId } from "@opencompany/agent-runtime";
import { calculateModelUsageCost } from "@opencompany/billing";
import { listGoatBrainFiles } from "@opencompany/db/goat-brain-files";
import type { GoatTask } from "@opencompany/db/goat-schema";
import {
  getDefaultGoatBrainForUser,
  listGoatWorkspacesForUser,
} from "@opencompany/db/goat-workspaces";
import {
  captureToGoatBrainInbox,
  createOpenCompanyChatSystemPrompt,
  createOpenCompanyChatToolContext,
  OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
  runGoatBrainToolForUser,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@opencompany/goat-agent";
import { isValidGoatBrainId } from "@opencompany/goat-brain/schema";
import {
  createGoatGatewayAttribution,
  GOAT_SPANS,
  goatGatewayProviderOptions,
  hashGoatUserId,
  recordGoatTaskRun,
  startGoatSpan,
} from "@opencompany/goat-observability";
import { captureException, createLogger } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import * as ai from "ai";
import { createGateway, type LanguageModelUsage, type ModelMessage, stepCountIs } from "ai";
import { sql } from "drizzle-orm";
import { getDb as getRunnerDb } from "./db";
import type { RunnerEnv } from "./env";
import { wakeGoatBrainIngestWorker } from "./goat-brain-ingest-worker";
import { createDbGoatTaskStore, GOAT_TASK_LEASE_TTL_MS, type GoatTaskStore } from "./goat-worker";
import { rowsFromExecute } from "./sql-exec";
import { normalizeModelUsage } from "./usage";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-task-session" });

// A task run is one long agent conversation; chat turns get 8 steps, tasks 16.
const GOAT_TASK_SESSION_MAX_STEPS = 16;
// Same cadence the codex chat projector uses to stream content via Electric.
const ASSISTANT_CONTENT_FLUSH_INTERVAL_MS = 500;
// Steering messages that arrive mid-turn start another turn; cap the drain so
// a chatty user cannot keep one lease alive forever.
const MAX_DRAIN_TURNS = 8;

const GOAT_FINALIZATION_SYSTEM_INSTRUCTION =
  "You are out of tool budget for this task. Do not request more tools. Write your final answer now using everything gathered so far.";
// Appended ephemerally (never persisted) when a retried or reclaimed run's
// transcript already ends with an assistant message.
const GOAT_RECOVERY_INSTRUCTION =
  "The previous attempt was interrupted before the task finished. Continue the task from where it left off and produce the final result.";

type SessionMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date | string;
};

export async function runClaimedGoatTaskSession(input: {
  task: GoatTask;
  env: RunnerEnv;
  store?: GoatTaskStore;
}) {
  const { task, env } = input;
  const store = input.store ?? createDbGoatTaskStore();
  const leaseId = requireLease(task.leaseId, task.id, "leaseId");
  const leaseOwner = requireLease(task.leaseOwner, task.id, "leaseOwner");
  const sessionId = goatTaskRunSessionId(task.id);
  const runStartedAt = performance.now();
  const userIdHash = hashGoatUserId(task.userWorkosId);
  const baseAttributes = {
    ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
    "goat.task_id": task.id,
    "goat.display_id": task.displayId,
    "goat.model": task.model,
    "goat.attempt": task.attempts,
    "goat.lease_owner": leaseOwner,
  };
  const runSpan = startGoatSpan(GOAT_SPANS.taskRun, baseAttributes);
  const abortController = new AbortController();
  let leaseActive = true;

  const handleLeaseLost = () => {
    if (!leaseActive) return;
    leaseActive = false;
    abortController.abort();
    logger.warn("Goat task lease lost", {
      event: "opencompany.goat_task_lease_lost",
      task_id: task.id,
    });
  };

  const guard = { taskId: task.id, leaseId, leaseOwner };

  const heartbeatTimer = setInterval(() => {
    const now = new Date();
    void store
      .heartbeat({
        id: task.id,
        leaseId,
        leaseOwner,
        now,
        leaseExpiresAt: new Date(now.getTime() + (env.jobLeaseTtlMs ?? GOAT_TASK_LEASE_TTL_MS)),
      })
      .then((active) => {
        if (!active) handleLeaseLost();
      })
      .catch((error) => {
        captureException(error, {
          event: "opencompany.goat_task_heartbeat_failed",
          task_id: task.id,
        });
        handleLeaseLost();
      });
  }, 5_000);

  const finish = (outcome: "success" | "failure" | "aborted", failureCategory?: string) => {
    runSpan.end({
      ...baseAttributes,
      "goat.outcome": outcome,
      ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
    });
    recordGoatTaskRun({
      durationMs: Math.round(performance.now() - runStartedAt),
      outcome,
      attributes: {
        ...baseAttributes,
        ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
      },
    });
  };

  try {
    await ensureRunSessionScaffolding({ task, sessionId, guard });
    await insertStatusComment({
      guard,
      commentId: `goat_task_comment_${task.id}_started_${task.attempts}`,
      userWorkosId: task.userWorkosId,
      content: task.attempts > 1 ? `Run restarted (attempt ${task.attempts}).` : "Run started.",
      metadata: { status: task.attempts > 1 ? "retrying" : "started" },
    });

    const result = await runSpan.runInContext(() =>
      runGoatTaskSessionTurns({
        task,
        env,
        sessionId,
        guard,
        signal: abortController.signal,
      }),
    );

    const completed = await completeTaskSession({
      guard,
      result: result.finalText,
      now: new Date(),
    });
    if (!completed) {
      handleLeaseLost();
      finish("aborted", "lease_lost");
      return;
    }
    finish("success");
    logger.info("Goat task run finished", {
      event: "opencompany.goat_task_run_finished",
      outcome: "success",
      task_id: task.id,
      display_id: task.displayId,
      model: task.model,
      duration_ms: Math.round(performance.now() - runStartedAt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Goat task run failed.";
    if (leaseActive) {
      await failTaskSession({ guard, error: message, now: new Date() }).catch((failError) => {
        captureException(failError, {
          event: "opencompany.goat_task_fail_write_failed",
          task_id: task.id,
        });
      });
      finish("failure", "execution_error");
    } else {
      finish("aborted", "lease_lost");
    }
    captureException(error, { event: "opencompany.goat_task_failed", task_id: task.id });
    logger.error("Goat task run finished", {
      event: "opencompany.goat_task_run_finished",
      outcome: leaseActive ? "failure" : "aborted",
      task_id: task.id,
      display_id: task.displayId,
      error,
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function runGoatTaskSessionTurns(input: {
  task: GoatTask;
  env: RunnerEnv;
  sessionId: string;
  guard: LeaseGuard;
  signal: AbortSignal;
}): Promise<{ finalText: string }> {
  const { task, env, sessionId, guard, signal } = input;
  const runtime = await buildTaskSessionRuntime({ task, env, signal });
  let finalText = "";

  for (let turn = 0; turn < MAX_DRAIN_TURNS; turn++) {
    const history = await listSessionMessages(sessionId);
    const lastRow = history[history.length - 1];
    const modelMessages = toModelMessages(history);
    if (modelMessages.length === 0) {
      throw new Error("Goat task run session has no messages.");
    }
    if (modelMessages[modelMessages.length - 1]?.role === "assistant") {
      modelMessages.push({ role: "user", content: GOAT_RECOVERY_INSTRUCTION });
    }

    const turnResult = await runSingleSessionTurn({
      task,
      env,
      sessionId,
      guard,
      signal,
      runtime,
      modelMessages,
    });
    finalText = turnResult.text || finalText;

    // Steering: user messages that arrived while this turn ran start another
    // turn with full history; otherwise the run is done.
    const pending = lastRow ? await countUserMessagesAfter(sessionId, lastRow) : 0;
    if (pending === 0) return { finalText };
  }
  return { finalText };
}

type TaskSessionRuntime = {
  tools: ai.ToolSet;
  system: string;
};

async function buildTaskSessionRuntime(input: {
  task: GoatTask;
  env: RunnerEnv;
  signal: AbortSignal;
}): Promise<TaskSessionRuntime> {
  const { task, env, signal } = input;
  const [brain, workspaces, user] = await Promise.all([
    getDefaultGoatBrainForUser(task.userWorkosId),
    listGoatWorkspacesForUser(task.userWorkosId),
    loadGoatUser(task.userWorkosId),
  ]);
  const workspaceEntry = workspaces[0] ?? null;
  const canManageBrain = workspaceEntry?.role === "admin";
  const exaApiKey = env.exaApiKey;

  const toolContext = createOpenCompanyChatToolContext({
    model: task.model,
    latestUserMessage: task.prompt,
    runBrainCli: (toolInput, toolExecutionContext) => {
      if (!brain) {
        return Promise.resolve({
          ok: false as const,
          exitCode: null,
          stdout: "",
          stderr: "",
          error: "You do not have access to any brain in this workspace.",
        });
      }
      const toolCallId = readToolCallId(toolExecutionContext);
      return runGoatBrainToolForUser({
        brainRef: brain.id,
        userWorkosId: task.userWorkosId,
        toolInput,
        gatewayApiKey: env.vercelAiGatewayApiKey,
        sourceRef: `goat-task:${task.id}`,
        ...(toolCallId ? { toolCallId } : {}),
        signal,
      });
    },
    ...(brain && canManageBrain
      ? {
          saveToBrain: async (toolInput) => {
            const content = toolInput.content?.trim();
            if (!content) {
              return { ok: false as const, error: "Provide content to save." };
            }
            const captured = await captureToGoatBrainInbox(
              {
                brainRef: brain.id,
                userWorkosId: task.userWorkosId,
                text: content,
                ...(toolInput.title ? { title: toolInput.title } : {}),
                ...(toolInput.intent ? { intent: toolInput.intent } : {}),
                source: {
                  kind: "chat",
                  connectionId: goatTaskRunSessionId(task.id),
                  itemId: task.id,
                },
              },
              {
                nextAvailableBrainId: nextAvailableGoatBrainId,
                wakeIngest: async () => {
                  wakeGoatBrainIngestWorker();
                },
              },
            );
            if (!captured.ok) return captured;
            return {
              ok: true as const,
              draftId: captured.draftBrainId,
              path: captured.path,
              title: captured.title,
              status: captured.quotaPaused ? "paused_by_plan" : "captured",
            };
          },
        }
      : {}),
    ...(exaApiKey
      ? {
          webSearch: (toolInput) => executeTaskWebSearch({ toolInput, apiKey: exaApiKey, signal }),
        }
      : {}),
  });

  const system = createOpenCompanyChatSystemPrompt({
    currentDate: new Date(),
    ...(user
      ? {
          userContext: {
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            timezone: user.timezone,
          },
        }
      : {}),
    webSearchEnabled: Boolean(exaApiKey),
    brainCaptureEnabled: Boolean(brain && canManageBrain),
    activeBrain:
      brain && workspaceEntry
        ? {
            name: brain.name,
            workspaceName: workspaceEntry.workspace.name,
            readOnly: !canManageBrain,
          }
        : null,
    taskToolsEnabled: false,
    scheduleToolsEnabled: false,
  });

  return { tools: toolContext.tools, system };
}

async function runSingleSessionTurn(input: {
  task: GoatTask;
  env: RunnerEnv;
  sessionId: string;
  guard: LeaseGuard;
  signal: AbortSignal;
  runtime: TaskSessionRuntime;
  modelMessages: ModelMessage[];
}): Promise<{ text: string }> {
  const { task, env, sessionId, guard, signal, runtime, modelMessages } = input;
  const placeholderId = await insertAssistantPlaceholder({ guard, sessionId, model: task.model });
  const gateway = createGateway({ apiKey: env.vercelAiGatewayApiKey });
  const { streamText } = getBraintrustAISDK(ai);
  const attribution = createGoatGatewayAttribution({
    userWorkosId: task.userWorkosId,
    feature: "task",
    taskId: task.id,
  });

  let assistantContent = "";
  let usage: LanguageModelUsage | undefined;
  let finishReason: string | undefined;
  let lastFlushAt = 0;
  let stepIndex = 0;
  const turnStartedAt = performance.now();

  const flushContent = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlushAt < ASSISTANT_CONTENT_FLUSH_INTERVAL_MS) return;
    lastFlushAt = now;
    await updateAssistantContent({ guard, messageId: placeholderId, content: assistantContent });
  };

  try {
    const stream = streamText({
      model: gateway(task.model),
      system: runtime.system,
      messages: modelMessages,
      tools: runtime.tools,
      stopWhen: [stepCountIs(GOAT_TASK_SESSION_MAX_STEPS)],
      prepareStep: ({ stepNumber }: { stepNumber: number }) =>
        stepNumber < GOAT_TASK_SESSION_MAX_STEPS - 1
          ? {}
          : {
              activeTools: [],
              toolChoice: "none" as const,
              system: `${runtime.system}\n\n${GOAT_FINALIZATION_SYSTEM_INSTRUCTION}`,
            },
      abortSignal: signal,
      providerOptions: goatGatewayProviderOptions(attribution),
    });

    for await (const part of stream.fullStream) {
      if (signal.aborted) throw new Error("Goat task run aborted.");
      if (part.type === "text-delta") {
        assistantContent += part.text;
        await flushContent(false);
      } else if (part.type === "finish-step") {
        const finishPart = part as {
          usage?: LanguageModelUsage;
          response?: { id?: string | null; modelId?: string | null; timestamp?: Date | null };
          finishReason?: string | null;
          rawFinishReason?: string | null;
        };
        usage = finishPart.usage;
        finishReason = finishPart.finishReason ?? undefined;
        if (finishPart.usage) {
          await recordTaskModelUsage({
            task,
            guard,
            messageId: placeholderId,
            stepIndex,
            usage: finishPart.usage,
            responseId: finishPart.response?.id ?? null,
            responseModelId: finishPart.response?.modelId ?? null,
            finishReason: finishPart.finishReason ?? null,
            rawFinishReason: finishPart.rawFinishReason ?? null,
            providerCreatedAt: finishPart.response?.timestamp ?? null,
          });
        }
        stepIndex += 1;
        await flushContent(true);
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error("Goat model stream failed.");
      }
    }

    const finalText = (await stream.text).trim();
    if (finalText) assistantContent = finalText;
    const uiMessageParts = await buildUiMessageParts(stream);
    await completeAssistantMessage({
      guard,
      messageId: placeholderId,
      content: assistantContent,
      debugTrace: {
        schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
        model: task.model,
        ...(finishReason ? { finishReason } : {}),
        ...(uiMessageParts.length > 0 ? { uiMessageParts } : {}),
        ...(usage
          ? {
              usage: {
                inputTokens: readUsageNumber(usage.inputTokens),
                outputTokens: readUsageNumber(usage.outputTokens),
                totalTokens: readUsageNumber(usage.totalTokens),
              },
            }
          : {}),
        durationMs: Math.round(performance.now() - turnStartedAt),
      },
    });
    return { text: assistantContent };
  } catch (error) {
    await completeAssistantMessage({
      guard,
      messageId: placeholderId,
      content: assistantContent,
      debugTrace: {
        schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
        model: task.model,
        error: error instanceof Error ? error.message : "Goat task run failed.",
      },
    }).catch(() => {});
    throw error;
  }
}

// Renders the turn's tool activity in the chat surface: persisted tool parts
// use the same `tool-<name>` shape the live useChat stream produces.
async function buildUiMessageParts(stream: {
  steps: PromiseLike<ReadonlyArray<{ content: ReadonlyArray<unknown> }>>;
}): Promise<unknown[]> {
  try {
    const steps = await stream.steps;
    const parts: unknown[] = [];
    for (const step of steps) {
      const content = step.content.filter(isContentRecord);
      const outputsByCallId = new Map<string, unknown>();
      for (const part of content) {
        if (part.type === "tool-result" && typeof part.toolCallId === "string") {
          outputsByCallId.set(part.toolCallId, part.output);
        }
      }
      for (const part of content) {
        if (part.type === "text" && typeof part.text === "string" && part.text) {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "tool-call" && typeof part.toolCallId === "string") {
          const toolName = typeof part.toolName === "string" ? part.toolName : "unknown";
          parts.push({
            type: `tool-${toolName}`,
            toolCallId: part.toolCallId,
            state: "output-available",
            input: part.input,
            output: outputsByCallId.get(part.toolCallId),
          });
        }
      }
    }
    return parts;
  } catch {
    return [];
  }
}

function isContentRecord(value: unknown): value is Record<string, unknown> & { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

async function executeTaskWebSearch(input: {
  toolInput: WebSearchToolInput;
  apiKey: string;
  signal: AbortSignal;
}): Promise<WebSearchToolOutput> {
  const now = new Date();
  const recencyDays = input.toolInput.recencyDays;
  const startPublishedDate =
    recencyDays === 7 || recencyDays === 30 || recencyDays === 90
      ? new Date(now.getTime() - recencyDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
  const search = await executeExaSearchRequest({
    apiKey: input.apiKey,
    args: {
      query: input.toolInput.query,
      type: "fast",
      numResults: 5,
      ...(startPublishedDate ? { startPublishedDate } : {}),
    },
    signal: input.signal,
    defaults: { type: "fast", numResults: 5 },
  });

  return {
    ok: true,
    query: input.toolInput.query,
    searchedAt: now.toISOString(),
    results: search.output.results.map((result) => ({
      ...(result.title ? { title: result.title } : {}),
      ...(result.url ? { url: result.url } : {}),
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      ...(result.author ? { author: result.author } : {}),
      highlights: result.highlights ?? [],
    })),
    ...(search.output.requestId ? { requestId: search.output.requestId } : {}),
    costUsdMicros: search.usage.costUsdMicros,
  };
}

// Duplicated from apps/goat/lib/brain.ts (app-only module); both build on the
// shared listGoatBrainFiles. Consolidate when the app copy moves to a package.
async function nextAvailableGoatBrainId(brainRef: string, baseId: string): Promise<string> {
  const base = isValidGoatBrainId(baseId) ? baseId : "untitled";
  const rows = await listGoatBrainFiles({ brainRef }, { includeInvalid: true });
  const used = new Set(rows.map((row) => row.brainId));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const ending = `-${suffix}`;
    const prefix = base.slice(0, 80 - ending.length).replace(/-+$/g, "");
    const candidate = `${prefix || "untitled"}${ending}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique brain id.");
}

type LeaseGuard = { taskId: string; leaseId: string; leaseOwner: string };

function leaseExistsSql(guard: LeaseGuard) {
  return sql`EXISTS (
    SELECT 1 FROM goat.tasks AS lease_task
    WHERE lease_task.id = ${guard.taskId}
      AND lease_task.lease_id = ${guard.leaseId}
      AND lease_task.lease_owner = ${guard.leaseOwner}
      AND lease_task.status = 'running'
  )`;
}

async function ensureRunSessionScaffolding(input: {
  task: GoatTask;
  sessionId: string;
  guard: LeaseGuard;
}) {
  const { task, sessionId } = input;
  const now = new Date();
  await getRunnerDb().execute(sql`
    INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, task_id, created_at, updated_at)
    VALUES (${sessionId}, ${task.userWorkosId}, ${task.name}, ${task.model}, 'opencompany', ${task.id}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `);
  const openingMessageId = `goat_chat_msg_${randomUUID()}`;
  await getRunnerDb().execute(sql`
    INSERT INTO goat.chat_messages (id, session_id, role, content, created_at, updated_at)
    SELECT ${openingMessageId}, ${sessionId}, 'user', ${task.prompt}, ${now}, ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM goat.chat_messages WHERE session_id = ${sessionId} AND role = 'user'
    )
  `);
}

async function listSessionMessages(sessionId: string): Promise<SessionMessageRow[]> {
  const result = await getRunnerDb().execute(sql`
    SELECT id, role, content, created_at
    FROM goat.chat_messages
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC, id ASC
  `);
  return rowsFromExecute<SessionMessageRow>(result);
}

function toModelMessages(rows: SessionMessageRow[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const row of rows) {
    const content = row.content.trim();
    if (!content) continue;
    messages.push({ role: row.role, content });
  }
  return messages;
}

async function countUserMessagesAfter(sessionId: string, after: SessionMessageRow) {
  const result = await getRunnerDb().execute(sql`
    SELECT count(*)::int AS count
    FROM goat.chat_messages
    WHERE session_id = ${sessionId}
      AND role = 'user'
      AND (created_at, id) > (${toDate(after.created_at)}, ${after.id})
  `);
  return rowsFromExecute<{ count: number }>(result)[0]?.count ?? 0;
}

async function insertAssistantPlaceholder(input: {
  guard: LeaseGuard;
  sessionId: string;
  model: string;
}) {
  const messageId = `goat_chat_msg_${randomUUID()}`;
  const now = new Date();
  const trace = { schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION, model: input.model };
  const result = await getRunnerDb().execute(sql`
    INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
    SELECT ${messageId}, ${input.sessionId}, 'assistant', '', ${JSON.stringify(trace)}::jsonb, ${now}, ${now}
    WHERE ${leaseExistsSql(input.guard)}
    RETURNING id
  `);
  const row = rowsFromExecute<{ id: string }>(result)[0];
  if (!row) throw new Error("Goat task lease lost while trying to create the assistant message.");
  return row.id;
}

async function updateAssistantContent(input: {
  guard: LeaseGuard;
  messageId: string;
  content: string;
}) {
  const now = new Date();
  const result = await getRunnerDb().execute(sql`
    UPDATE goat.chat_messages
    SET content = ${input.content},
        updated_at = ${now}
    WHERE id = ${input.messageId}
      AND ${leaseExistsSql(input.guard)}
    RETURNING id
  `);
  if (rowsFromExecute<{ id: string }>(result).length === 0) {
    throw new Error("Goat task lease lost while trying to stream the assistant message.");
  }
}

async function completeAssistantMessage(input: {
  guard: LeaseGuard;
  messageId: string;
  content: string;
  debugTrace: Record<string, unknown>;
}) {
  const now = new Date();
  await getRunnerDb().execute(sql`
    UPDATE goat.chat_messages
    SET content = ${input.content},
        debug_trace = ${JSON.stringify(input.debugTrace)}::jsonb,
        updated_at = ${now}
    WHERE id = ${input.messageId}
      AND ${leaseExistsSql(input.guard)}
  `);
}

async function insertStatusComment(input: {
  guard: LeaseGuard;
  commentId: string;
  userWorkosId: string;
  content: string;
  metadata: Record<string, unknown>;
}) {
  const now = new Date();
  await getRunnerDb().execute(sql`
    INSERT INTO goat.task_comments (id, task_id, user_workos_id, author, kind, content, metadata, created_at, updated_at)
    SELECT ${input.commentId}, ${input.guard.taskId}, ${input.userWorkosId}, 'agent', 'status', ${input.content}, ${JSON.stringify(input.metadata)}::jsonb, ${now}, ${now}
    WHERE ${leaseExistsSql(input.guard)}
    ON CONFLICT (id) DO NOTHING
  `);
}

async function recordTaskModelUsage(input: {
  task: GoatTask;
  guard: LeaseGuard;
  messageId: string;
  stepIndex: number;
  usage: LanguageModelUsage;
  responseId: string | null;
  responseModelId: string | null;
  finishReason: string | null;
  rawFinishReason: string | null;
  providerCreatedAt: Date | null;
}) {
  const usage = normalizeModelUsage(input.usage);
  const cost = calculateModelUsageCost({
    modelName: input.task.model,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
  });
  const now = new Date();
  await getRunnerDb().execute(sql`
    INSERT INTO goat.task_model_usage (
      task_id, user_workos_id, message_id, run_lease_id, phase, step_index,
      model_provider, model_name, response_id, response_model_id,
      finish_reason, raw_finish_reason,
      input_tokens, input_no_cache_tokens, input_cache_read_tokens, input_cache_write_tokens,
      output_tokens, total_tokens, raw_usage,
      provider_cost_usd_micros, platform_fee_usd_micros, total_cost_usd_micros, cost_basis,
      provider_created_at, created_at
    )
    SELECT
      ${input.task.id}, ${input.task.userWorkosId}, ${input.messageId}, ${input.guard.leaseId},
      'execution', ${input.stepIndex},
      'vercel-ai-gateway', ${input.task.model}, ${input.responseId}, ${input.responseModelId},
      ${input.finishReason}, ${input.rawFinishReason},
      ${usage.inputTokens}, ${usage.inputNoCacheTokens}, ${usage.inputCacheReadTokens}, ${usage.inputCacheWriteTokens},
      ${usage.outputTokens}, ${usage.totalTokens}, ${JSON.stringify(usage.rawUsage)}::jsonb,
      ${cost.providerCostUsdMicros}, ${cost.platformFeeUsdMicros}, ${cost.totalCostUsdMicros}, ${JSON.stringify(cost.costBasis)}::jsonb,
      ${input.providerCreatedAt}, ${now}
    WHERE ${leaseExistsSql(input.guard)}
  `);
}

async function completeTaskSession(input: { guard: LeaseGuard; result: string; now: Date }) {
  const { guard, now } = input;
  const resultCommentId = `goat_task_comment_${guard.taskId}_result_${guard.leaseId}`;
  const notificationContent = sql`
    'Task [' || task.display_id || '](/tasks/' || task.display_id || ') finished.' ||
    CASE WHEN ${input.result.trim()} = '' THEN '' ELSE E'\n\n' || ${input.result.trim()} END
  `;
  const result = await getRunnerDb().execute(sql`
    WITH completed_task AS (
      UPDATE goat.tasks AS task
      SET status = 'succeeded',
          stage = 'completed',
          result = ${input.result},
          error = NULL,
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      WHERE task.id = ${guard.taskId}
        AND task.lease_id = ${guard.leaseId}
        AND task.lease_owner = ${guard.leaseOwner}
        AND task.status = 'running'
      RETURNING task.id, task.display_id, task.name, task.user_workos_id
    ),
    result_comment AS (
      INSERT INTO goat.task_comments (id, task_id, user_workos_id, author, kind, content, metadata, created_at, updated_at)
      SELECT ${resultCommentId}, task.id, task.user_workos_id, 'agent', 'result', ${input.result}, '{}'::jsonb, ${now}, ${now}
      FROM completed_task AS task
      ON CONFLICT (id) DO NOTHING
    ),
    origin_chat AS (
      SELECT message.session_id, task.id AS task_id, task.display_id, task.name
      FROM goat.chat_messages AS message
      INNER JOIN goat.chat_sessions AS session ON session.id = message.session_id
      INNER JOIN completed_task AS task ON task.id = message.task_id
      WHERE session.closed_at IS NULL
        AND session.task_id IS NULL
      ORDER BY message.created_at ASC
      LIMIT 1
    ),
    inserted_notification AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      SELECT
        ${`goat_chat_msg_${randomUUID()}`},
        origin.session_id,
        'assistant',
        ${notificationContent},
        jsonb_build_object(
          'schemaVersion', 'goat.chat.debug.v1',
          'taskNotification', jsonb_build_object(
            'taskId', origin.task_id,
            'taskDisplayId', origin.display_id,
            'taskName', origin.name,
            'status', 'succeeded'
          )
        ),
        ${now},
        ${now}
      FROM origin_chat AS origin
      CROSS JOIN completed_task AS task
      WHERE NOT EXISTS (
        SELECT 1
        FROM goat.chat_messages AS existing
        WHERE existing.session_id = origin.session_id
          AND existing.debug_trace->'taskNotification'->>'taskId' = task.id
      )
      RETURNING session_id
    ),
    touched_chat AS (
      UPDATE goat.chat_sessions AS session
      SET updated_at = ${now}
      FROM inserted_notification AS notification
      WHERE session.id = notification.session_id
      RETURNING session.id
    )
    SELECT id FROM completed_task
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}

async function failTaskSession(input: { guard: LeaseGuard; error: string; now: Date }) {
  const { guard, now } = input;
  const failedCommentId = `goat_task_comment_${guard.taskId}_failed_${guard.leaseId}`;
  const metadata = { status: "failed", error: input.error };
  const notificationContent = sql`
    'Task [' || task.display_id || '](/tasks/' || task.display_id || ') failed.' ||
    CASE WHEN ${input.error.trim()} = '' THEN '' ELSE E'\n\n' || ${input.error.trim()} END
  `;
  await getRunnerDb().execute(sql`
    WITH failed_task AS (
      UPDATE goat.tasks AS task
      SET status = 'failed',
          stage = 'failed',
          error = ${input.error},
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      WHERE task.id = ${guard.taskId}
        AND task.lease_id = ${guard.leaseId}
        AND task.lease_owner = ${guard.leaseOwner}
        AND task.status = 'running'
      RETURNING task.id, task.display_id, task.name, task.user_workos_id
    ),
    failed_comment AS (
      INSERT INTO goat.task_comments (id, task_id, user_workos_id, author, kind, content, metadata, created_at, updated_at)
      SELECT ${failedCommentId}, task.id, task.user_workos_id, 'agent', 'status', '', ${JSON.stringify(metadata)}::jsonb, ${now}, ${now}
      FROM failed_task AS task
      ON CONFLICT (id) DO NOTHING
    ),
    origin_chat AS (
      SELECT message.session_id, task.id AS task_id, task.display_id, task.name
      FROM goat.chat_messages AS message
      INNER JOIN goat.chat_sessions AS session ON session.id = message.session_id
      INNER JOIN failed_task AS task ON task.id = message.task_id
      WHERE session.closed_at IS NULL
        AND session.task_id IS NULL
      ORDER BY message.created_at ASC
      LIMIT 1
    ),
    inserted_notification AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      SELECT
        ${`goat_chat_msg_${randomUUID()}`},
        origin.session_id,
        'assistant',
        ${notificationContent},
        jsonb_build_object(
          'schemaVersion', 'goat.chat.debug.v1',
          'taskNotification', jsonb_build_object(
            'taskId', origin.task_id,
            'taskDisplayId', origin.display_id,
            'taskName', origin.name,
            'status', 'failed'
          ),
          'error', ${input.error}
        ),
        ${now},
        ${now}
      FROM origin_chat AS origin
      CROSS JOIN failed_task AS task
      WHERE NOT EXISTS (
        SELECT 1
        FROM goat.chat_messages AS existing
        WHERE existing.session_id = origin.session_id
          AND existing.debug_trace->'taskNotification'->>'taskId' = task.id
      )
      RETURNING session_id
    )
    UPDATE goat.chat_sessions AS session
    SET updated_at = ${now}
    FROM inserted_notification AS notification
    WHERE session.id = notification.session_id
  `);
}

async function loadGoatUser(userWorkosId: string) {
  const result = await getRunnerDb().execute(sql`
    SELECT email, first_name AS "firstName", last_name AS "lastName", timezone
    FROM goat.users
    WHERE workos_user_id = ${userWorkosId}
    LIMIT 1
  `);
  return rowsFromExecute<{
    email: string;
    firstName: string | null;
    lastName: string | null;
    timezone: string;
  }>(result)[0];
}

function readToolCallId(executionContext: unknown): string | null {
  if (
    executionContext &&
    typeof executionContext === "object" &&
    "toolCallId" in executionContext &&
    typeof executionContext.toolCallId === "string"
  ) {
    return executionContext.toolCallId;
  }
  return null;
}

function readUsageNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requireLease(value: string | null, taskId: string, field: string) {
  if (!value) throw new Error(`Claimed Goat task ${taskId} is missing ${field}.`);
  return value;
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

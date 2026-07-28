import type {
  GoatHarnessSpec,
  GoatTaskReportedOutcome,
  GoatTaskToolName,
  goatTasks,
} from "@opencompany/db/goat-schema";
import { getDefaultGoatBrainForUser, getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { resolveGoatActionCatalog } from "@opencompany/goat-agent/actions/catalog";
import { executeGoatAction } from "@opencompany/goat-agent/actions/execute";
import type { GoatResolvedActionCatalog } from "@opencompany/goat-agent/actions/types";
import {
  createOpenCompanyChatToolContext,
  type GoatTaskReportedStatus,
  prepareOpenCompanyChatStep,
} from "@opencompany/goat-agent/chat-agent";
import type {
  GoatChatActionCatalog,
  WebFetchToolOutput,
  WebSearchToolOutput,
} from "@opencompany/goat-agent/chat-ui";
import { executeGoatChatExaFetch } from "@opencompany/goat-agent/chat-web-fetch";
import { executeGoatChatExaSearch } from "@opencompany/goat-agent/chat-web-search";
import { createOpenCompanyChatSystemPrompt } from "@opencompany/goat-agent/prompts";
import {
  createGoatGatewayAttribution,
  GOAT_SPANS,
  goatGatewayProviderOptions,
  hashGoatUserId,
  recordGoatModelUsageTokens,
  withGoatSpan,
} from "@opencompany/goat-observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import * as ai from "ai";
import { createGateway, type LanguageModelUsage } from "ai";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { runGoatTaskBrainRead } from "./goat-codex-brain-tool";
import type { GoatTaskRunSink } from "./goat-harness";

type GoatTask = typeof goatTasks.$inferSelect;

const ASSISTANT_CONTENT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_TASK_MAX_MODEL_STEPS = 16;
const TASK_WEB_SEARCH_CALLS_PER_TURN = 20;
const TASK_WEB_FETCH_CALLS_PER_TURN = 20;
const TASK_ACTION_CALLS_PER_TURN = 20;

const TASK_SYSTEM_BLOCK = [
  "<background_task_run>",
  "You are running as an autonomous background task. There is no interactive user to answer questions or approve steps — work to completion with the tools available.",
  'When you have finished, call update_task_status exactly once to report the outcome ("done" or "needs_attention"), then write your final result as your last message.',
  "</background_task_run>",
].join("\n");

export type GoatTaskChatLoopResult = {
  assistantContent: string;
  usage?: LanguageModelUsage;
  reportedOutcome?: GoatTaskReportedOutcome;
  outcomeComment?: string;
};

// The opencompany-engine task executor: a hidden main-chat run. Builds the same
// system prompt + tool context as interactive chat (brain read, web search/fetch,
// integration actions) plus the task-only update_task_status tool, streams the
// model turn, and writes the transcript + tool events + model usage through the
// existing task sink so the live task UI is unchanged.
export async function runGoatTaskChatLoop(input: {
  env: RunnerEnv;
  task: GoatTask;
  harnessSpec: GoatHarnessSpec;
  signal: AbortSignal;
  sink: GoatTaskRunSink;
  assistantMessageId: string;
}): Promise<GoatTaskChatLoopResult> {
  const userIdHash = hashGoatUserId(input.task.userWorkosId);
  return withGoatSpan(
    GOAT_SPANS.taskModelStream,
    {
      ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
      "goat.model": input.harnessSpec.model,
    },
    () => runGoatTaskChatLoopInner(input),
  );
}

async function runGoatTaskChatLoopInner(input: {
  env: RunnerEnv;
  task: GoatTask;
  harnessSpec: GoatHarnessSpec;
  signal: AbortSignal;
  sink: GoatTaskRunSink;
  assistantMessageId: string;
}): Promise<GoatTaskChatLoopResult> {
  const { env, task, harnessSpec } = input;
  const db = getDb();
  const gatewayApiKey = env.vercelAiGatewayApiKey;
  const exaApiKey = env.exaApiKey?.trim();
  const currentDate = new Date();
  const userMessage = harnessSpec.initialUserMessage?.trim() || task.prompt;

  // Resolve the run's brain: a workflow task targets its authoring brain; an
  // ad-hoc task uses the user's default brain. Also gives us the workspace id
  // that github/stripe action resolvers need.
  const brain = task.workflowBrainRef
    ? ((
        await getGoatBrainAccess(
          { userWorkosId: task.userWorkosId, brainRef: task.workflowBrainRef },
          { db },
        )
      )?.brain ?? null)
    : await getDefaultGoatBrainForUser(task.userWorkosId, { db });
  const workspaceId = brain?.workspaceId ?? "";

  // Same integration action catalog as chat, minus managed capabilities (no
  // resolver injected) and minus approval-mode actions (a headless run can't
  // pause for the in-chat approval UI). Mirrors the Slack bot's filtering.
  let onCatalog: GoatResolvedActionCatalog = { providers: [], actions: [] };
  if (workspaceId) {
    const resolved = await resolveGoatActionCatalog({
      userWorkosId: task.userWorkosId,
      workspaceId,
    }).catch(() => ({ providers: [], actions: [] }) as GoatResolvedActionCatalog);
    const onActions = resolved.actions.filter((action) => action.permissionMode === "on");
    const onSourceIds = new Set(onActions.map((action) => action.provider));
    onCatalog = {
      providers: resolved.providers.filter(
        (source) => source.kind !== "managed" && onSourceIds.has(source.id),
      ),
      actions: onActions,
    };
  }
  const dispatcherCatalog: GoatChatActionCatalog = {
    sources: onCatalog.providers.map((source) => ({
      ...source,
      kind: source.kind ?? "integration",
    })),
    actions: onCatalog.actions.map((action) => ({
      id: action.id,
      source: action.provider,
      description: action.description,
      params: action.params,
      permissionMode: action.permissionMode,
    })),
  };

  let reportedOutcome: GoatTaskReportedOutcome | undefined;
  let outcomeComment: string | undefined;

  const toolContext = createOpenCompanyChatToolContext({
    model: harnessSpec.model,
    latestUserMessage: userMessage,
    limits: {
      webSearchCallsPerTurn: TASK_WEB_SEARCH_CALLS_PER_TURN,
      webFetchCallsPerTurn: TASK_WEB_FETCH_CALLS_PER_TURN,
      actionCallsPerTurn: TASK_ACTION_CALLS_PER_TURN,
    },
    ...(brain
      ? {
          runBrainCli: (toolInput) =>
            runGoatTaskBrainRead({
              brainRef: brain.id,
              userWorkosId: task.userWorkosId,
              chatSessionId: `goat-task:${task.id}`,
              gatewayApiKey,
              toolInput,
              db,
            }),
        }
      : {}),
    ...(exaApiKey
      ? {
          webSearch: async (toolInput): Promise<WebSearchToolOutput> => {
            try {
              return await executeGoatChatExaSearch({
                toolInput,
                apiKey: exaApiKey,
                signal: input.signal,
                currentDate,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : "Web search failed.",
              };
            }
          },
          webFetch: async (toolInput): Promise<WebFetchToolOutput> => {
            try {
              return await executeGoatChatExaFetch({
                toolInput,
                apiKey: exaApiKey,
                signal: input.signal,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : "Web fetch failed.",
              };
            }
          },
        }
      : {}),
    ...(dispatcherCatalog.actions.length > 0
      ? {
          actions: {
            catalog: dispatcherCatalog,
            execute: (call) =>
              executeGoatAction({
                catalog: onCatalog,
                actionId: call.action,
                params: call.params,
                userWorkosId: task.userWorkosId,
                ...(workspaceId ? { workspaceId } : {}),
                toolCallId: call.toolCallId,
                signal: input.signal,
                currentDate,
                userTimezone: "UTC",
              }),
          },
        }
      : {}),
    updateTaskStatus: async ({ status, comment }) => {
      reportedOutcome = status satisfies GoatTaskReportedStatus as GoatTaskReportedOutcome;
      outcomeComment = comment;
    },
  });

  const system = [
    createOpenCompanyChatSystemPrompt({
      currentDate,
      webFetchEnabled: Boolean(exaApiKey),
      webSearchEnabled: Boolean(exaApiKey),
      taskToolsEnabled: false,
      scheduleToolsEnabled: false,
      brainCaptureEnabled: false,
      activeBrain: brain ? { name: brain.name, workspaceName: brain.name, readOnly: true } : null,
      ...(dispatcherCatalog.sources.length > 0
        ? {
            actionSources: dispatcherCatalog.sources,
            connectedIntegrations: dispatcherCatalog.sources.filter(
              (source) => source.kind !== "managed",
            ),
          }
        : {}),
    }),
    TASK_SYSTEM_BLOCK,
    ...(harnessSpec.systemBlocks ?? []),
  ].join("\n\n");

  const maxSteps =
    typeof harnessSpec.maxModelSteps === "number" && harnessSpec.maxModelSteps > 0
      ? harnessSpec.maxModelSteps
      : DEFAULT_TASK_MAX_MODEL_STEPS;

  const gateway = createGateway({ apiKey: gatewayApiKey });
  const { streamText } = getBraintrustAISDK(ai);
  const attribution = createGoatGatewayAttribution({
    userWorkosId: task.userWorkosId,
    feature: "task",
    taskId: task.id,
  });

  const toolMessagesByCallId = new Map<string, string>();
  let assistantContent = "";
  let usage: LanguageModelUsage | undefined;
  let lastFlushAt = 0;
  let stepIndex = 0;

  const flushContent = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlushAt < ASSISTANT_CONTENT_FLUSH_INTERVAL_MS) return;
    lastFlushAt = now;
    await input.sink.updateMessageContent({
      messageId: input.assistantMessageId,
      content: assistantContent,
    });
  };

  const stream = streamText({
    model: gateway(harnessSpec.model),
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: toolContext.tools,
    stopWhen: [ai.stepCountIs(maxSteps)],
    prepareStep: ({ stepNumber }) => prepareOpenCompanyChatStep({ stepNumber, maxSteps }),
    ...(toolContext.repairToolCall
      ? { experimental_repairToolCall: toolContext.repairToolCall }
      : {}),
    abortSignal: input.signal,
    providerOptions: goatGatewayProviderOptions(attribution),
  });

  for await (const part of stream.fullStream) {
    if (input.signal.aborted) throw new Error("Goat task was aborted.");
    if (part.type === "text-delta") {
      assistantContent += part.text;
      await flushContent(false);
    } else if (part.type === "tool-call") {
      const toolName = part.toolName as GoatTaskToolName;
      const message = await input.sink.createToolMessage({
        toolCallId: part.toolCallId,
        toolName,
        input: part.input,
      });
      toolMessagesByCallId.set(part.toolCallId, message.id);
      await input.sink.appendEvent({
        type: "tool.started",
        messageId: message.id,
        payload: { toolCallId: part.toolCallId, toolName, input: part.input },
      });
    } else if (part.type === "tool-result") {
      const messageId = toolMessagesByCallId.get(part.toolCallId);
      const toolName = part.toolName as GoatTaskToolName;
      if (messageId) {
        await input.sink.completeToolMessage({
          messageId,
          toolCallId: part.toolCallId,
          toolName,
          input: part.input,
          output: part.output,
        });
      }
      await input.sink.appendEvent({
        type: "tool.completed",
        messageId: messageId ?? null,
        payload: {
          toolCallId: part.toolCallId,
          toolName,
          input: part.input,
          output: part.output,
        },
      });
    } else if (part.type === "tool-error") {
      const messageId = toolMessagesByCallId.get(part.toolCallId);
      const toolName = part.toolName as GoatTaskToolName;
      const errorText = part.error instanceof Error ? part.error.message : String(part.error);
      if (messageId) {
        await input.sink.failToolMessage({
          messageId,
          toolCallId: part.toolCallId,
          toolName,
          input: part.input,
          error: errorText,
        });
      }
      await input.sink.appendEvent({
        type: "tool.failed",
        messageId: messageId ?? null,
        payload: { toolCallId: part.toolCallId, toolName, input: part.input, error: errorText },
      });
    } else if (part.type === "finish-step") {
      const finishPart = part as {
        usage?: LanguageModelUsage;
        response?: { id?: string | null; modelId?: string | null; timestamp?: Date | null };
        finishReason?: string | null;
        rawFinishReason?: string | null;
      };
      usage = finishPart.usage;
      if (finishPart.usage) {
        await input.sink.recordModelUsage({
          messageId: input.assistantMessageId,
          phase: "execution",
          stepIndex,
          modelProvider: "vercel-ai-gateway",
          modelName: harnessSpec.model,
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
  await flushContent(true);
  recordUsageMetrics(usage, { "goat.model": harnessSpec.model });

  return {
    assistantContent,
    ...(usage ? { usage } : {}),
    ...(reportedOutcome ? { reportedOutcome } : {}),
    ...(outcomeComment ? { outcomeComment } : {}),
  };
}

function recordUsageMetrics(
  usage: LanguageModelUsage | undefined,
  attributes: Record<string, string | number>,
) {
  if (!usage) return;
  const inputTokens = readUsageNumber(usage, "inputTokens");
  const outputTokens = readUsageNumber(usage, "outputTokens");
  const totalTokens = readUsageNumber(usage, "totalTokens");
  if (inputTokens)
    recordGoatModelUsageTokens({ tokens: inputTokens, direction: "input", attributes });
  if (outputTokens)
    recordGoatModelUsageTokens({ tokens: outputTokens, direction: "output", attributes });
  if (totalTokens)
    recordGoatModelUsageTokens({ tokens: totalTokens, direction: "total", attributes });
}

function readUsageNumber(usage: LanguageModelUsage, key: keyof LanguageModelUsage) {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

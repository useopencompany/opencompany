import type {
  GoatHarnessSpec,
  GoatTaskDebugTrace,
  GoatTaskEventType,
  GoatTaskToolName,
  goatTasks,
} from "@opencompany/db/goat-schema";
import {
  GOAT_SPANS,
  hashGoatUserId,
  recordGoatModelUsageTokens,
  withGoatSpan,
} from "@opencompany/goat-observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import * as ai from "ai";
import { createGateway, jsonSchema, type LanguageModelUsage } from "ai";
import type { RunnerEnv } from "./env";
import {
  buildGoatTaskToolRuntime,
  type GoatToolLifecycleInput,
  normalizeGoatTaskToolNames,
} from "./goat-tools";
import type { HostedToolUsage } from "./hosted-tools";
import {
  buildGoatHarnessCreationPrompt,
  GOAT_HARNESS_CREATION_SYSTEM_PROMPT,
  GOAT_HARNESS_MODEL_OPTIONS,
} from "./prompts/goat-harness-creation";

const GOAT_PLANNER_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_GOAT_MAX_MODEL_STEPS = 8;
const MAX_GOAT_MODEL_STEPS = 16;
const ASSISTANT_CONTENT_FLUSH_INTERVAL_MS = 500;

type GoatTask = typeof goatTasks.$inferSelect;

export type GoatTaskRunSink = {
  createAssistantMessage(input: {
    content: string;
    modelMessage?: unknown;
  }): Promise<{ id: string }>;
  updateMessageContent(input: { messageId: string; content: string }): Promise<void>;
  completeMessage(input: {
    messageId: string;
    content: string;
    modelMessage?: unknown;
  }): Promise<void>;
  failMessage(input: { messageId: string; content?: string; error: string }): Promise<void>;
  createToolMessage(input: {
    toolCallId: string;
    toolName: GoatTaskToolName;
    input: unknown;
  }): Promise<{ id: string }>;
  completeToolMessage(input: {
    messageId: string;
    toolCallId: string;
    toolName: GoatTaskToolName;
    input: unknown;
    output: unknown;
  }): Promise<void>;
  failToolMessage(input: {
    messageId: string;
    toolCallId: string;
    toolName: GoatTaskToolName;
    input: unknown;
    error: string;
  }): Promise<void>;
  appendEvent(input: {
    type: GoatTaskEventType;
    payload?: Record<string, unknown>;
    messageId?: string | null;
  }): Promise<void>;
  recordModelUsage(input: {
    messageId?: string | null;
    phase: "planner" | "execution";
    stepIndex: number;
    modelProvider: string;
    modelName: string;
    usage: LanguageModelUsage;
    responseId?: string | null;
    responseModelId?: string | null;
    finishReason?: string | null;
    rawFinishReason?: string | null;
    providerCreatedAt?: Date | null;
  }): Promise<void>;
  recordToolUsage(input: {
    messageId?: string | null;
    toolCallId: string;
    toolName: GoatTaskToolName;
    usage: HostedToolUsage;
  }): Promise<void>;
  recordSandboxUsage(input: {
    messageId?: string | null;
    sandboxId: string;
    template: string | null;
    vcpu: number | null;
    ramMib: number | null;
    startedAt: Date;
    endedAt: Date;
    activeMs: number;
    rawMetrics?: Record<string, unknown>;
  }): Promise<void>;
};

export type GoatTaskExecutorInput = {
  task: GoatTask;
  env: RunnerEnv;
  signal: AbortSignal;
  sink: GoatTaskRunSink;
  reportStage: (
    stage: GoatTask["stage"],
    patch?: Partial<Pick<GoatTask, "harnessSpec" | "debugTrace">>,
  ) => Promise<void>;
};

export type GoatTaskExecutorResult = {
  result: string;
  harnessSpec: GoatHarnessSpec;
  debugTrace: GoatTaskDebugTrace;
};

export async function executeGoatTask(
  input: GoatTaskExecutorInput,
): Promise<GoatTaskExecutorResult> {
  await input.reportStage("planning");
  await input.sink.appendEvent({
    type: "task.status",
    payload: { status: "running", stage: "planning" },
  });

  const planned = await planGoatHarnessForTask({
    prompt: input.task.prompt,
    model: input.task.model,
    availableTools: normalizeGoatTaskToolNames(input.task.harnessSpec.tools),
    gatewayApiKey: input.env.vercelAiGatewayApiKey,
    signal: input.signal,
  });
  const harnessSpec = planned.harnessSpec;
  if (planned.usage) {
    await input.sink.recordModelUsage({
      phase: "planner",
      stepIndex: 0,
      modelProvider: "vercel-ai-gateway",
      modelName: GOAT_PLANNER_MODEL,
      usage: planned.usage,
    });
  }

  await input.reportStage("running", { harnessSpec, debugTrace: planned.debugTrace });
  await input.sink.appendEvent({
    type: "harness.planned",
    payload: {
      schemaVersion: harnessSpec.schemaVersion,
      model: harnessSpec.model,
      tools: harnessSpec.tools,
      maxModelSteps: harnessSpec.maxModelSteps,
      resultMode: harnessSpec.resultMode,
    },
  });
  await input.sink.appendEvent({
    type: "task.status",
    payload: { status: "running", stage: "running" },
  });
  assertNotAborted(input.signal);

  const assistant = await input.sink.createAssistantMessage({
    content: "",
    modelMessage: { role: "assistant", content: "" },
  });
  await input.sink.appendEvent({
    type: "message.created",
    messageId: assistant.id,
    payload: { role: "assistant", status: "running" },
  });

  try {
    const result = await runGoatTaskModelStream({
      env: input.env,
      userWorkosId: input.task.userWorkosId,
      harnessSpec,
      signal: input.signal,
      sink: input.sink,
      assistantMessageId: assistant.id,
    });

    const finalContent = result.assistantContent.trim();
    if (!finalContent) {
      throw new GoatHarnessRunError(
        "Goat task completed without a final assistant message.",
        planned.debugTrace,
      );
    }

    await input.sink.completeMessage({
      messageId: assistant.id,
      content: finalContent,
      modelMessage: { role: "assistant", content: finalContent },
    });
    await input.sink.appendEvent({
      type: "message.completed",
      messageId: assistant.id,
      payload: {
        role: "assistant",
        usage: result.usage,
      },
    });

    return {
      result: finalContent,
      harnessSpec,
      debugTrace: planned.debugTrace,
    };
  } catch (error) {
    await input.sink.failMessage({
      messageId: assistant.id,
      error: errorMessage(error),
    });
    await input.sink.appendEvent({
      type: "message.failed",
      messageId: assistant.id,
      payload: { role: "assistant", error: errorMessage(error) },
    });
    throw error;
  }
}

async function runGoatTaskModelStream(input: {
  env: RunnerEnv;
  userWorkosId: string;
  harnessSpec: GoatHarnessSpec;
  signal: AbortSignal;
  sink: GoatTaskRunSink;
  assistantMessageId: string;
}): Promise<{ assistantContent: string; usage?: LanguageModelUsage }> {
  return withGoatSpan(
    GOAT_SPANS.taskModelStream,
    {
      ...(hashGoatUserId(input.userWorkosId)
        ? { "goat.user_id_hash": hashGoatUserId(input.userWorkosId) }
        : {}),
      "goat.model": input.harnessSpec.model,
    },
    async () => runGoatTaskModelStreamInner(input),
  );
}

async function runGoatTaskModelStreamInner(input: {
  env: RunnerEnv;
  userWorkosId: string;
  harnessSpec: GoatHarnessSpec;
  signal: AbortSignal;
  sink: GoatTaskRunSink;
  assistantMessageId: string;
}): Promise<{ assistantContent: string; usage?: LanguageModelUsage }> {
  const gateway = createGateway({ apiKey: input.env.vercelAiGatewayApiKey });
  const { streamText } = getBraintrustAISDK(ai);
  const toolMessagesByCallId = new Map<string, string>();
  const toolRuntime = buildGoatTaskToolRuntime({
    selectedTools: input.harnessSpec.tools,
    userWorkosId: input.userWorkosId,
    env: input.env,
    signal: input.signal,
    recordSandboxUsage: (usageInput) =>
      input.sink.recordSandboxUsage({
        messageId: usageInput.messageId ?? input.assistantMessageId,
        sandboxId: usageInput.sandboxId,
        template: usageInput.template,
        vcpu: usageInput.vcpu,
        ramMib: usageInput.ramMib,
        startedAt: usageInput.startedAt,
        endedAt: usageInput.endedAt,
        activeMs: usageInput.activeMs,
        ...(usageInput.rawMetrics ? { rawMetrics: usageInput.rawMetrics } : {}),
      }),
    lifecycle: {
      onToolStarted: async (event) => {
        const message = await input.sink.createToolMessage(event);
        toolMessagesByCallId.set(event.toolCallId, message.id);
        await input.sink.appendEvent({
          type: "tool.started",
          messageId: message.id,
          payload: toolEventPayload(event),
        });
        return { messageId: message.id };
      },
      onToolCompleted: async (event) => {
        const messageId = event.messageId ?? toolMessagesByCallId.get(event.toolCallId);
        if (messageId) {
          await input.sink.completeToolMessage({ ...event, messageId });
        }
        if (event.usage) {
          await input.sink.recordToolUsage({
            messageId: messageId ?? null,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            usage: event.usage,
          });
        }
        await input.sink.appendEvent({
          type: "tool.completed",
          messageId: messageId ?? null,
          payload: {
            ...toolEventPayload(event),
            output: event.output,
          },
        });
      },
      onToolFailed: async (event) => {
        const messageId = event.messageId ?? toolMessagesByCallId.get(event.toolCallId);
        if (messageId) {
          await input.sink.failToolMessage({ ...event, messageId });
        }
        await input.sink.appendEvent({
          type: "tool.failed",
          messageId: messageId ?? null,
          payload: {
            ...toolEventPayload(event),
            error: event.error,
          },
        });
      },
    },
  });
  const tools = toolRuntime.tools;

  try {
    const stream = streamText({
      model: gateway(input.harnessSpec.model),
      system: input.harnessSpec.systemPrompt,
      messages: [{ role: "user", content: input.harnessSpec.initialUserMessage }],
      tools,
      stopWhen: [ai.stepCountIs(input.harnessSpec.maxModelSteps)],
      abortSignal: input.signal,
    });

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

    for await (const part of stream.fullStream) {
      assertNotAborted(input.signal);
      if (part.type === "text-delta") {
        assistantContent += part.text;
        await flushContent(false);
      } else if (part.type === "finish-step") {
        const finishPart = part as {
          usage?: LanguageModelUsage;
          response?: {
            id?: string | null;
            modelId?: string | null;
            timestamp?: Date | null;
          };
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
            modelName: input.harnessSpec.model,
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
    recordUsageMetrics(usage, { "goat.model": input.harnessSpec.model });

    return { assistantContent, ...(usage ? { usage } : {}) };
  } finally {
    await toolRuntime.cleanup();
  }
}

export async function planGoatHarness(input: {
  prompt: string;
  model: GoatHarnessSpec["model"];
  gatewayApiKey: string;
  availableTools?: readonly GoatTaskToolName[];
  signal?: AbortSignal;
}): Promise<GoatHarnessSpec> {
  return (
    await planGoatHarnessForTask({
      ...input,
      availableTools: input.availableTools ?? ["exa_search"],
    })
  ).harnessSpec;
}

async function planGoatHarnessForTask(input: {
  prompt: string;
  model: GoatHarnessSpec["model"];
  gatewayApiKey: string;
  availableTools: readonly GoatTaskToolName[];
  signal?: AbortSignal;
}): Promise<{
  harnessSpec: GoatHarnessSpec;
  debugTrace: GoatTaskDebugTrace;
  usage?: LanguageModelUsage;
}> {
  const availableTools = normalizeGoatTaskToolNames(input.availableTools);
  const availableModels = GOAT_HARNESS_MODEL_OPTIONS.map((option) => option.id);
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const { generateObject } = getBraintrustAISDK(ai);
  const schema = goatHarnessSpecResponseSchema(availableTools, availableModels);
  const systemPrompt = GOAT_HARNESS_CREATION_SYSTEM_PROMPT;
  const userPrompt = buildGoatHarnessCreationPrompt({
    taskPrompt: input.prompt,
    executionModelOptions: GOAT_HARNESS_MODEL_OPTIONS,
    availableOperationTools: availableTools,
    defaultMaxModelSteps: DEFAULT_GOAT_MAX_MODEL_STEPS,
  });

  const result = await withGoatSpan(
    GOAT_SPANS.taskPlan,
    {
      "goat.model": input.model,
      "goat.planner_model": GOAT_PLANNER_MODEL,
      "goat.queued_model": input.model,
      "goat.tool_count": availableTools.length,
    },
    () =>
      generateObject({
        model: gateway(GOAT_PLANNER_MODEL),
        schema: jsonSchema(schema as never),
        system: systemPrompt,
        prompt: userPrompt,
        ...(input.signal ? { abortSignal: input.signal } : {}),
      }),
  );
  const harnessSpec = normalizeHarnessSpec(result.object, input, availableTools, availableModels);

  return {
    harnessSpec,
    debugTrace: {
      schemaVersion: "goat.debug.v1",
      planner: {
        model: GOAT_PLANNER_MODEL,
        request: {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          responseFormat: schema,
        },
        response: {
          content: JSON.stringify(harnessSpec),
        },
      },
    },
    ...(isLanguageModelUsage((result as { usage?: unknown }).usage)
      ? { usage: (result as { usage: LanguageModelUsage }).usage }
      : {}),
  };
}

function goatHarnessSpecResponseSchema(
  availableTools: readonly GoatTaskToolName[],
  availableModels: readonly GoatHarnessSpec["model"][],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { type: "string", enum: ["goat.harness.v1"] },
      model: { type: "string", enum: availableModels },
      systemPrompt: { type: "string", minLength: 1 },
      initialUserMessage: { type: "string", minLength: 1 },
      tools: {
        type: "array",
        items: { type: "string", enum: availableTools },
        minItems: 1,
        maxItems: availableTools.length,
      },
      maxModelSteps: { type: "integer", minimum: 1, maximum: MAX_GOAT_MODEL_STEPS },
      resultMode: { type: "string", enum: ["assistant_final"] },
    },
    required: [
      "schemaVersion",
      "model",
      "systemPrompt",
      "initialUserMessage",
      "tools",
      "maxModelSteps",
      "resultMode",
    ],
  } as const;
}

function normalizeHarnessSpec(
  value: unknown,
  fallback: {
    prompt: string;
  },
  availableTools: readonly GoatTaskToolName[],
  availableModels: readonly GoatHarnessSpec["model"][],
): GoatHarnessSpec {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const model = readHarnessModel(record.model, availableModels);
  if (!model) {
    throw new Error("Goat harness planner must choose a supported execution model.");
  }
  const systemPrompt = readNonEmptyString(record.systemPrompt);
  if (!systemPrompt) {
    throw new Error("Goat harness planner must return a non-empty systemPrompt.");
  }
  const initialUserMessage = readNonEmptyString(record.initialUserMessage) ?? fallback.prompt;
  const selectedTools = normalizeGoatTaskToolNames(record.tools).filter((toolName) =>
    availableTools.includes(toolName),
  );
  const maxModelSteps =
    typeof record.maxModelSteps === "number" && Number.isFinite(record.maxModelSteps)
      ? clampInteger(record.maxModelSteps, 1, MAX_GOAT_MODEL_STEPS)
      : DEFAULT_GOAT_MAX_MODEL_STEPS;

  return {
    schemaVersion: "goat.harness.v1",
    model,
    systemPrompt,
    initialUserMessage,
    tools: selectedTools.length > 0 ? selectedTools : normalizeGoatTaskToolNames(availableTools),
    maxModelSteps,
    resultMode: "assistant_final",
  };
}

function readHarnessModel(
  value: unknown,
  availableModels: readonly GoatHarnessSpec["model"][],
): GoatHarnessSpec["model"] | null {
  const model = readNonEmptyString(value);
  return model && availableModels.includes(model as GoatHarnessSpec["model"])
    ? (model as GoatHarnessSpec["model"])
    : null;
}

function toolEventPayload(event: GoatToolLifecycleInput) {
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
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
  if (inputTokens) {
    recordGoatModelUsageTokens({ tokens: inputTokens, direction: "input", attributes });
  }
  if (outputTokens) {
    recordGoatModelUsageTokens({ tokens: outputTokens, direction: "output", attributes });
  }
  if (totalTokens) {
    recordGoatModelUsageTokens({ tokens: totalTokens, direction: "total", attributes });
  }
}

function readUsageNumber(usage: LanguageModelUsage, key: keyof LanguageModelUsage) {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isLanguageModelUsage(value: unknown): value is LanguageModelUsage {
  return Boolean(value && typeof value === "object");
}

export class GoatHarnessRunError extends Error {
  debugTrace: GoatTaskDebugTrace;

  constructor(message: string, debugTrace: GoatTaskDebugTrace) {
    super(message);
    this.name = "GoatHarnessRunError";
    this.debugTrace = debugTrace;
  }
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Goat task was aborted.");
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Goat task error.";
}

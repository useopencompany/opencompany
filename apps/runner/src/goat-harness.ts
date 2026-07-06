import type {
  GoatHarnessSpec,
  GoatTaskDebugTrace,
  GoatTaskEventType,
  GoatTaskSkillId,
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
  createGoatBrainMarkdownReportForTask,
  type GoatBrainMarkdownReportArtifact,
} from "./goat-brain";
import { runGoatCodexTask } from "./goat-codex";
import {
  buildGoatTaskToolRuntime,
  type GoatToolLifecycleInput,
  normalizeGoatTaskToolNames,
} from "./goat-tools";
import type { HostedToolUsage } from "./hosted-tools";
import {
  buildGoatHarnessCreationPrompt,
  buildGoatHarnessSkillSystemPrompt,
  GOAT_HARNESS_CREATION_SYSTEM_PROMPT,
  GOAT_HARNESS_ENGINE_OPTIONS,
  GOAT_HARNESS_MODEL_OPTIONS,
  GOAT_HARNESS_SKILL_OPTIONS,
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
    costOverride?: {
      providerCostUsdMicros: number;
      platformFeeUsdMicros: number;
      totalCostUsdMicros: number;
      costBasis: Record<string, unknown>;
    };
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
  updateCodexEngineSessionId(codexEngineSessionId: string): Promise<void>;
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
  artifact?: GoatBrainMarkdownReportArtifact;
};

export async function executeGoatTask(
  input: GoatTaskExecutorInput,
): Promise<GoatTaskExecutorResult> {
  await input.reportStage("planning");
  await input.sink.appendEvent({
    type: "task.status",
    payload: { status: "running", stage: "planning" },
  });

  const planned =
    input.task.scheduleId && hasPreplannedHarnessSpec(input.task.harnessSpec)
      ? {
          harnessSpec: input.task.harnessSpec,
          debugTrace:
            Object.keys(input.task.debugTrace).length > 0
              ? input.task.debugTrace
              : ({ schemaVersion: "goat.debug.v1" } satisfies GoatTaskDebugTrace),
          usage: undefined,
        }
      : await planGoatHarnessForTask({
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
      engine: harnessSpec.engine,
      model: harnessSpec.model,
      tools: harnessSpec.tools,
      skills: harnessSpec.skills,
      maxModelSteps: harnessSpec.maxModelSteps,
      resultMode: harnessSpec.resultMode,
      codex: harnessSpec.codex ?? null,
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
    const result =
      harnessSpec.engine === "codex"
        ? await runGoatTaskCodex({
            taskId: input.task.id,
            prompt: input.task.prompt,
            env: input.env,
            userWorkosId: input.task.userWorkosId,
            existingEngineSessionId: input.task.codexEngineSessionId,
            harnessSpec,
            signal: input.signal,
            sink: input.sink,
            assistantMessageId: assistant.id,
          })
        : await runGoatTaskModelStream({
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

    const artifact =
      harnessSpec.resultMode === "brain_markdown_report"
        ? await createGoatBrainMarkdownReportForTask({
            userWorkosId: input.task.userWorkosId,
            taskId: input.task.id,
            title: input.task.name,
            markdown: finalContent,
          })
        : null;
    const taskResult = artifact ? formatBrainReportResult(artifact) : finalContent;

    await input.sink.completeMessage({
      messageId: assistant.id,
      content: taskResult,
      modelMessage: { role: "assistant", content: taskResult },
    });
    if (artifact) {
      await input.sink.appendEvent({
        type: "artifact.created",
        messageId: assistant.id,
        payload: { artifact },
      });
    }
    await input.sink.appendEvent({
      type: "message.completed",
      messageId: assistant.id,
      payload: {
        role: "assistant",
        usage: result.usage,
      },
    });

    return {
      result: taskResult,
      harnessSpec,
      debugTrace: planned.debugTrace,
      ...(artifact ? { artifact } : {}),
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

async function runGoatTaskCodex(input: {
  taskId: string;
  prompt: string;
  env: RunnerEnv;
  userWorkosId: string;
  existingEngineSessionId: string | null;
  harnessSpec: GoatHarnessSpec;
  signal: AbortSignal;
  sink: GoatTaskRunSink;
  assistantMessageId: string;
}): Promise<{ assistantContent: string; usage?: LanguageModelUsage }> {
  let codexActivity = "";
  const result = await runGoatCodexTask({
    userWorkosId: input.userWorkosId,
    taskId: input.taskId,
    messageId: input.assistantMessageId,
    prompt: input.harnessSpec.initialUserMessage || input.prompt,
    systemPrompt: input.harnessSpec.systemPrompt,
    model: input.harnessSpec.model,
    existingEngineSessionId: input.existingEngineSessionId,
    env: input.env,
    signal: input.signal,
    ...(input.harnessSpec.codex?.repository !== undefined
      ? { repository: input.harnessSpec.codex.repository }
      : {}),
    ...(input.harnessSpec.codex?.createPullRequest !== undefined
      ? { createPullRequest: input.harnessSpec.codex.createPullRequest }
      : {}),
    ...(input.harnessSpec.codex?.reasoningEffort
      ? { reasoningEffort: input.harnessSpec.codex.reasoningEffort }
      : {}),
    onEngineSessionId: input.sink.updateCodexEngineSessionId,
    onOutput: async (delta) => {
      codexActivity = `${codexActivity}${delta}`;
      await input.sink.updateMessageContent({
        messageId: input.assistantMessageId,
        content: codexActivity,
      });
    },
  });

  await input.sink.recordSandboxUsage({
    messageId: input.assistantMessageId,
    sandboxId: result.sandboxId,
    template: input.env.codexE2bTemplate ?? "codex",
    vcpu: null,
    ramMib: null,
    startedAt: result.sandboxStartedAt,
    endedAt: result.sandboxEndedAt,
    activeMs: Math.max(0, result.sandboxEndedAt.getTime() - result.sandboxStartedAt.getTime()),
    rawMetrics: {
      engine: "codex",
      repository: input.harnessSpec.codex?.repository ?? null,
    },
  });
  if (result.usage) {
    await input.sink.recordModelUsage({
      messageId: input.assistantMessageId,
      phase: "execution",
      stepIndex: 0,
      modelProvider: "openai",
      modelName: result.model,
      usage: result.usage,
      finishReason: "stop",
      costOverride: {
        providerCostUsdMicros: 0,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 0,
        costBasis: { source: "codex_subscription" },
      },
    });
  }

  return { assistantContent: result.content, ...(result.usage ? { usage: result.usage } : {}) };
}

function hasPreplannedHarnessSpec(value: GoatHarnessSpec) {
  return (
    value.schemaVersion === "goat.harness.v1" &&
    value.systemPrompt.trim().length > 0 &&
    value.initialUserMessage.trim().length > 0 &&
    value.tools.length > 0
  );
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
  const streamAssistantContent = input.harnessSpec.resultMode === "assistant_final";
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
      if (!streamAssistantContent) return;
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

export async function planGoatHarnessForTask(input: {
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
  const availableEngines = GOAT_HARNESS_ENGINE_OPTIONS.map((option) => option.id);
  const availableModels = GOAT_HARNESS_MODEL_OPTIONS.map((option) => option.id);
  const availableSkills = GOAT_HARNESS_SKILL_OPTIONS.map((option) => option.id);
  const gateway = createGateway({ apiKey: input.gatewayApiKey });
  const { generateObject } = getBraintrustAISDK(ai);
  const schema = goatHarnessSpecResponseSchema(
    availableTools,
    availableEngines,
    availableModels,
    availableSkills,
  );
  const systemPrompt = GOAT_HARNESS_CREATION_SYSTEM_PROMPT;
  const userPrompt = buildGoatHarnessCreationPrompt({
    taskPrompt: input.prompt,
    executionEngineOptions: GOAT_HARNESS_ENGINE_OPTIONS,
    executionModelOptions: GOAT_HARNESS_MODEL_OPTIONS,
    availableOperationTools: availableTools,
    availableSkills: GOAT_HARNESS_SKILL_OPTIONS,
    defaultMaxModelSteps: DEFAULT_GOAT_MAX_MODEL_STEPS,
  });

  const result = await withGoatSpan(
    GOAT_SPANS.taskPlan,
    {
      "goat.model": input.model,
      "goat.planner_model": GOAT_PLANNER_MODEL,
      "goat.queued_model": input.model,
      "goat.tool_count": availableTools.length,
      "goat.skill_count": availableSkills.length,
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
  const harnessSpec = normalizeHarnessSpec(
    result.object,
    input,
    availableTools,
    availableEngines,
    availableModels,
    availableSkills,
  );

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
  availableEngines: readonly GoatHarnessSpec["engine"][],
  availableModels: readonly GoatHarnessSpec["model"][],
  availableSkills: readonly GoatTaskSkillId[],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { type: "string", enum: ["goat.harness.v1"] },
      engine: { type: "string", enum: availableEngines },
      model: { type: "string", enum: availableModels },
      systemPrompt: { type: "string", minLength: 1 },
      initialUserMessage: { type: "string", minLength: 1 },
      tools: {
        type: "array",
        items: { type: "string", enum: availableTools },
        minItems: 1,
        maxItems: availableTools.length,
      },
      skills: {
        type: "array",
        items: { type: "string", enum: availableSkills },
        minItems: 0,
        maxItems: availableSkills.length,
        uniqueItems: true,
      },
      maxModelSteps: { type: "integer", minimum: 1, maximum: MAX_GOAT_MODEL_STEPS },
      resultMode: { type: "string", enum: ["assistant_final", "brain_markdown_report"] },
      codex: {
        type: "object",
        additionalProperties: false,
        properties: {
          repository: { type: ["string", "null"] },
          createPullRequest: { type: "boolean" },
          reasoningEffort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        },
      },
    },
    required: [
      "schemaVersion",
      "engine",
      "model",
      "systemPrompt",
      "initialUserMessage",
      "tools",
      "skills",
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
  availableEngines: readonly GoatHarnessSpec["engine"][],
  availableModels: readonly GoatHarnessSpec["model"][],
  availableSkills: readonly GoatTaskSkillId[],
): GoatHarnessSpec {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const engine = readHarnessEngine(record.engine, availableEngines);
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
  const selectedSkills = normalizeGoatTaskSkillIds(record.skills).filter((skillId) =>
    availableSkills.includes(skillId),
  );
  const maxModelSteps =
    typeof record.maxModelSteps === "number" && Number.isFinite(record.maxModelSteps)
      ? clampInteger(record.maxModelSteps, 1, MAX_GOAT_MODEL_STEPS)
      : DEFAULT_GOAT_MAX_MODEL_STEPS;

  const resultMode =
    record.resultMode === "brain_markdown_report" ? "brain_markdown_report" : "assistant_final";

  return {
    schemaVersion: "goat.harness.v1",
    engine,
    model,
    systemPrompt: augmentSystemPrompt(systemPrompt, resultMode, selectedSkills),
    initialUserMessage,
    tools: selectedTools.length > 0 ? selectedTools : normalizeGoatTaskToolNames(availableTools),
    skills: selectedSkills,
    maxModelSteps,
    resultMode,
    ...(engine === "codex" ? { codex: readCodexHarnessConfig(record.codex) } : {}),
  };
}

function readHarnessEngine(
  value: unknown,
  availableEngines: readonly GoatHarnessSpec["engine"][],
): GoatHarnessSpec["engine"] {
  const engine = readNonEmptyString(value);
  return engine && availableEngines.includes(engine as GoatHarnessSpec["engine"])
    ? (engine as GoatHarnessSpec["engine"])
    : "opencompany";
}

function normalizeGoatTaskSkillIds(value: unknown): GoatTaskSkillId[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((item): item is GoatTaskSkillId =>
    GOAT_HARNESS_SKILL_OPTIONS.some((option) => option.id === item),
  );
  return [...new Set(ids)];
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

function readCodexHarnessConfig(value: unknown): NonNullable<GoatHarnessSpec["codex"]> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    repository: readNonEmptyString(record.repository),
    createPullRequest: record.createPullRequest === true,
    reasoningEffort: readCodexReasoningEffort(record.reasoningEffort),
  };
}

function readCodexReasoningEffort(value: unknown) {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "high";
}

function toolEventPayload(event: GoatToolLifecycleInput) {
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
  };
}

function augmentSystemPrompt(
  systemPrompt: string,
  resultMode: GoatHarnessSpec["resultMode"],
  skillIds: readonly GoatTaskSkillId[],
) {
  const sections = [systemPrompt];
  const skillPrompt = buildGoatHarnessSkillSystemPrompt(skillIds);
  if (skillPrompt) sections.push(skillPrompt);
  if (resultMode === "brain_markdown_report") {
    sections.push(
      [
        "<brain_markdown_report_result_contract>",
        "Finish with only the complete Markdown report body.",
        "Do not include conversational framing, delivery notes, or a separate summary outside the report.",
        "Use a clear H1 title, concise executive summary, sourced findings, uncertainty, and practical next steps when relevant.",
        "The harness will save this final Markdown as a .md file in the user's Brain and return the file link as the task result.",
        "</brain_markdown_report_result_contract>",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function formatBrainReportResult(artifact: GoatBrainMarkdownReportArtifact) {
  return [
    `Research report saved to Brain: [${artifact.title}](${artifact.url}).`,
    "",
    `Artifact: \`${artifact.brainPath}\``,
  ].join("\n");
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

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatHarnessEngine } from "@opencompany/db/goat-schema";
import {
  createGoatGatewayAttribution,
  goatGatewayProviderOptions,
} from "@opencompany/goat-observability";
import { createGateway, generateText, jsonSchema, stepCountIs, type ToolSet, tool } from "ai";
import {
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  normalizeGoatBrainReadToolInput,
} from "@/lib/brain-surface";
import type {
  GoatCapabilityCallDebug,
  GoatCapabilityOperation,
  GoatCapabilitySideEffect,
} from "@/lib/capabilities/types";
import {
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  type DeleteTaskScheduleToolInput,
  type DeleteTaskScheduleToolOutput,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  type EditTaskScheduleToolInput,
  type EditTaskScheduleToolOutput,
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainToolInput,
  type GoatBrainToolOutput,
  SAVE_TO_BRAIN_TOOL_NAME,
  type SaveToBrainToolInput,
  type SaveToBrainToolOutput,
  SCHEDULE_TASK_TOOL_NAME,
  type ScheduleTaskToolInput,
  type ScheduleTaskToolOutput,
  START_TASK_TOOL_NAME,
  type StartTaskToolInput,
  type StartTaskToolOutput,
  USE_CAPABILITY_TOOL_NAME,
  type UseCapabilityToolInput,
  type UseCapabilityToolOutput,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import {
  createOpenCompanyChatSystemPrompt,
  DELETE_TASK_SCHEDULE_TOOL_DESCRIPTION,
  EDIT_TASK_SCHEDULE_TOOL_DESCRIPTION,
  GOAT_BRAIN_TOOL_DESCRIPTION,
  SAVE_TO_BRAIN_ATTACHMENT_IDS_DESCRIPTION,
  SAVE_TO_BRAIN_CONTENT_DESCRIPTION,
  SAVE_TO_BRAIN_INTENT_DESCRIPTION,
  SAVE_TO_BRAIN_TITLE_DESCRIPTION,
  SAVE_TO_BRAIN_TOOL_DESCRIPTION,
  SCHEDULE_TASK_CRON_DESCRIPTION,
  SCHEDULE_TASK_NAME_DESCRIPTION,
  SCHEDULE_TASK_PROMPT_DESCRIPTION,
  SCHEDULE_TASK_SOURCE_DESCRIPTION,
  SCHEDULE_TASK_TIMEZONE_DESCRIPTION,
  SCHEDULE_TASK_TOOL_DESCRIPTION,
  START_TASK_ENGINE_DESCRIPTION,
  START_TASK_NAME_DESCRIPTION,
  START_TASK_PROMPT_DESCRIPTION,
  START_TASK_REASON_DESCRIPTION,
  START_TASK_TOOL_DESCRIPTION,
  TASK_SCHEDULE_IDENTIFIER_DESCRIPTION,
  TASK_SCHEDULE_NAME_LOOKUP_DESCRIPTION,
  USE_CAPABILITY_OPERATION_DESCRIPTION,
  USE_CAPABILITY_REQUEST_DESCRIPTION,
  USE_CAPABILITY_TOOL_DESCRIPTION,
  WEB_SEARCH_QUERY_DESCRIPTION,
  WEB_SEARCH_RECENCY_DAYS_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "@/lib/prompts";

export {
  createOpenCompanyChatSystemPrompt,
  OPENCOMPANY_CHAT_SYSTEM_PROMPT,
} from "@/lib/prompts";

export const OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION = "opencompany.chat.debug.v1";
export const OPENCOMPANY_CHAT_MAX_STEPS = 8;
const GOAT_BRAIN_READ_TOOL_AI_SCHEMA =
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA as unknown as Parameters<typeof jsonSchema>[0];

type OpenCompanyChatAgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StartedTask = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
};

type GenerateTextLike = typeof generateText;
type GoatBrainCliRunner = (
  input: GoatBrainToolInput,
  executionContext?: unknown,
) => Promise<GoatBrainToolOutput>;
type SaveToBrainRunner = (input: SaveToBrainToolInput) => Promise<SaveToBrainToolOutput>;
type WebSearchRunner = (input: WebSearchToolInput) => Promise<WebSearchToolOutput>;
type ScheduleTaskRunner = (input: ScheduleTaskToolInput) => Promise<ScheduleTaskToolOutput>;
type EditTaskScheduleRunner = (
  input: EditTaskScheduleToolInput,
) => Promise<EditTaskScheduleToolOutput>;
type DeleteTaskScheduleRunner = (
  input: DeleteTaskScheduleToolInput,
) => Promise<DeleteTaskScheduleToolOutput>;
type CapabilityDispatcher = {
  // Ids resolved server-side from real connection state; they become the
  // dispatch enum, so a disconnected capability cannot be invoked by guessing.
  list: readonly { id: string; sideEffect: GoatCapabilitySideEffect }[];
  execute: (input: {
    capability: string;
    operation: GoatCapabilityOperation;
    request: string;
    toolCallId: string;
  }) => Promise<UseCapabilityToolOutput>;
};

export const MAX_CAPABILITY_CALLS_PER_TURN = 4;

// Main chat (and the MCP connector) get a read-only brain surface: recall and
// inspect only. Every write path — new content and edits to existing records —
// goes through save_to_brain, which enqueues the durable ingestion/curation
// agent. That agent owns the full CLI write surface (create, rewrite, merge,
// link, move, delete, …) in the runner worker, so the chat tool never needs it.
export type OpenCompanyChatAgentDebugTrace = {
  schemaVersion: typeof OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION;
  model: string;
  aborted?: boolean;
  finishReason?: string;
  uiMessageParts?: unknown[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  durationMs?: number;
  // Token usage from the final generation step. The last step's input+output is the
  // best proxy for how full the model's context window is after the turn, which drives
  // the chat header's context meter.
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  // Worker-side transcripts of use_capability calls, keyed by toolCallId. Kept
  // out of tool outputs so they never enter the model context.
  capabilityCalls?: Array<GoatCapabilityCallDebug & { toolCallId: string }>;
  error?: string;
};

export type OpenCompanyChatAgentResult = {
  content: string;
  task: StartedTask | null;
  debugTrace: OpenCompanyChatAgentDebugTrace;
};

type OpenCompanyChatSystemPromptInput = NonNullable<
  Parameters<typeof createOpenCompanyChatSystemPrompt>[0]
>;

type StartTaskRequest = {
  prompt: string;
  name?: string;
  model: AgentModelId;
  engine?: GoatHarnessEngine;
};

export async function runOpenCompanyChatAgent(input: {
  messages: readonly OpenCompanyChatAgentMessage[];
  model: AgentModelId;
  gatewayApiKey: string;
  startTask: (task: StartTaskRequest) => Promise<StartedTask>;
  requestedEngine?: GoatHarnessEngine;
  scheduleTask?: ScheduleTaskRunner;
  editTaskSchedule?: EditTaskScheduleRunner;
  deleteTaskSchedule?: DeleteTaskScheduleRunner;
  runBrainCli?: GoatBrainCliRunner;
  saveToBrain?: SaveToBrainRunner;
  webSearch?: WebSearchRunner;
  currentDate?: Date | string;
  userContext?: OpenCompanyChatSystemPromptInput["userContext"];
  recurringSchedules?: OpenCompanyChatSystemPromptInput["recurringSchedules"];
  userWorkosId?: string | null;
  chatSessionId?: string | null;
  brainRef?: string | null;
  generateTextImpl?: GenerateTextLike;
}): Promise<OpenCompanyChatAgentResult> {
  const gatewayApiKey = input.gatewayApiKey.trim();
  if (!gatewayApiKey) {
    throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for Goat chat.");
  }

  const generate = input.generateTextImpl ?? generateText;
  const gateway = createGateway({ apiKey: gatewayApiKey });
  const attribution = createGoatGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "chat",
    ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
    ...(input.brainRef ? { brainRef: input.brainRef } : {}),
  });
  const latestUserMessage = latestUserMessageContent(input.messages);
  const toolContext = createOpenCompanyChatToolContext({
    model: input.model,
    startTask: input.startTask,
    ...(latestUserMessage ? { latestUserMessage } : {}),
    ...(input.requestedEngine ? { requestedEngine: input.requestedEngine } : {}),
    ...(input.scheduleTask ? { scheduleTask: input.scheduleTask } : {}),
    ...(input.editTaskSchedule ? { editTaskSchedule: input.editTaskSchedule } : {}),
    ...(input.deleteTaskSchedule ? { deleteTaskSchedule: input.deleteTaskSchedule } : {}),
    ...(input.runBrainCli ? { runBrainCli: input.runBrainCli } : {}),
    ...(input.saveToBrain ? { saveToBrain: input.saveToBrain } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
  });

  const systemPromptInput = {
    webSearchEnabled: Boolean(input.webSearch),
    ...(input.currentDate ? { currentDate: input.currentDate } : {}),
    ...(input.userContext ? { userContext: input.userContext } : {}),
    ...(input.recurringSchedules ? { recurringSchedules: input.recurringSchedules } : {}),
  };

  const result = await generate({
    model: gateway(input.model),
    system: createOpenCompanyChatSystemPrompt(systemPromptInput),
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stopWhen: stepCountIs(OPENCOMPANY_CHAT_MAX_STEPS),
    tools: toolContext.tools,
    providerOptions: goatGatewayProviderOptions(attribution),
  });

  const startedTask = toolContext.getStartedTask();
  const content = normalizeAgentText(result.text, startedTask);
  const finishReason = stringifyFinishReason(result.finishReason);

  return {
    content,
    task: startedTask,
    debugTrace: createOpenCompanyChatDebugTrace({
      model: input.model,
      steps: result.steps,
      ...(finishReason ? { finishReason } : {}),
    }),
  };
}

export function createOpenCompanyChatToolContext(input: {
  model: AgentModelId;
  startTask?: (task: StartTaskRequest) => Promise<StartedTask>;
  requestedEngine?: GoatHarnessEngine;
  latestUserMessage?: string;
  scheduleTask?: ScheduleTaskRunner;
  editTaskSchedule?: EditTaskScheduleRunner;
  deleteTaskSchedule?: DeleteTaskScheduleRunner;
  runBrainCli?: GoatBrainCliRunner;
  saveToBrain?: SaveToBrainRunner;
  webSearch?: WebSearchRunner;
  capabilities?: CapabilityDispatcher;
}) {
  let startedTask: StartedTask | null = null;
  let startTaskInFlight: Promise<StartedTask> | null = null;
  let scheduledTask: ScheduleTaskToolOutput | null = null;
  let scheduleTaskInFlight: Promise<ScheduleTaskToolOutput> | null = null;
  let visibleToolActivity = false;
  let webSearchCallCount = 0;
  let capabilityCallCount = 0;

  const tools: ToolSet = {
    [GOAT_BRAIN_TOOL_NAME]: tool<GoatBrainToolInput, GoatBrainToolOutput>({
      description: GOAT_BRAIN_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<GoatBrainToolInput>(GOAT_BRAIN_READ_TOOL_AI_SCHEMA),
      execute: async (args, executionContext?: unknown) => {
        if (!input.runBrainCli) {
          throw new Error("goat_brain is not configured for this chat.");
        }
        visibleToolActivity = true;
        const normalized = normalizeGoatBrainToolInput(args);
        return executionContext === undefined
          ? input.runBrainCli(normalized)
          : input.runBrainCli(normalized, executionContext);
      },
    }),
  };

  const startTask = input.startTask;
  if (startTask) {
    tools[START_TASK_TOOL_NAME] = tool<StartTaskToolInput, StartTaskToolOutput>({
      description: START_TASK_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<StartTaskToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description: START_TASK_PROMPT_DESCRIPTION,
          },
          name: {
            type: "string",
            description: START_TASK_NAME_DESCRIPTION,
          },
          reason: {
            type: "string",
            description: START_TASK_REASON_DESCRIPTION,
          },
          engine: {
            type: "string",
            enum: ["opencompany", "codex"],
            description: START_TASK_ENGINE_DESCRIPTION,
          },
        },
        required: ["prompt", "name"],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        if (startedTask) return toStartTaskToolOutput(startedTask, "already_started");
        if (startTaskInFlight) {
          startedTask = await startTaskInFlight;
          return toStartTaskToolOutput(startedTask, "already_started");
        }

        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          throw new Error("start_task prompt is required.");
        }
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const reason = typeof args.reason === "string" ? args.reason : "";
        const engine =
          input.requestedEngine ??
          normalizeStartTaskEngine(args.engine) ??
          inferStartTaskEngine(input.latestUserMessage) ??
          inferStartTaskEngine([name, prompt, reason].join("\n"));

        try {
          startTaskInFlight = startTask({
            prompt,
            ...(name ? { name } : {}),
            model: input.model,
            ...(engine ? { engine } : {}),
          });
          startedTask = await startTaskInFlight;
        } finally {
          startTaskInFlight = null;
        }
        return toStartTaskToolOutput(startedTask, "queued");
      },
    });
  }

  const saveToBrain = input.saveToBrain;
  if (saveToBrain) {
    const capturedByKey = new Map<string, SaveToBrainToolOutput>();
    tools[SAVE_TO_BRAIN_TOOL_NAME] = tool<SaveToBrainToolInput, SaveToBrainToolOutput>({
      description: SAVE_TO_BRAIN_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<SaveToBrainToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
            description: SAVE_TO_BRAIN_CONTENT_DESCRIPTION,
          },
          title: {
            type: "string",
            description: SAVE_TO_BRAIN_TITLE_DESCRIPTION,
          },
          intent: {
            type: "string",
            description: SAVE_TO_BRAIN_INTENT_DESCRIPTION,
          },
          attachmentIds: {
            type: "array",
            items: { type: "string" },
            description: SAVE_TO_BRAIN_ATTACHMENT_IDS_DESCRIPTION,
          },
        },
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        const content = typeof args.content === "string" ? args.content.trim() : "";
        const attachmentIds = Array.isArray(args.attachmentIds)
          ? [
              ...new Set(
                args.attachmentIds.filter(
                  (id): id is string => typeof id === "string" && id.trim().length > 0,
                ),
              ),
            ]
          : [];
        if (!content && attachmentIds.length === 0) {
          return { ok: false, error: "save_to_brain needs content or attachmentIds." };
        }
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const intent = typeof args.intent === "string" ? args.intent.trim() : "";

        // Duplicate calls within one turn return the first capture instead of
        // minting another inbox draft / asset copy.
        const key = `${title}\n${content}\n${attachmentIds.join(",")}`;
        const already = capturedByKey.get(key);
        if (already?.ok) return { ...already, status: "already_captured" };

        const output = await saveToBrain({
          ...(content ? { content } : {}),
          ...(title ? { title } : {}),
          ...(intent ? { intent } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
        if (output.ok) capturedByKey.set(key, output);
        return output;
      },
    });
  }

  if (input.scheduleTask) {
    tools[SCHEDULE_TASK_TOOL_NAME] = tool<ScheduleTaskToolInput, ScheduleTaskToolOutput>({
      description: SCHEDULE_TASK_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<ScheduleTaskToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            description: SCHEDULE_TASK_PROMPT_DESCRIPTION,
          },
          name: {
            type: "string",
            description: SCHEDULE_TASK_NAME_DESCRIPTION,
          },
          cron: {
            type: "string",
            description: SCHEDULE_TASK_CRON_DESCRIPTION,
          },
          timezone: {
            type: "string",
            description: SCHEDULE_TASK_TIMEZONE_DESCRIPTION,
          },
          sourceDescription: {
            type: "string",
            description: SCHEDULE_TASK_SOURCE_DESCRIPTION,
          },
          reason: {
            type: "string",
            description: START_TASK_REASON_DESCRIPTION,
          },
        },
        required: ["prompt", "name", "cron"],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        if (scheduledTask) return scheduledTask;
        if (scheduleTaskInFlight) {
          scheduledTask = await scheduleTaskInFlight;
          return scheduledTask;
        }

        scheduleTaskInFlight = input.scheduleTask!(args);
        try {
          scheduledTask = await scheduleTaskInFlight;
          return scheduledTask;
        } finally {
          scheduleTaskInFlight = null;
        }
      },
    });
  }

  if (input.editTaskSchedule) {
    tools[EDIT_TASK_SCHEDULE_TOOL_NAME] = tool<
      EditTaskScheduleToolInput,
      EditTaskScheduleToolOutput
    >({
      description: EDIT_TASK_SCHEDULE_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<EditTaskScheduleToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          scheduleId: {
            type: "string",
            description: TASK_SCHEDULE_IDENTIFIER_DESCRIPTION,
          },
          scheduleName: {
            type: "string",
            description: TASK_SCHEDULE_NAME_LOOKUP_DESCRIPTION,
          },
          name: {
            type: "string",
            description: SCHEDULE_TASK_NAME_DESCRIPTION,
          },
          prompt: {
            type: "string",
            description: SCHEDULE_TASK_PROMPT_DESCRIPTION,
          },
          cron: {
            type: "string",
            description: SCHEDULE_TASK_CRON_DESCRIPTION,
          },
          timezone: {
            type: "string",
            description: SCHEDULE_TASK_TIMEZONE_DESCRIPTION,
          },
          sourceDescription: {
            type: "string",
            description: SCHEDULE_TASK_SOURCE_DESCRIPTION,
          },
          reason: {
            type: "string",
            description: START_TASK_REASON_DESCRIPTION,
          },
        },
        required: [],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        return input.editTaskSchedule!(args);
      },
    });
  }

  if (input.deleteTaskSchedule) {
    tools[DELETE_TASK_SCHEDULE_TOOL_NAME] = tool<
      DeleteTaskScheduleToolInput,
      DeleteTaskScheduleToolOutput
    >({
      description: DELETE_TASK_SCHEDULE_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<DeleteTaskScheduleToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          scheduleId: {
            type: "string",
            description: TASK_SCHEDULE_IDENTIFIER_DESCRIPTION,
          },
          scheduleName: {
            type: "string",
            description: TASK_SCHEDULE_NAME_LOOKUP_DESCRIPTION,
          },
          reason: {
            type: "string",
            description: START_TASK_REASON_DESCRIPTION,
          },
        },
        required: [],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        return input.deleteTaskSchedule!(args);
      },
    });
  }

  const webSearch = input.webSearch;
  if (webSearch) {
    tools[WEB_SEARCH_TOOL_NAME] = tool<WebSearchToolInput, WebSearchToolOutput>({
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<WebSearchToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: WEB_SEARCH_QUERY_DESCRIPTION,
          },
          recencyDays: {
            type: "number",
            enum: [7, 30, 90],
            description: WEB_SEARCH_RECENCY_DAYS_DESCRIPTION,
          },
        },
        required: ["query"],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        if (webSearchCallCount >= 1) {
          return {
            ok: false,
            error:
              "web_search is limited to one search per chat turn. Start a task for deeper research.",
          };
        }
        webSearchCallCount += 1;

        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return { ok: false, error: "web_search query must not be empty." };
        const recencyDays =
          args.recencyDays === 7 || args.recencyDays === 30 || args.recencyDays === 90
            ? args.recencyDays
            : undefined;

        return webSearch({
          query,
          ...(recencyDays ? { recencyDays } : {}),
        });
      },
    });
  }

  const capabilities = input.capabilities;
  if (capabilities && capabilities.list.length > 0) {
    const capabilityIds = capabilities.list.map((capability) => capability.id);
    const capabilityOperations: GoatCapabilityOperation[] = capabilities.list.some(
      (capability) => capability.sideEffect === "write",
    )
      ? ["read", "write"]
      : ["read"];
    tools[USE_CAPABILITY_TOOL_NAME] = tool<UseCapabilityToolInput, UseCapabilityToolOutput>({
      description: USE_CAPABILITY_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<UseCapabilityToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          capability: {
            type: "string",
            enum: capabilityIds,
            description: "Which connected capability to use.",
          },
          operation: {
            type: "string",
            enum: capabilityOperations,
            description: USE_CAPABILITY_OPERATION_DESCRIPTION,
          },
          request: {
            type: "string",
            description: USE_CAPABILITY_REQUEST_DESCRIPTION,
          },
        },
        required: ["capability", "operation", "request"],
      }),
      execute: async (args, executionContext) => {
        visibleToolActivity = true;
        const capability = typeof args.capability === "string" ? args.capability : "";
        // Models occasionally emit values outside a schema enum; re-validate so
        // an invented id fails as a steering envelope, not an executor error.
        if (!capabilityIds.includes(capability)) {
          return {
            capability,
            summary: "",
            entities: [],
            error: {
              code: "invalid_request",
              hint: `"${capability}" is not an available capability. Available: ${capabilityIds.join(", ")}.`,
            },
          };
        }
        const operation =
          args.operation === "read" || args.operation === "write" ? args.operation : null;
        if (!operation) {
          return {
            capability,
            summary: "",
            entities: [],
            error: {
              code: "invalid_request",
              hint: 'The operation must be either "read" or "write".',
            },
          };
        }
        const selectedCapability = capabilities.list.find((entry) => entry.id === capability);
        if (operation === "write" && selectedCapability?.sideEffect !== "write") {
          return {
            capability,
            summary: "",
            entities: [],
            error: {
              code: "invalid_request",
              hint: `The ${capability} capability does not support write operations.`,
            },
          };
        }
        const request = typeof args.request === "string" ? args.request.trim() : "";
        if (!request) {
          return {
            capability,
            summary: "",
            entities: [],
            error: {
              code: "invalid_request",
              hint: "The request was empty. Send a self-contained natural-language request.",
            },
          };
        }
        if (capabilityCallCount >= MAX_CAPABILITY_CALLS_PER_TURN) {
          return {
            capability,
            summary: "",
            entities: [],
            error: {
              code: "call_budget",
              hint: `use_capability is limited to ${MAX_CAPABILITY_CALLS_PER_TURN} calls per chat turn. Summarize what you already have, or start a task for deeper work.`,
            },
          };
        }
        capabilityCallCount += 1;
        const toolCallId =
          executionContext &&
          typeof executionContext === "object" &&
          "toolCallId" in executionContext &&
          typeof executionContext.toolCallId === "string"
            ? executionContext.toolCallId
            : `capability_${capabilityCallCount}`;
        return capabilities.execute({ capability, operation, request, toolCallId });
      },
    });
  }

  return {
    getStartedTask: () => startedTask,
    hasVisibleToolActivity: () => visibleToolActivity,
    tools,
  };
}

export function createOpenCompanyChatDebugTrace(input: {
  model: string;
  aborted?: boolean;
  finishReason?: string;
  uiMessageParts?: unknown[];
  steps?: unknown;
  error?: string;
}): OpenCompanyChatAgentDebugTrace {
  return {
    schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
    model: input.model,
    ...(input.aborted ? { aborted: true } : {}),
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    ...(input.uiMessageParts?.length ? { uiMessageParts: input.uiMessageParts } : {}),
    toolCalls: compactStepValues(input.steps, "toolCalls"),
    toolResults: compactStepValues(input.steps, "toolResults"),
    ...(() => {
      const usage = usageFromSteps(input.steps);
      return usage ? { usage } : {};
    })(),
    ...(input.error ? { error: input.error } : {}),
  };
}

export function normalizeAgentText(text: string, startedTask: StartedTask | null) {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (startedTask) {
    return "I've started a task and added it to Tasks.";
  }
  return "I could not produce a response. Try sending that again.";
}

export function stringifyFinishReason(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function latestUserMessageContent(messages: readonly OpenCompanyChatAgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const trimmed = message.content.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeStartTaskEngine(value: unknown): GoatHarnessEngine | undefined {
  return value === "opencompany" || value === "codex" ? value : undefined;
}

function inferStartTaskEngine(value: string | undefined): GoatHarnessEngine | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  const steeringText = normalized.replace(/@codex\b/g, "");
  if (!/\bcodex\b/.test(steeringText)) return undefined;
  if (/\b(?:do not|don't|dont|without|avoid|no|not)\b.{0,24}\bcodex\b/.test(steeringText)) {
    return undefined;
  }
  return "codex";
}

export function normalizeGoatBrainToolInput(input: unknown): GoatBrainToolInput {
  return normalizeGoatBrainReadToolInput(input);
}

function toStartTaskToolOutput(
  task: StartedTask,
  status: StartTaskToolOutput["status"],
): StartTaskToolOutput {
  return {
    taskId: task.id,
    taskDisplayId: task.displayId,
    taskName: task.name,
    status,
    prompt: task.prompt,
  };
}

function compactStepValues(steps: unknown, key: "toolCalls" | "toolResults") {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const value = (step as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.map(toJsonSafeValue) : [];
  });
}

// The last step's usage reflects the full context sent on the final model call
// (all prior messages + tool results) plus the response, so it approximates how
// full the context window is after the turn.
function usageFromSteps(steps: unknown): OpenCompanyChatAgentDebugTrace["usage"] {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const lastStep = steps[steps.length - 1];
  if (!lastStep || typeof lastStep !== "object") return undefined;
  const usage = (lastStep as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(record.inputTokens);
  const outputTokens = nonNegativeInteger(record.outputTokens);
  const totalTokens = nonNegativeInteger(record.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toJsonSafeValue(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

import { GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatHarnessEngine } from "@opencompany/db/goat-schema";
import {
  createGoatGatewayAttribution,
  type GoatGatewayFeature,
  goatGatewayProviderOptions,
} from "@opencompany/goat-observability";
import { flushLatitude, latitudeTelemetry } from "@opencompany/goat-observability/latitude";
import {
  createGateway,
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  stepCountIs,
  type ToolCallRepairFunction,
  type ToolSet,
  tool,
} from "ai";
import { MAX_ACTION_CALLS_PER_TURN } from "@/lib/actions/limits";
import {
  buildGoatBrainMultiBrainToolSchema,
  GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  type GoatBrainMultiBrainTarget,
  normalizeGoatBrainReadToolInput,
} from "@/lib/brain-surface";
import { MAX_WEB_FETCH_CALLS_PER_TURN, MAX_WEB_SEARCH_CALLS_PER_TURN } from "@/lib/chat-limits";
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
  type GoatChatActionCatalog,
  LIST_ACTIONS_TOOL_NAME,
  type ListActionsToolInput,
  type ListActionsToolOutput,
  SAVE_TO_BRAIN_TOOL_NAME,
  type SaveToBrainToolInput,
  type SaveToBrainToolOutput,
  SCHEDULE_TASK_TOOL_NAME,
  type ScheduleTaskToolInput,
  type ScheduleTaskToolOutput,
  START_TASK_TOOL_NAME,
  type StartTaskToolInput,
  type StartTaskToolOutput,
  USE_ACTION_TOOL_NAME,
  type UseActionToolInput,
  type UseActionToolOutput,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type WebFetchToolInput,
  type WebFetchToolOutput,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import { normalizePublicWebUrl } from "@/lib/chat-web-fetch";
import {
  createOpenCompanyChatSystemPrompt,
  DELETE_TASK_SCHEDULE_TOOL_DESCRIPTION,
  EDIT_TASK_SCHEDULE_TOOL_DESCRIPTION,
  GOAT_BRAIN_TOOL_DESCRIPTION,
  LIST_ACTIONS_SOURCE_DESCRIPTION,
  LIST_ACTIONS_TOOL_DESCRIPTION,
  SAVE_TO_BRAIN_ATTACHMENT_IDS_DESCRIPTION,
  SAVE_TO_BRAIN_CONTENT_DESCRIPTION,
  SAVE_TO_BRAIN_FALLBACK_CONTENT_DESCRIPTION,
  SAVE_TO_BRAIN_INTEGRATION_ID_DESCRIPTION,
  SAVE_TO_BRAIN_INTENT_DESCRIPTION,
  SAVE_TO_BRAIN_SOURCE_REF_DESCRIPTION,
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
  USE_ACTION_ACTION_DESCRIPTION,
  USE_ACTION_PARAMS_DESCRIPTION,
  USE_ACTION_TOOL_DESCRIPTION,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_FETCH_URL_DESCRIPTION,
  WEB_SEARCH_QUERY_DESCRIPTION,
  WEB_SEARCH_RECENCY_DAYS_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "@/lib/prompts";

export { MAX_ACTION_CALLS_PER_TURN } from "@/lib/actions/limits";
export {
  createOpenCompanyChatSystemPrompt,
  OPENCOMPANY_CHAT_SYSTEM_PROMPT,
} from "@/lib/prompts";

export const OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION = "opencompany.chat.debug.v1";
export const OPENCOMPANY_CHAT_MAX_STEPS = 8;
const MAX_ACTION_PROVIDER_FAILURES_PER_TURN = 2;
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
type WebFetchRunner = (input: WebFetchToolInput) => Promise<WebFetchToolOutput>;
type WebSearchRunner = (input: WebSearchToolInput) => Promise<WebSearchToolOutput>;
type ScheduleTaskRunner = (input: ScheduleTaskToolInput) => Promise<ScheduleTaskToolOutput>;
type EditTaskScheduleRunner = (
  input: EditTaskScheduleToolInput,
) => Promise<EditTaskScheduleToolOutput>;
type DeleteTaskScheduleRunner = (
  input: DeleteTaskScheduleToolInput,
) => Promise<DeleteTaskScheduleToolOutput>;
export type ActionDispatcher = {
  // The action catalog resolved server-side from real connection state; ids
  // become the dispatch enum, so a disconnected provider's actions cannot be
  // invoked by guessing.
  catalog: GoatChatActionCatalog;
  prelistedSourceIds?: readonly string[];
  execute: (input: {
    action: string;
    params: Record<string, unknown>;
    toolCallId: string;
  }) => Promise<UseActionToolOutput>;
};

// An action in "ask" mode pauses the stream on a tool-approval request the
// user answers in the chat UI; the approved call executes on the follow-up
// approval-continuation request with the recorded input.
function actionNeedsApproval(catalog: GoatChatActionCatalog, actionId: string) {
  return catalog.actions.find((action) => action.id === actionId)?.permissionMode === "ask";
}

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
  error?: string;
};

export type OpenCompanyChatAgentResult = {
  content: string;
  task: StartedTask | null;
  debugTrace: OpenCompanyChatAgentDebugTrace;
  // Full-turn usage across all steps (unlike debugTrace.usage, which is the
  // last step only as a context-fullness proxy). Headless surfaces need this
  // for credit debits.
  totalUsage: LanguageModelUsage | undefined;
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
  startTask?: (task: StartTaskRequest) => Promise<StartedTask>;
  requestedEngine?: GoatHarnessEngine;
  scheduleTask?: ScheduleTaskRunner;
  editTaskSchedule?: EditTaskScheduleRunner;
  deleteTaskSchedule?: DeleteTaskScheduleRunner;
  runBrainCli?: GoatBrainCliRunner;
  saveToBrain?: SaveToBrainRunner;
  webFetch?: WebFetchRunner;
  webSearch?: WebSearchRunner;
  actions?: ActionDispatcher;
  goatBrainMultiBrain?: { targets: readonly GoatBrainMultiBrainTarget[] };
  currentDate?: Date | string;
  userContext?: OpenCompanyChatSystemPromptInput["userContext"];
  recurringSchedules?: OpenCompanyChatSystemPromptInput["recurringSchedules"];
  taskToolsEnabled?: boolean;
  brainCaptureEnabled?: boolean;
  activeBrain?: OpenCompanyChatSystemPromptInput["activeBrain"];
  connectedIntegrations?: OpenCompanyChatSystemPromptInput["connectedIntegrations"];
  // Surface-specific prompt blocks appended after the shared system prompt
  // (e.g. Slack mrkdwn formatting rules).
  extraSystemBlocks?: readonly string[];
  // Gateway cost attribution surface; defaults to the main chat.
  feature?: GoatGatewayFeature;
  userWorkosId?: string | null;
  chatSessionId?: string | null;
  // Latitude session grouping for surfaces without a chat session (e.g. a
  // Slack thread ref); chatSessionId wins when both are set.
  telemetrySessionId?: string | null;
  brainRef?: string | null;
  abortSignal?: AbortSignal;
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
    feature: input.feature ?? "chat",
    ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
    ...(input.brainRef ? { brainRef: input.brainRef } : {}),
  });
  const latestUserMessage = latestUserMessageContent(input.messages);
  const toolContext = createOpenCompanyChatToolContext({
    model: input.model,
    ...(input.startTask ? { startTask: input.startTask } : {}),
    ...(latestUserMessage ? { latestUserMessage } : {}),
    ...(input.requestedEngine ? { requestedEngine: input.requestedEngine } : {}),
    ...(input.scheduleTask ? { scheduleTask: input.scheduleTask } : {}),
    ...(input.editTaskSchedule ? { editTaskSchedule: input.editTaskSchedule } : {}),
    ...(input.deleteTaskSchedule ? { deleteTaskSchedule: input.deleteTaskSchedule } : {}),
    ...(input.runBrainCli ? { runBrainCli: input.runBrainCli } : {}),
    ...(input.saveToBrain ? { saveToBrain: input.saveToBrain } : {}),
    ...(input.webFetch ? { webFetch: input.webFetch } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
    ...(input.goatBrainMultiBrain ? { goatBrainMultiBrain: input.goatBrainMultiBrain } : {}),
  });

  const systemPromptInput = {
    webFetchEnabled: Boolean(input.webFetch),
    webSearchEnabled: Boolean(input.webSearch),
    ...(input.currentDate ? { currentDate: input.currentDate } : {}),
    ...(input.userContext ? { userContext: input.userContext } : {}),
    ...(input.recurringSchedules ? { recurringSchedules: input.recurringSchedules } : {}),
    ...(input.taskToolsEnabled !== undefined ? { taskToolsEnabled: input.taskToolsEnabled } : {}),
    ...(input.brainCaptureEnabled !== undefined
      ? { brainCaptureEnabled: input.brainCaptureEnabled }
      : {}),
    ...(input.activeBrain !== undefined ? { activeBrain: input.activeBrain } : {}),
    ...(input.connectedIntegrations !== undefined
      ? { connectedIntegrations: input.connectedIntegrations }
      : {}),
  };
  const system = [
    createOpenCompanyChatSystemPrompt(systemPromptInput),
    ...(input.extraSystemBlocks ?? []),
  ].join("\n\n");

  const feature = input.feature ?? "chat";
  let result: Awaited<ReturnType<GenerateTextLike>>;
  try {
    result = await generate({
      model: gateway(input.model),
      system,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stopWhen: stepCountIs(OPENCOMPANY_CHAT_MAX_STEPS),
      prepareStep: ({ stepNumber }) => prepareOpenCompanyChatStep({ stepNumber }),
      tools: toolContext.tools,
      ...(toolContext.repairToolCall
        ? { experimental_repairToolCall: toolContext.repairToolCall }
        : {}),
      providerOptions: goatGatewayProviderOptions(attribution, GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS),
      ...latitudeTelemetry({
        name: feature === "slack-bot" ? "slack-answer" : "chat-agent",
        feature,
        userId: input.userWorkosId,
        sessionId: input.chatSessionId ?? input.telemetrySessionId,
        metadata: {
          model: input.model,
          ...(input.brainRef ? { brainRef: input.brainRef } : {}),
        },
      }),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  } finally {
    // Headless callers (Slack bot, schedulers) have no response lifecycle to
    // hook a flush onto, so export before returning. No-op when disabled.
    await flushLatitude();
  }

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
    totalUsage: result.totalUsage,
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
  webFetch?: WebFetchRunner;
  webSearch?: WebSearchRunner;
  actions?: ActionDispatcher;
  // When several brains are in scope (e.g. a Slack channel routed to more than
  // one brain), the goat_brain schema grows a required `brain` enum and raw
  // args flow to runBrainCli so the runner can pick the target and normalize.
  goatBrainMultiBrain?: { targets: readonly GoatBrainMultiBrainTarget[] };
}) {
  let startedTask: StartedTask | null = null;
  let startTaskInFlight: Promise<StartedTask> | null = null;
  let scheduledTask: ScheduleTaskToolOutput | null = null;
  let scheduleTaskInFlight: Promise<ScheduleTaskToolOutput> | null = null;
  let visibleToolActivity = false;
  let webFetchCallCount = 0;
  let webSearchCallCount = 0;
  let actionCallCount = 0;
  const listedActionSourceIds = new Set(input.actions?.prelistedSourceIds ?? []);
  const actionProviderRetryGate = createActionProviderRetryGate(
    MAX_ACTION_PROVIDER_FAILURES_PER_TURN,
  );
  let repairToolCall: ToolCallRepairFunction<ToolSet> | undefined;

  const multiBrainTargets = input.goatBrainMultiBrain?.targets ?? [];
  const multiBrain = multiBrainTargets.length > 1;
  const goatBrainSchema = multiBrain
    ? (buildGoatBrainMultiBrainToolSchema(multiBrainTargets) as unknown as Parameters<
        typeof jsonSchema
      >[0])
    : GOAT_BRAIN_READ_TOOL_AI_SCHEMA;

  const tools: ToolSet = {
    [GOAT_BRAIN_TOOL_NAME]: tool<GoatBrainToolInput, GoatBrainToolOutput>({
      description: GOAT_BRAIN_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<GoatBrainToolInput>(goatBrainSchema),
      execute: async (args, executionContext?: unknown) => {
        if (!input.runBrainCli) {
          throw new Error("goat_brain is not configured for this chat.");
        }
        visibleToolActivity = true;
        // Multi-brain runners receive the raw args (including `brain`) and own
        // normalization after extracting the target.
        const toolArgs = multiBrain ? args : normalizeGoatBrainToolInput(args);
        return executionContext === undefined
          ? input.runBrainCli(toolArgs)
          : input.runBrainCli(toolArgs, executionContext);
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
          sourceRef: {
            type: "string",
            description: SAVE_TO_BRAIN_SOURCE_REF_DESCRIPTION,
          },
          integrationId: {
            type: "string",
            description: SAVE_TO_BRAIN_INTEGRATION_ID_DESCRIPTION,
          },
          fallbackContent: {
            type: "string",
            description: SAVE_TO_BRAIN_FALLBACK_CONTENT_DESCRIPTION,
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
        const sourceRef = typeof args.sourceRef === "string" ? args.sourceRef.trim() : "";
        const integrationId =
          typeof args.integrationId === "string" ? args.integrationId.trim() : "";
        const fallbackContent =
          typeof args.fallbackContent === "string" ? args.fallbackContent.trim() : "";
        const attachmentIds = Array.isArray(args.attachmentIds)
          ? [
              ...new Set(
                args.attachmentIds.filter(
                  (id): id is string => typeof id === "string" && id.trim().length > 0,
                ),
              ),
            ]
          : [];
        if (!content && !sourceRef && attachmentIds.length === 0) {
          return {
            ok: false,
            error: "save_to_brain needs content, sourceRef, or attachmentIds.",
          };
        }
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const intent = typeof args.intent === "string" ? args.intent.trim() : "";

        // Duplicate calls within one turn return the first capture instead of
        // minting another inbox draft / asset copy.
        const key = `${title}\n${content}\n${sourceRef}\n${integrationId}\n${fallbackContent}\n${attachmentIds.join(",")}`;
        const already = capturedByKey.get(key);
        if (already?.ok) return { ...already, status: "already_captured" };

        const output = await saveToBrain({
          ...(content ? { content } : {}),
          ...(title ? { title } : {}),
          ...(intent ? { intent } : {}),
          ...(sourceRef ? { sourceRef } : {}),
          ...(integrationId ? { integrationId } : {}),
          ...(fallbackContent ? { fallbackContent } : {}),
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

  const webFetch = input.webFetch;
  if (webFetch) {
    tools[WEB_FETCH_TOOL_NAME] = tool<WebFetchToolInput, WebFetchToolOutput>({
      description: WEB_FETCH_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<WebFetchToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description: WEB_FETCH_URL_DESCRIPTION,
          },
        },
        required: ["url"],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        let url: string;
        try {
          url = normalizePublicWebUrl(typeof args.url === "string" ? args.url : "");
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "web_fetch URL is invalid.",
          };
        }
        if (webFetchCallCount >= MAX_WEB_FETCH_CALLS_PER_TURN) {
          return {
            ok: false,
            error: `web_fetch is limited to ${MAX_WEB_FETCH_CALLS_PER_TURN} URLs per chat turn. Start a task for deeper research.`,
          };
        }
        webFetchCallCount += 1;
        return webFetch({ url });
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
        if (webSearchCallCount >= MAX_WEB_SEARCH_CALLS_PER_TURN) {
          return {
            ok: false,
            error: `web_search is limited to ${MAX_WEB_SEARCH_CALLS_PER_TURN} searches per chat turn. Start a task for deeper research.`,
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

  const actions = input.actions;
  if (actions && actions.catalog.actions.length > 0) {
    const sourceIds = actions.catalog.sources.map((source) => source.id);
    const actionIds = actions.catalog.actions.map((action) => action.id);
    const actionIdSet = new Set(actionIds);
    // Models sometimes emit an action id from discovery (for example
    // "linear.get_project") as the tool name instead of wrapping it in
    // use_action. Repair only exact ids from this user's current catalog so
    // normal validation and write approval still happen inside use_action.
    repairToolCall = async ({ toolCall }) => {
      if (!actionIdSet.has(toolCall.toolName)) return null;
      const params = parseToolCallParams(toolCall.input);
      if (!params) return null;
      return {
        ...toolCall,
        toolName: USE_ACTION_TOOL_NAME,
        input: JSON.stringify({
          action: toolCall.toolName,
          params,
        }),
      };
    };
    tools[LIST_ACTIONS_TOOL_NAME] = tool<ListActionsToolInput, ListActionsToolOutput>({
      description: LIST_ACTIONS_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<ListActionsToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          source: {
            type: "string",
            enum: sourceIds,
            description: LIST_ACTIONS_SOURCE_DESCRIPTION,
          },
        },
        required: ["source"],
      }),
      execute: async (args) => {
        visibleToolActivity = true;
        const requestedSource =
          typeof args.source === "string" ? args.source.trim().toLowerCase() : "";
        const source = actions.catalog.sources.find((entry) => entry.id === requestedSource);
        if (!source) {
          return {
            ok: false,
            error: {
              code: "unknown_source",
              message: `Unknown source ${JSON.stringify(requestedSource)}. Use an exact id from <action_sources>.`,
              availableSources: sourceIds,
            },
          };
        }
        listedActionSourceIds.add(source.id);
        return {
          ok: true,
          source,
          actions: actions.catalog.actions.filter((action) => action.source === source.id),
        };
      },
    });
    tools[USE_ACTION_TOOL_NAME] = tool<UseActionToolInput, UseActionToolOutput>({
      description: USE_ACTION_TOOL_DESCRIPTION,
      needsApproval: async (args) =>
        actionNeedsApproval(actions.catalog, typeof args.action === "string" ? args.action : ""),
      inputSchema: jsonSchema<UseActionToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: actionIds,
            description: USE_ACTION_ACTION_DESCRIPTION,
          },
          params: {
            type: "object",
            additionalProperties: true,
            description: USE_ACTION_PARAMS_DESCRIPTION,
          },
        },
        required: ["action", "params"],
      }),
      execute: async (args, executionContext) => {
        visibleToolActivity = true;
        const action = typeof args.action === "string" ? args.action : "";
        const resolvedAction = actions.catalog.actions.find((entry) => entry.id === action);
        // Models occasionally emit values outside a schema enum; re-validate so
        // an invented id fails as a steering result, not an executor error.
        if (!resolvedAction) {
          return {
            ok: false,
            action,
            error: {
              code: "invalid_params",
              message: `"${action}" is not an available action. Call list_actions with the relevant source id for the current catalog.`,
            },
          };
        }
        if (!listedActionSourceIds.has(resolvedAction.source)) {
          return {
            ok: false,
            action,
            error: {
              code: "invalid_params",
              source: resolvedAction.source,
              message: `Call list_actions with source ${JSON.stringify(
                resolvedAction.source,
              )} in this chat turn before using ${JSON.stringify(action)}.`,
            },
          };
        }
        const params =
          args.params && typeof args.params === "object" && !Array.isArray(args.params)
            ? args.params
            : {};
        if (actionCallCount >= MAX_ACTION_CALLS_PER_TURN) {
          return {
            ok: false,
            action,
            error: {
              code: "call_budget",
              message: `use_action is limited to ${MAX_ACTION_CALLS_PER_TURN} calls per chat turn. Summarize what you already have and continue in a later chat turn if needed.`,
            },
          };
        }
        actionCallCount += 1;
        const actionCallNumber = actionCallCount;
        const actionAbortSignal =
          executionContext &&
          typeof executionContext === "object" &&
          "abortSignal" in executionContext &&
          executionContext.abortSignal instanceof AbortSignal
            ? executionContext.abortSignal
            : undefined;
        if (!(await actionProviderRetryGate.acquire(action, actionAbortSignal))) {
          return {
            ok: false,
            action,
            error: {
              code: "provider_error",
              source: resolvedAction.source,
              message: `${JSON.stringify(action)} reached its provider retry limit in this chat turn. Do not call it again now; summarize any results already available and explain what remains unverified.`,
            },
          };
        }
        const toolCallId =
          executionContext &&
          typeof executionContext === "object" &&
          "toolCallId" in executionContext &&
          typeof executionContext.toolCallId === "string"
            ? executionContext.toolCallId
            : `action_${actionCallNumber}`;
        let outcome: ActionProviderAttemptOutcome = "neutral";
        try {
          const result = await actions.execute({ action, params, toolCallId });
          if (result.ok) {
            outcome = "success";
          } else if (result.error.code === "provider_error" || result.error.code === "timeout") {
            outcome = "failure";
          }
          return result;
        } finally {
          actionProviderRetryGate.complete(action, outcome);
        }
      },
    });
  }

  return {
    getStartedTask: () => startedTask,
    hasVisibleToolActivity: () => visibleToolActivity,
    repairToolCall,
    tools,
  };
}

type ActionProviderAttemptOutcome = "success" | "failure" | "neutral";

function createActionProviderRetryGate(maxFailures: number) {
  const failureCounts = new Map<string, number>();
  const callsInFlight = new Map<string, number>();
  const stateSignals = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  function waitForStateChange(action: string, abortSignal?: AbortSignal) {
    const existing = stateSignals.get(action);
    let statePromise = existing?.promise;
    if (!statePromise) {
      let resolve!: () => void;
      statePromise = new Promise<void>((release) => {
        resolve = release;
      });
      stateSignals.set(action, { promise: statePromise, resolve });
    }
    if (!abortSignal) return statePromise;
    if (abortSignal.aborted) return Promise.reject(actionAbortReason(abortSignal));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(actionAbortReason(abortSignal));
      abortSignal.addEventListener("abort", onAbort, { once: true });
      void statePromise.then(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  function notifyStateChange(action: string) {
    const signal = stateSignals.get(action);
    if (!signal) return;
    stateSignals.delete(action);
    signal.resolve();
  }

  return {
    async acquire(action: string, abortSignal?: AbortSignal) {
      while (true) {
        if (abortSignal?.aborted) throw actionAbortReason(abortSignal);
        const failures = failureCounts.get(action) ?? 0;
        if (failures >= maxFailures) return false;

        const inFlight = callsInFlight.get(action) ?? 0;
        if (failures + inFlight < maxFailures) {
          callsInFlight.set(action, inFlight + 1);
          return true;
        }

        // In-flight work is not a failure. Wait for it to settle, then admit
        // another call if success reopened the circuit.
        await waitForStateChange(action, abortSignal);
      }
    },
    complete(action: string, outcome: ActionProviderAttemptOutcome) {
      if (outcome === "success") {
        failureCounts.delete(action);
      } else if (outcome === "failure") {
        failureCounts.set(action, (failureCounts.get(action) ?? 0) + 1);
      }

      const remaining = (callsInFlight.get(action) ?? 1) - 1;
      if (remaining > 0) callsInFlight.set(action, remaining);
      else callsInFlight.delete(action);
      notifyStateChange(action);
    },
  };
}

function actionAbortReason(abortSignal: AbortSignal) {
  return abortSignal.reason ?? new DOMException("Action execution was aborted.", "AbortError");
}

export function prepareOpenCompanyChatStep(input: {
  stepNumber: number;
  forceApprovedAction?: boolean;
}) {
  if (input.stepNumber >= OPENCOMPANY_CHAT_MAX_STEPS - 1) {
    return {
      activeTools: [],
      toolChoice: "none" as const,
    };
  }
  if (input.forceApprovedAction && input.stepNumber === 0) {
    return {
      activeTools: [USE_ACTION_TOOL_NAME],
      // Only use_action is active, so "required" remains deterministic without
      // the named-tool choice that Kimi K3 rejects while thinking is enabled.
      toolChoice: "required" as const,
    };
  }
  return {};
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

function parseToolCallParams(input: string): Record<string, unknown> | null {
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

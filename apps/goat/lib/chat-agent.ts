import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { createGateway, generateText, jsonSchema, stepCountIs, type ToolSet, tool } from "ai";
import {
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  type DeleteTaskScheduleToolInput,
  type DeleteTaskScheduleToolOutput,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  type EditTaskScheduleToolInput,
  type EditTaskScheduleToolOutput,
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainCliCommand,
  type GoatBrainToolFlagValue,
  type GoatBrainToolInput,
  type GoatBrainToolOutput,
  SCHEDULE_TASK_TOOL_NAME,
  type ScheduleTaskToolInput,
  type ScheduleTaskToolOutput,
  START_TASK_TOOL_NAME,
  type StartTaskToolInput,
  type StartTaskToolOutput,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import {
  createOpenCompanyChatSystemPrompt,
  DELETE_TASK_SCHEDULE_TOOL_DESCRIPTION,
  EDIT_TASK_SCHEDULE_TOOL_DESCRIPTION,
  GOAT_BRAIN_TOOL_ARGS_DESCRIPTION,
  GOAT_BRAIN_TOOL_DESCRIPTION,
  SCHEDULE_TASK_CRON_DESCRIPTION,
  SCHEDULE_TASK_NAME_DESCRIPTION,
  SCHEDULE_TASK_PROMPT_DESCRIPTION,
  SCHEDULE_TASK_SOURCE_DESCRIPTION,
  SCHEDULE_TASK_TIMEZONE_DESCRIPTION,
  SCHEDULE_TASK_TOOL_DESCRIPTION,
  START_TASK_NAME_DESCRIPTION,
  START_TASK_PROMPT_DESCRIPTION,
  START_TASK_REASON_DESCRIPTION,
  START_TASK_TOOL_DESCRIPTION,
  TASK_SCHEDULE_IDENTIFIER_DESCRIPTION,
  TASK_SCHEDULE_NAME_LOOKUP_DESCRIPTION,
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
type WebSearchRunner = (input: WebSearchToolInput) => Promise<WebSearchToolOutput>;
type ScheduleTaskRunner = (input: ScheduleTaskToolInput) => Promise<ScheduleTaskToolOutput>;
type EditTaskScheduleRunner = (
  input: EditTaskScheduleToolInput,
) => Promise<EditTaskScheduleToolOutput>;
type DeleteTaskScheduleRunner = (
  input: DeleteTaskScheduleToolInput,
) => Promise<DeleteTaskScheduleToolOutput>;

const GOAT_BRAIN_CLI_COMMANDS = [
  "help",
  "create",
  "list",
  "get",
  "timeline",
  "query",
  "append-evidence",
  "rewrite",
  "alias",
  "timeline-add",
  "append-timeline",
  "link",
  "merge",
  "move",
  "delete",
  "folder",
  "doctor",
] as const satisfies readonly GoatBrainCliCommand[];

export type OpenCompanyChatAgentDebugTrace = {
  schemaVersion: typeof OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION;
  model: string;
  aborted?: boolean;
  finishReason?: string;
  uiMessageParts?: unknown[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
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

export async function runOpenCompanyChatAgent(input: {
  messages: readonly OpenCompanyChatAgentMessage[];
  model: AgentModelId;
  gatewayApiKey: string;
  startTask: (task: { prompt: string; name?: string; model: AgentModelId }) => Promise<StartedTask>;
  scheduleTask?: ScheduleTaskRunner;
  editTaskSchedule?: EditTaskScheduleRunner;
  deleteTaskSchedule?: DeleteTaskScheduleRunner;
  runBrainCli?: GoatBrainCliRunner;
  webSearch?: WebSearchRunner;
  currentDate?: Date | string;
  userContext?: OpenCompanyChatSystemPromptInput["userContext"];
  recurringSchedules?: OpenCompanyChatSystemPromptInput["recurringSchedules"];
  generateTextImpl?: GenerateTextLike;
}): Promise<OpenCompanyChatAgentResult> {
  const gatewayApiKey = input.gatewayApiKey.trim();
  if (!gatewayApiKey) {
    throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for Goat chat.");
  }

  const generate = input.generateTextImpl ?? generateText;
  const gateway = createGateway({ apiKey: gatewayApiKey });
  const toolContext = createOpenCompanyChatToolContext({
    model: input.model,
    startTask: input.startTask,
    ...(input.scheduleTask ? { scheduleTask: input.scheduleTask } : {}),
    ...(input.editTaskSchedule ? { editTaskSchedule: input.editTaskSchedule } : {}),
    ...(input.deleteTaskSchedule ? { deleteTaskSchedule: input.deleteTaskSchedule } : {}),
    ...(input.runBrainCli ? { runBrainCli: input.runBrainCli } : {}),
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
  startTask: (task: { prompt: string; name?: string; model: AgentModelId }) => Promise<StartedTask>;
  scheduleTask?: ScheduleTaskRunner;
  editTaskSchedule?: EditTaskScheduleRunner;
  deleteTaskSchedule?: DeleteTaskScheduleRunner;
  runBrainCli?: GoatBrainCliRunner;
  webSearch?: WebSearchRunner;
}) {
  let startedTask: StartedTask | null = null;
  let startTaskInFlight: Promise<StartedTask> | null = null;
  let scheduledTask: ScheduleTaskToolOutput | null = null;
  let scheduleTaskInFlight: Promise<ScheduleTaskToolOutput> | null = null;
  let webSearchCallCount = 0;

  const tools: ToolSet = {
    [GOAT_BRAIN_TOOL_NAME]: tool<GoatBrainToolInput, GoatBrainToolOutput>({
      description: GOAT_BRAIN_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<GoatBrainToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            enum: [...GOAT_BRAIN_CLI_COMMANDS],
            description: GOAT_BRAIN_TOOL_ARGS_DESCRIPTION,
          },
          flags: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "array", items: { type: "string" } },
              ],
            },
            description:
              "CLI flags for the command, without leading dashes. Use camelCase or kebab-case names, for example sourceTitle or source-title.",
          },
          stdin: {
            type: "string",
            description:
              "Optional stdin for commands that use *-stdin flags, such as create --truth-stdin, append-evidence --body-stdin, or rewrite --truth-stdin.",
          },
        },
        required: ["command"],
      }),
      execute: async (args, executionContext?: unknown) => {
        if (!input.runBrainCli) {
          throw new Error("goat_brain is not configured for this chat.");
        }
        const normalized = normalizeGoatBrainToolInput(args);
        return executionContext === undefined
          ? input.runBrainCli(normalized)
          : input.runBrainCli(normalized, executionContext);
      },
    }),
    [START_TASK_TOOL_NAME]: tool<StartTaskToolInput, StartTaskToolOutput>({
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
        },
        required: ["prompt", "name"],
      }),
      execute: async (args) => {
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

        try {
          startTaskInFlight = input.startTask({
            prompt,
            ...(name ? { name } : {}),
            model: input.model,
          });
          startedTask = await startTaskInFlight;
        } finally {
          startTaskInFlight = null;
        }
        return toStartTaskToolOutput(startedTask, "queued");
      },
    }),
  };

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
      execute: input.editTaskSchedule,
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
      execute: input.deleteTaskSchedule,
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

  return {
    getStartedTask: () => startedTask,
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
    ...(input.error ? { error: input.error } : {}),
  };
}

export function normalizeAgentText(text: string, startedTask: StartedTask | null) {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (startedTask) {
    return "I've started a task and added it to Results.";
  }
  return "I could not produce a response. Try sending that again.";
}

export function stringifyFinishReason(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function normalizeGoatBrainToolInput(input: unknown): GoatBrainToolInput {
  if (!input || typeof input !== "object") {
    throw new Error("goat_brain command is required.");
  }
  const record = input as Record<string, unknown>;
  const command = normalizeGoatBrainCommand(record.command);
  if (!command) throw new Error("goat_brain command is invalid.");
  const flags = normalizeGoatBrainFlags(record.flags);
  const stdin = typeof record.stdin === "string" ? record.stdin : "";
  return {
    command,
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
    ...(stdin ? { stdin } : {}),
  };
}

function normalizeGoatBrainCommand(value: unknown): GoatBrainCliCommand | null {
  if (typeof value !== "string") return null;
  return (GOAT_BRAIN_CLI_COMMANDS as readonly string[]).includes(value)
    ? (value as GoatBrainCliCommand)
    : null;
}

function normalizeGoatBrainFlags(value: unknown): Record<string, GoatBrainToolFlagValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, GoatBrainToolFlagValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim()) continue;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) out[key] = trimmed;
      continue;
    }
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) out[key] = raw;
      continue;
    }
    if (typeof raw === "boolean") {
      out[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      const values = raw.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      if (values.length > 0) out[key] = values.map((item) => item.trim());
    }
  }
  return out;
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

function toJsonSafeValue(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

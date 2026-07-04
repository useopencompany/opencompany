import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { createGateway, generateText, jsonSchema, stepCountIs, type ToolSet, tool } from "ai";
import {
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainToolInput,
  type GoatBrainToolOutput,
  START_TASK_TOOL_NAME,
  type StartTaskToolInput,
  type StartTaskToolOutput,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import {
  createOpenCompanyChatSystemPrompt,
  GOAT_BRAIN_TOOL_ARGS_DESCRIPTION,
  GOAT_BRAIN_TOOL_DESCRIPTION,
  START_TASK_NAME_DESCRIPTION,
  START_TASK_PROMPT_DESCRIPTION,
  START_TASK_REASON_DESCRIPTION,
  START_TASK_TOOL_DESCRIPTION,
  WEB_SEARCH_QUERY_DESCRIPTION,
  WEB_SEARCH_RECENCY_DAYS_DESCRIPTION,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "@/lib/prompts";

export { createOpenCompanyChatSystemPrompt, OPENCOMPANY_CHAT_SYSTEM_PROMPT } from "@/lib/prompts";

export const OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION = "opencompany.chat.debug.v1";

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
type GoatBrainCliRunner = (input: GoatBrainToolInput) => Promise<GoatBrainToolOutput>;
type WebSearchRunner = (input: WebSearchToolInput) => Promise<WebSearchToolOutput>;

export type OpenCompanyChatAgentDebugTrace = {
  schemaVersion: typeof OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION;
  model: string;
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

export async function runOpenCompanyChatAgent(input: {
  messages: readonly OpenCompanyChatAgentMessage[];
  model: AgentModelId;
  gatewayApiKey: string;
  startTask: (task: { prompt: string; name?: string; model: AgentModelId }) => Promise<StartedTask>;
  runBrainCli?: GoatBrainCliRunner;
  webSearch?: WebSearchRunner;
  currentDate?: Date | string;
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
    ...(input.runBrainCli ? { runBrainCli: input.runBrainCli } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
  });

  const systemPromptInput = {
    webSearchEnabled: Boolean(input.webSearch),
    ...(input.currentDate ? { currentDate: input.currentDate } : {}),
  };

  const result = await generate({
    model: gateway(input.model),
    system: createOpenCompanyChatSystemPrompt(systemPromptInput),
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stopWhen: stepCountIs(3),
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
  runBrainCli?: GoatBrainCliRunner;
  webSearch?: WebSearchRunner;
}) {
  let startedTask: StartedTask | null = null;
  let webSearchCallCount = 0;

  const tools: ToolSet = {
    [GOAT_BRAIN_TOOL_NAME]: tool<GoatBrainToolInput, GoatBrainToolOutput>({
      description: GOAT_BRAIN_TOOL_DESCRIPTION,
      inputSchema: jsonSchema<GoatBrainToolInput>({
        type: "object",
        additionalProperties: false,
        properties: {
          args: {
            type: "string",
            description: GOAT_BRAIN_TOOL_ARGS_DESCRIPTION,
          },
        },
        required: ["args"],
      }),
      execute: async (args) => {
        if (!input.runBrainCli) {
          throw new Error("goat_brain is not configured for this chat.");
        }
        const rawArgs = typeof args.args === "string" ? args.args.trim() : "";
        if (!rawArgs) throw new Error("goat_brain args are required.");
        return input.runBrainCli({ args: rawArgs });
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

        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          throw new Error("start_task prompt is required.");
        }
        const name = typeof args.name === "string" ? args.name.trim() : "";

        startedTask = await input.startTask({
          prompt,
          ...(name ? { name } : {}),
          model: input.model,
        });
        return toStartTaskToolOutput(startedTask, "queued");
      },
    }),
  };

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
  finishReason?: string;
  uiMessageParts?: unknown[];
  steps?: unknown;
  error?: string;
}): OpenCompanyChatAgentDebugTrace {
  return {
    schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
    model: input.model,
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

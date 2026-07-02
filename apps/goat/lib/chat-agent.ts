import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { createGateway, generateText, jsonSchema, stepCountIs, tool } from "ai";
import type { GoatStartTaskToolInput, GoatStartTaskToolOutput } from "@/lib/chat-ui";

type GoatChatAgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StartedGoatTask = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
};

type GenerateTextLike = typeof generateText;

export type GoatChatAgentDebugTrace = {
  schemaVersion: "goat.chat.debug.v1";
  model: string;
  finishReason?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  error?: string;
};

export type GoatChatAgentResult = {
  content: string;
  task: StartedGoatTask | null;
  debugTrace: GoatChatAgentDebugTrace;
};

export async function runGoatChatAgent(input: {
  messages: readonly GoatChatAgentMessage[];
  model: AgentModelId;
  gatewayApiKey: string;
  startTask: (task: {
    prompt: string;
    name?: string;
    model: AgentModelId;
  }) => Promise<StartedGoatTask>;
  generateTextImpl?: GenerateTextLike;
}): Promise<GoatChatAgentResult> {
  const gatewayApiKey = input.gatewayApiKey.trim();
  if (!gatewayApiKey) {
    throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for Goat chat.");
  }

  const generate = input.generateTextImpl ?? generateText;
  const gateway = createGateway({ apiKey: gatewayApiKey });
  const toolContext = createGoatChatToolContext({
    model: input.model,
    startTask: input.startTask,
  });

  const result = await generate({
    model: gateway(input.model),
    system: GOAT_DEFAULT_AGENT_SYSTEM,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    temperature: 0.2,
    maxOutputTokens: 900,
    stopWhen: stepCountIs(3),
    tools: toolContext.tools,
  });

  const startedTask = toolContext.getStartedTask();
  const content = normalizeAgentText(result.text, startedTask);
  const finishReason = stringifyFinishReason(result.finishReason);

  return {
    content,
    task: startedTask,
    debugTrace: createGoatChatDebugTrace({
      model: input.model,
      steps: result.steps,
      ...(finishReason ? { finishReason } : {}),
    }),
  };
}

export function createGoatChatToolContext(input: {
  model: AgentModelId;
  startTask: (task: {
    prompt: string;
    name?: string;
    model: AgentModelId;
  }) => Promise<StartedGoatTask>;
}) {
  let startedTask: StartedGoatTask | null = null;

  return {
    getStartedTask: () => startedTask,
    tools: {
      start_goat_task: tool<GoatStartTaskToolInput, GoatStartTaskToolOutput>({
        description:
          "Start a durable Goat task when the user's request should become an asynchronous tracked Result.",
        inputSchema: jsonSchema<GoatStartTaskToolInput>({
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              description:
                "A self-contained task prompt for the Goat task runner. Preserve the user's goal and relevant context.",
            },
            name: {
              type: "string",
              description: "A short 2-7 word task name for the Results list.",
            },
            reason: {
              type: "string",
              description: "Short reason this should run as a task instead of a chat answer.",
            },
          },
          required: ["prompt", "name"],
        }),
        execute: async (args) => {
          if (startedTask) return toStartGoatTaskToolOutput(startedTask, "already_started");

          const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
          if (!prompt) {
            throw new Error("start_goat_task prompt is required.");
          }
          const name = typeof args.name === "string" ? args.name.trim() : "";

          startedTask = await input.startTask({
            prompt,
            ...(name ? { name } : {}),
            model: input.model,
          });
          return toStartGoatTaskToolOutput(startedTask, "queued");
        },
      }),
    },
  };
}

export function createGoatChatDebugTrace(input: {
  model: string;
  finishReason?: string;
  steps?: unknown;
  error?: string;
}): GoatChatAgentDebugTrace {
  return {
    schemaVersion: "goat.chat.debug.v1",
    model: input.model,
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    toolCalls: compactStepValues(input.steps, "toolCalls"),
    toolResults: compactStepValues(input.steps, "toolResults"),
    ...(input.error ? { error: input.error } : {}),
  };
}

export const GOAT_DEFAULT_AGENT_SYSTEM = [
  "You are Goat, a concise default chat agent in the Goat app.",
  "You can either answer directly in chat or start one durable background task with start_goat_task.",
  "Default to answering directly for opinions, brainstorming, explanations, small edits, simple questions, and ambiguous prompts.",
  "Use start_goat_task only when the user asks you to research, investigate, monitor, compare sources, do work that should be tracked in Results, or answer something that likely needs current web research.",
  "If intent is unclear, ask one short clarifying question instead of starting a task.",
  "When you start a task, keep the chat response short and say that it was added to Results.",
  "Do not claim to browse, use a sandbox, or complete asynchronous task work in chat.",
].join(" ");

export function normalizeAgentText(text: string, startedTask: StartedGoatTask | null) {
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

function toStartGoatTaskToolOutput(
  task: StartedGoatTask,
  status: GoatStartTaskToolOutput["status"],
): GoatStartTaskToolOutput {
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

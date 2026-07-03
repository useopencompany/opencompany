import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { createGateway, generateText, jsonSchema, stepCountIs, tool } from "ai";
import {
  GOAT_BRAIN_TOOL_NAME,
  type GoatBrainToolInput,
  type GoatBrainToolOutput,
  START_TASK_TOOL_NAME,
  type StartTaskToolInput,
  type StartTaskToolOutput,
} from "@/lib/chat-ui";

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

export type OpenCompanyChatAgentDebugTrace = {
  schemaVersion: typeof OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION;
  model: string;
  finishReason?: string;
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
  });

  const result = await generate({
    model: gateway(input.model),
    system: OPENCOMPANY_CHAT_SYSTEM_PROMPT,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
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
}) {
  let startedTask: StartedTask | null = null;

  return {
    getStartedTask: () => startedTask,
    tools: {
      [GOAT_BRAIN_TOOL_NAME]: tool<GoatBrainToolInput, GoatBrainToolOutput>({
        description:
          'Run the user\'s personal Goat brain CLI for durable notes and recall. Use this when the user asks to remember, save, recall, inspect, edit, link, or search personal/company context that should stay available later. Pass only CLI arguments, for example: query --text "pricing" --hops 1 --limit 5, create --folder inbox --title "Hiring note" --truth "...", append-timeline note-id --body "...", or doctor.',
        inputSchema: jsonSchema<GoatBrainToolInput>({
          type: "object",
          additionalProperties: false,
          properties: {
            args: {
              type: "string",
              description:
                "Arguments for the goat-brain CLI, excluding the executable name. Do not include shell operators. Prefer query/get before editing unless the user clearly asked to remember or update something.",
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
        description:
          "Start a task when the user's request should become an asynchronous tracked Result, including work that needs connected-account context, external research, monitoring, or a specialized just-in-time agent.",
        inputSchema: jsonSchema<StartTaskToolInput>({
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              description:
                "A self-contained task prompt. Preserve the user's goal, relevant context, success criteria, and any constraints needed by the just-in-time agent.",
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
    },
  };
}

export function createOpenCompanyChatDebugTrace(input: {
  model: string;
  finishReason?: string;
  steps?: unknown;
  error?: string;
}): OpenCompanyChatAgentDebugTrace {
  return {
    schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
    model: input.model,
    ...(input.finishReason ? { finishReason: input.finishReason } : {}),
    toolCalls: compactStepValues(input.steps, "toolCalls"),
    toolResults: compactStepValues(input.steps, "toolResults"),
    ...(input.error ? { error: input.error } : {}),
  };
}

export const OPENCOMPANY_CHAT_SYSTEM_PROMPT = [
  "<system>",
  "You are OpenCompany, the main agent for getting work done and building the user's agentic company.",
  "You run in the main app as a chat interface. The rest of the app is organized around tasks: durable work items that can be spawned from this main agent when useful, tracked in Results, and executed by more specialized agents.",
  "</system>",
  "<behavior>",
  "Decide from the user's intent whether to handle the request in this chat loop or start a task.",
  "Handle the request directly when you can give a useful answer, make a small edit, brainstorm, explain, decide, draft, or ask a short clarifying question without needing extra execution context.",
  "Use the goat_brain tool inside chat when the user asks you to remember, save, recall, search, inspect, or lightly edit durable personal context. The tool runs the real personal-brain CLI against the user's Goat brain.",
  "Start a task when the user asks for research, investigation, monitoring, comparison across sources, connected-account work, longer-running execution, or anything that should be tracked as a Result.",
  "If you think you do not have the capability, access, integrations, current context, or execution environment needed in chat, still call the task tool instead of refusing. Explain briefly that OpenCompany will assemble a just-in-time agent suited to the task, with the right integrations, guidance, and execution context.",
  "Requests to check, read, summarize, triage, or monitor the user's latest emails, inbox, Gmail, calendar, or connected accounts are task requests.",
  "When you start a task, keep the chat response short and say that it was added to Results.",
  "Do not claim to browse, use a sandbox, access connected accounts, or complete asynchronous task work inside chat. You may say you checked or updated the user's Brain only after using goat_brain successfully.",
  "</behavior>",
  "<soul>",
  "Be a proactive, founder-focused operator: direct, practical, and biased toward forward motion.",
  "Think like a sharp chief of staff for an early company. Clarify only when it materially changes the work; otherwise make the best reasonable assumption and move.",
  "Protect the user's time. Surface the decision, next action, or tradeoff plainly. Prefer crisp execution over commentary.",
  "Care about leverage: turn vague intent into useful work, preserve context for future tasks, and help the company compound its operating knowledge.",
  "</soul>",
].join(" ");

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

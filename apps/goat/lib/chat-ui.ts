import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatChatMessage } from "@opencompany/db/goat-schema";
import type { UIMessage } from "ai";

export const START_TASK_TOOL_NAME = "start_task";
export const START_TASK_TOOL_PART_TYPE = `tool-${START_TASK_TOOL_NAME}` as const;
export const GOAT_BRAIN_TOOL_NAME = "goat_brain";
export const GOAT_BRAIN_TOOL_PART_TYPE = `tool-${GOAT_BRAIN_TOOL_NAME}` as const;

export type GoatTaskCardMetadata = {
  id: string;
  displayId: string;
  title: string;
};

export type GoatChatMessageMetadata = {
  sessionId?: string;
  task?: GoatTaskCardMetadata | null;
  error?: string;
};

export type StartTaskToolInput = {
  prompt: string;
  name: string;
  reason?: string;
};

export type StartTaskToolOutput = {
  taskId: string;
  taskDisplayId: string;
  taskName: string;
  status: "queued" | "already_started";
  prompt: string;
};

export type GoatBrainToolInput = {
  args: string;
};

export type GoatBrainToolOutput = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type GoatChatTools = {
  start_task: {
    input: StartTaskToolInput;
    output: StartTaskToolOutput;
  };
  goat_brain: {
    input: GoatBrainToolInput;
    output: GoatBrainToolOutput;
  };
};

export type GoatChatUiMessage = UIMessage<
  GoatChatMessageMetadata,
  Record<string, never>,
  GoatChatTools
>;

export type GoatChatSessionView = {
  id: string;
  title: string;
  model: AgentModelId;
  messages: GoatChatUiMessage[];
};

export type GoatStoredChatMessage = Pick<
  GoatChatMessage,
  "id" | "sessionId" | "role" | "content" | "taskId" | "debugTrace" | "createdAt" | "updatedAt"
> & {
  taskDisplayId: string | null;
  taskName: string | null;
  taskPrompt: string | null;
};

export function textFromGoatChatUiMessage(message: Pick<GoatChatUiMessage, "parts">) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

export function toGoatChatUiMessage(message: GoatStoredChatMessage): GoatChatUiMessage {
  const metadata = toGoatChatMessageMetadata(message);
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    ...(metadata ? { metadata } : {}),
    parts: message.content ? [{ type: "text", text: message.content }] : [],
  };
}

export function toGoatChatMessageMetadata(
  message: Pick<
    GoatStoredChatMessage,
    "sessionId" | "taskId" | "taskDisplayId" | "taskName" | "debugTrace"
  >,
): GoatChatMessageMetadata | undefined {
  const task =
    message.taskId && message.taskName && message.taskDisplayId
      ? {
          id: message.taskId,
          displayId: message.taskDisplayId,
          title: message.taskName,
        }
      : null;
  const error = message.debugTrace?.error;

  if (!message.sessionId && !task && !error) return undefined;
  return {
    sessionId: message.sessionId,
    ...(task ? { task } : {}),
    ...(error ? { error } : {}),
  };
}

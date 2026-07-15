import type { UIMessage } from "ai";

// Local mirror of the metadata the Goat server attaches to chat messages
// (apps/goat/lib/chat-ui.ts GoatChatMessageMetadata). Only the fields the
// mobile client renders are typed; unknown fields pass through untouched.
export type GoatMobileMessageMetadata = {
  sessionId?: string;
  taskId?: string;
  task?: {
    id: string;
    displayId?: string | null;
    title?: string | null;
    status?: string | null;
  } | null;
  timing?: {
    createdAt?: string;
    updatedAt?: string;
    durationMs?: number;
  };
  contextTokens?: number;
  error?: string;
  aborted?: boolean;
};

export type GoatMobileUiMessage = UIMessage<GoatMobileMessageMetadata>;

export type GoatSessionSummary = {
  id: string;
  title: string;
  model: string;
  engine: string;
  updatedAt: string;
  pinnedAt: string | null;
};

export type GoatChatView = {
  id: string;
  title: string;
  model: string;
  engine: string;
  messages: GoatMobileUiMessage[];
};

export function textFromMessage(message: GoatMobileUiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

// Human labels for tool invocations arriving in the stream as `tool-*` parts.
const TOOL_LABELS: Record<string, { active: string; done: string }> = {
  web_search: { active: "Searching the web", done: "Searched the web" },
  goat_brain: { active: "Reading the brain", done: "Read the brain" },
  save_to_brain: { active: "Saving to the brain", done: "Saved to the brain" },
  start_task: { active: "Starting a task", done: "Started a task" },
  schedule_task: { active: "Scheduling a task", done: "Scheduled a task" },
  edit_task_schedule: { active: "Updating a schedule", done: "Updated a schedule" },
  delete_task_schedule: { active: "Deleting a schedule", done: "Deleted a schedule" },
};

export function toolLabel(partType: string, done: boolean): string {
  const name = partType.replace(/^tool-/, "");
  const labels = TOOL_LABELS[name];
  if (labels) return done ? labels.done : `${labels.active}…`;
  const readable = name.replace(/_/g, " ");
  return done ? `Ran ${readable}` : `Running ${readable}…`;
}

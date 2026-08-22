import {
  ACTION_TOOL_CONTRACT,
  type ActionExecutionResponse,
  type ActionGatewayResponse,
  CHAT_ARTIFACT_DATA_PART_TYPE,
  type CodexCommandToolInput,
  type CodexCommandToolOutput,
  type PublishedChatArtifact,
  parsePublishedChatArtifact,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { BrowserToolName } from "@opencompany/browser-tools";
import type { ConversationRuntimeStatus } from "@opencompany/core";
import type {
  ChatAttachmentKind,
  ChatEngine,
  ChatMessage,
  HarnessEngine,
  TaskStatus,
} from "@opencompany/db/product-schema";
import type { UIMessage } from "ai";
import type {
  ActionApprovalView,
  ActionErrorCode,
  ActionSourceDescriptor,
  ActionSourceId,
} from "./actions/types";
import { finiteDurationMs } from "./chat-timing";
import type { CodexComposerSettingsView } from "./codex-chat-settings";

export {
  CODEX_APPROVAL_TOOL_NAME,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_COMMAND_TOOL_PART_TYPE,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_GOAL_TOOL_NAME,
  CODEX_MCP_TOOL_NAME,
  CODEX_PLAN_TOOL_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_NAME,
  CODEX_SUBAGENT_TOOL_PART_TYPE,
  CODEX_WEB_SEARCH_TOOL_NAME,
  type CodexCommandToolInput,
  type CodexCommandToolOutput,
} from "@opencompany/agent-runtime";

export const START_TASK_TOOL_NAME = "start_task";
export const START_TASK_TOOL_PART_TYPE = `tool-${START_TASK_TOOL_NAME}` as const;
export const START_WORKFLOW_TOOL_NAME = "start_workflow";
export const START_WORKFLOW_TOOL_PART_TYPE = `tool-${START_WORKFLOW_TOOL_NAME}` as const;
export const SCHEDULE_TASK_TOOL_NAME = "schedule_task";
export const SCHEDULE_TASK_TOOL_PART_TYPE = `tool-${SCHEDULE_TASK_TOOL_NAME}` as const;
export const EDIT_TASK_SCHEDULE_TOOL_NAME = "edit_task_schedule";
export const EDIT_TASK_SCHEDULE_TOOL_PART_TYPE = `tool-${EDIT_TASK_SCHEDULE_TOOL_NAME}` as const;
export const DELETE_TASK_SCHEDULE_TOOL_NAME = "delete_task_schedule";
export const DELETE_TASK_SCHEDULE_TOOL_PART_TYPE =
  `tool-${DELETE_TASK_SCHEDULE_TOOL_NAME}` as const;
export const BRAIN_TOOL_NAME = "goat_brain";
export const BRAIN_TOOL_PART_TYPE = `tool-${BRAIN_TOOL_NAME}` as const;
export const SAVE_TO_BRAIN_TOOL_NAME = "save_to_brain";
export const SAVE_TO_BRAIN_TOOL_PART_TYPE = `tool-${SAVE_TO_BRAIN_TOOL_NAME}` as const;
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const WEB_FETCH_TOOL_PART_TYPE = `tool-${WEB_FETCH_TOOL_NAME}` as const;
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_TOOL_PART_TYPE = `tool-${WEB_SEARCH_TOOL_NAME}` as const;
export const LIST_ACTIONS_TOOL_NAME = ACTION_TOOL_CONTRACT.list.name;
export const LIST_ACTIONS_TOOL_PART_TYPE = `tool-${LIST_ACTIONS_TOOL_NAME}` as const;
export const USE_ACTION_TOOL_NAME = ACTION_TOOL_CONTRACT.execute.name;
export const USE_ACTION_TOOL_PART_TYPE = `tool-${USE_ACTION_TOOL_NAME}` as const;
export const SEND_USER_MESSAGE_TOOL_NAME = "send_user_message";
export const SEND_USER_MESSAGE_TOOL_PART_TYPE = `tool-${SEND_USER_MESSAGE_TOOL_NAME}` as const;
export const LIST_SKILLS_TOOL_NAME = "list_skills";
export const LIST_SKILLS_TOOL_PART_TYPE = `tool-${LIST_SKILLS_TOOL_NAME}` as const;
export const USE_SKILL_TOOL_NAME = "use_skill";
export const USE_SKILL_TOOL_PART_TYPE = `tool-${USE_SKILL_TOOL_NAME}` as const;
export const READ_SKILL_FILE_TOOL_NAME = "read_skill_file";
export const READ_SKILL_FILE_TOOL_PART_TYPE = `tool-${READ_SKILL_FILE_TOOL_NAME}` as const;
export const BROWSER_USE_PROFILE_TOOL_NAME = "browser_use_profile";
export const BROWSER_USE_PROFILE_TOOL_PART_TYPE = `tool-${BROWSER_USE_PROFILE_TOOL_NAME}` as const;
export const BROWSER_OPEN_TOOL_PART_TYPE = "tool-browser_open";
export const BROWSER_SNAPSHOT_TOOL_PART_TYPE = "tool-browser_snapshot";
export const BROWSER_CLICK_TOOL_PART_TYPE = "tool-browser_click";
export const BROWSER_FILL_TOOL_PART_TYPE = "tool-browser_fill";
export const BROWSER_WAIT_TOOL_PART_TYPE = "tool-browser_wait";
export const BROWSER_READ_TOOL_PART_TYPE = "tool-browser_read";
export const BROWSER_GET_TOOL_PART_TYPE = "tool-browser_get";
export const BROWSER_FIND_TOOL_PART_TYPE = "tool-browser_find";
export const BROWSER_SCROLL_TOOL_PART_TYPE = "tool-browser_scroll";
export const BROWSER_SCREENSHOT_TOOL_PART_TYPE = "tool-browser_screenshot";
export const BROWSER_CLOSE_TOOL_PART_TYPE = "tool-browser_close";
export type BrowserToolPartType = `tool-${BrowserToolName}`;
export type BrowserToolInput = Record<string, unknown>;
export type BrowserToolOutput = {
  ok: boolean;
  command: BrowserToolName;
  output?: string;
  stderr?: string;
  snapshot?: unknown;
  screenshotUrl?: string;
  compacted?: boolean;
  originalOutputChars?: number;
  browserObservationBudget?: Record<string, number>;
  error?: string;
};

export type BrowserProfileCatalogItem = {
  id: string;
  name: string;
  siteHost: string;
};

export type BrowserUseProfileToolInput = {
  profile: string;
  reason: string;
};

export type BrowserUseProfileToolOutput = {
  ok: boolean;
  profile?: BrowserProfileCatalogItem;
  liveViewUrl?: string;
  message?: string;
  error?: string;
};

export type TaskCardMetadata = {
  id: string;
  displayId?: string | null;
  title?: string | null;
  status?: TaskStatus | null;
};

export type ChatMention =
  | {
      kind: "engine";
      id: "codex" | "claude";
    }
  | {
      // `id` is the workspace-scoped skill slug (the @skill/<id> handle).
      kind: "skill";
      id: string;
    }
  | {
      // `id` is the workspace-scoped workflow slug (the # handle).
      kind: "workflow";
      id: string;
    };

// Attachment view riding on user-message metadata. The blob fields are only
// present client → server on submit (the server re-validates them); server →
// client rehydration strips them — the client fetches bytes through
// /v1/chat-attachments/{messageId}/{attachmentId} instead.
export type ChatUiAttachment = {
  id: string;
  kind: ChatAttachmentKind;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  blobUrl?: string;
  blobPathname?: string;
  // Local object URL for the optimistic (not-yet-persisted) message render;
  // never persisted and ignored by the server.
  previewUrl?: string;
};

export type ChatMessageMetadata = {
  sessionId?: string;
  runId?: string;
  model?: string;
  scheduledWakeup?: {
    reason: string;
    dueAt: string;
  };
  mentions?: ChatMention[];
  attachments?: ChatUiAttachment[];
  taskId?: string;
  task?: TaskCardMetadata | null;
  timing?: {
    createdAt?: string;
    updatedAt?: string;
    durationMs?: number;
  };
  // Approximate context-window occupancy after this turn (input + output tokens of
  // the final model call), used to render the chat header's context meter.
  contextTokens?: number;
  error?: string;
  aborted?: boolean;
};

export type StartTaskToolInput = {
  prompt: string;
  name: string;
  engine?: HarnessEngine;
  model?: AgentModelId;
  reason?: string;
};

export type StartTaskToolOutput = {
  taskId: string;
  taskDisplayId: string;
  taskName: string;
  status: "queued" | "already_started";
  prompt: string;
};

export type ChatWorkflowCatalogItem = {
  id: string;
  name: string;
  description: string;
};

export type StartWorkflowToolInput = {
  workflowId: string;
  prompt: string;
};

export type StartWorkflowToolOutput = StartTaskToolOutput;

export type ScheduleTaskToolInput = {
  prompt: string;
  name: string;
  cron: string;
  timezone?: string;
  sourceDescription?: string;
  reason?: string;
};

export type ScheduleTaskToolOutput = {
  scheduleId: string;
  scheduleName: string;
  cron: string;
  timezone: string;
  nextRunAt: string;
  prompt: string;
  status: "scheduled";
};

export type EditTaskScheduleToolInput = {
  scheduleId?: string;
  scheduleName?: string;
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  sourceDescription?: string;
  reason?: string;
};

export type EditTaskScheduleToolOutput =
  | {
      ok: true;
      scheduleId: string;
      scheduleName: string;
      cron: string;
      timezone: string;
      nextRunAt: string;
      status: "updated";
    }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    };

export type DeleteTaskScheduleToolInput = {
  scheduleId?: string;
  scheduleName?: string;
  reason?: string;
};

export type DeleteTaskScheduleToolOutput =
  | {
      ok: true;
      scheduleId: string;
      scheduleName: string;
      status: "deleted";
    }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    };

export type BrainCliCommand =
  | "help"
  | "create"
  | "list"
  | "get"
  | "timeline"
  | "query"
  | "append-evidence"
  | "rewrite"
  | "set"
  | "alias"
  | "timeline-add"
  | "append-timeline"
  | "link"
  | "merge"
  | "move"
  | "delete"
  | "folder"
  | "doctor";

export type BrainToolFlagValue = string | number | boolean | string[];

export type BrainToolInput = {
  command: BrainCliCommand;
  flags?: Record<string, BrainToolFlagValue>;
  stdin?: string;
};

export type BrainToolOutput = {
  ok: boolean;
  brainRef?: string;
  exitCode: number | null;
  stdout?: string;
  stderr: string;
  command?: string;
  argv?: string[];
  parsed?: unknown;
  error?: string;
  traceId?: string;
  tracePath?: string;
  durationMs?: number;
};

export type SaveToBrainToolInput = {
  // Text to capture; optional when attachmentIds carry the payload.
  content?: string;
  title?: string;
  intent?: string;
  sourceRef?: string;
  integrationId?: string;
  fallbackContent?: string;
  // Ids of files attached in this conversation to file as brain assets.
  attachmentIds?: string[];
};

export type SaveToBrainToolOutput =
  | {
      ok: true;
      status: "captured" | "already_captured" | "paused_by_plan";
      message?: string;
      // Text capture result (absent for attachment-only saves).
      draftId?: string;
      path?: string;
      title?: string;
      // Attachment capture results (absent for text-only saves).
      assets?: Array<{ documentId: string; path: string; title: string }>;
    }
  | {
      ok: false;
      error: string;
    };

export type SendUserMessageToolInput = {
  message: string;
};

export type SendUserMessageToolOutput =
  | { ok: true; delivered: true }
  | { ok: false; error: string };

export type WebSearchToolInput = {
  query: string;
  recencyDays?: 7 | 30 | 90;
};

export type WebFetchToolInput = {
  url: string;
};

export type WebFetchToolOutput =
  | {
      ok: true;
      url: string;
      title?: string;
      author?: string;
      publishedDate?: string;
      text: string;
      truncated?: boolean;
      requestId?: string;
      costUsdMicros?: number;
    }
  | {
      ok: false;
      error: string;
    };

export type WebSearchToolResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
};

export type WebSearchToolOutput =
  | {
      ok: true;
      query: string;
      searchedAt: string;
      results: WebSearchToolResult[];
      requestId?: string;
      costUsdMicros?: number;
    }
  | {
      ok: false;
      error: string;
    };

export type ChatActionCatalog = {
  sources: ActionSourceDescriptor[];
  actions: {
    id: string;
    source: ActionSourceId;
    description: string;
    params: unknown;
    // "ask" actions pause on a tool-approval request the user answers in chat;
    // "off" actions never reach the catalog.
    permissionMode: "on" | "ask";
  }[];
};

export type ListActionsToolInput = {
  source?: ActionSourceId;
};

export type ListActionsToolOutput =
  | Extract<ActionGatewayResponse, { ok: true; sources: unknown }>
  | Extract<ActionGatewayResponse, { ok: false }>
  | {
      ok: true;
      source: ActionSourceDescriptor;
      actions: ChatActionCatalog["actions"];
    }
  | {
      ok: false;
      error: {
        code: "unknown_source";
        message: string;
        availableSources: ActionSourceId[];
      };
    };

export type UseActionToolInput = {
  action: string;
  params?: Record<string, unknown>;
};

export type UseActionToolOutput = ActionExecutionResponse<
  ActionSourceId,
  ActionErrorCode,
  ActionApprovalView
>;

export type ChatSkillCatalogItem = {
  id: string;
  name: string;
  description: string;
};

export type ListSkillsToolInput = {
  query?: string;
};

export type ListSkillsToolOutput = {
  ok: true;
  skills: ChatSkillCatalogItem[];
  total: number;
  truncated: boolean;
};

export type UseSkillToolInput = {
  skill: string;
};

export type UseSkillToolOutput =
  | {
      ok: true;
      skill: ChatSkillCatalogItem & {
        instructions: string;
      };
    }
  | {
      ok: false;
      skill: string;
      error: {
        code: "invalid_params" | "unavailable" | "already_loaded" | "call_budget";
        message: string;
      };
    };

export type ReadSkillFileToolInput = {
  skill: string;
  path: string;
  offset?: number;
  maxBytes?: number;
};

export type ReadSkillFileToolOutput = {
  path: string;
  executable: boolean;
  sizeBytes: number;
  offset: number;
  nextOffset: number;
  eof: boolean;
  encoding: "utf8" | "base64";
  content: string;
};

type BrowserChatTools = {
  [Name in BrowserToolName]: {
    input: BrowserToolInput;
    output: BrowserToolOutput;
  };
};

export type ChatTools = {
  start_task: {
    input: StartTaskToolInput;
    output: StartTaskToolOutput;
  };
  start_workflow: {
    input: StartWorkflowToolInput;
    output: StartWorkflowToolOutput;
  };
  schedule_task: {
    input: ScheduleTaskToolInput;
    output: ScheduleTaskToolOutput;
  };
  edit_task_schedule: {
    input: EditTaskScheduleToolInput;
    output: EditTaskScheduleToolOutput;
  };
  delete_task_schedule: {
    input: DeleteTaskScheduleToolInput;
    output: DeleteTaskScheduleToolOutput;
  };
  goat_brain: {
    input: BrainToolInput;
    output: BrainToolOutput;
  };
  save_to_brain: {
    input: SaveToBrainToolInput;
    output: SaveToBrainToolOutput;
  };
  web_fetch: {
    input: WebFetchToolInput;
    output: WebFetchToolOutput;
  };
  web_search: {
    input: WebSearchToolInput;
    output: WebSearchToolOutput;
  };
  list_actions: {
    input: ListActionsToolInput;
    output: ListActionsToolOutput;
  };
  use_action: {
    input: UseActionToolInput;
    output: UseActionToolOutput;
  };
  send_user_message: {
    input: SendUserMessageToolInput;
    output: SendUserMessageToolOutput;
  };
  list_skills: {
    input: ListSkillsToolInput;
    output: ListSkillsToolOutput;
  };
  use_skill: {
    input: UseSkillToolInput;
    output: UseSkillToolOutput;
  };
  read_skill_file: {
    input: ReadSkillFileToolInput;
    output: ReadSkillFileToolOutput;
  };
  codex_command: {
    input: CodexCommandToolInput;
    output: CodexCommandToolOutput;
  };
} & BrowserChatTools;

export type ChatDataTypes = {
  "artifact-file": PublishedChatArtifact;
};

export type ChatUiMessage = UIMessage<ChatMessageMetadata, ChatDataTypes, ChatTools>;

export function listedActionSourceIdsFromMessages(
  messages: readonly ChatUiMessage[],
): ActionSourceId[] {
  const sourceIds = new Set<ActionSourceId>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === LIST_ACTIONS_TOOL_PART_TYPE &&
        part.state === "output-available" &&
        part.output.ok &&
        "source" in part.output
      ) {
        sourceIds.add(part.output.source.id);
      }
    }
  }
  return [...sourceIds];
}

export function listedSkillIdsFromMessages(messages: readonly ChatUiMessage[]): string[] {
  const skillIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === LIST_SKILLS_TOOL_PART_TYPE &&
        part.state === "output-available" &&
        part.output.ok
      ) {
        for (const skill of part.output.skills) skillIds.add(skill.id);
      }
    }
  }
  return [...skillIds];
}

export function usedSkillIdsFromMessages(messages: readonly ChatUiMessage[]): string[] {
  const skillIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === USE_SKILL_TOOL_PART_TYPE &&
        part.state === "output-available" &&
        part.output.ok
      ) {
        skillIds.add(part.output.skill.id);
      }
    }
  }
  return [...skillIds];
}

export type ChatSessionView = {
  id: string;
  title: string;
  model: AgentModelId;
  engine?: ChatEngine;
  codexComposerSettings?: CodexComposerSettingsView | null;
  runtime?: ConversationRuntimeView | null;
  activityState?: "working" | "idle";
  hasUnseen?: boolean;
  updatedAt?: string;
  messages: ChatUiMessage[];
};

export type ConversationRuntimeView = {
  status: ConversationRuntimeStatus;
  activeRunId: string | null;
  hasError: boolean;
  updatedAt: string;
};

export type ChatState = "working" | "done_unseen" | "done_seen";

export type ChatSummaryView = {
  id: string;
  title: string;
  model: AgentModelId;
  engine?: ChatEngine;
  codexComposerSettings?: CodexComposerSettingsView | null;
  runtime?: ConversationRuntimeView | null;
  activityState?: "working" | "idle";
  hasUnseen?: boolean;
  // Compatibility fallback for optimistic and rolling-deploy snapshots. Live API rows own
  // activityState/hasUnseen and always take precedence.
  state?: ChatState;
  preview: string;
  updatedAt: string;
  lastSeenAt?: string | null;
  pinnedAt?: string | null;
  archived?: boolean;
};

export const PINNED_CHAT_LIMIT = 20;

export function chatSummaryState(
  chat: Pick<ChatSummaryView, "activityState" | "hasUnseen" | "state">,
): ChatState {
  if (chat.activityState === "working") return "working";
  if (chat.activityState === "idle") return chat.hasUnseen ? "done_unseen" : "done_seen";
  return chat.state ?? "done_seen";
}

export function isChatRuntimeActive(
  runtime: { status?: string | null; activeRunId?: string | null } | null | undefined,
): boolean {
  if (
    runtime?.status === "queued" ||
    runtime?.status === "starting" ||
    runtime?.status === "running"
  ) {
    return true;
  }
  if (!runtime?.activeRunId) return false;
  return (
    runtime.status !== "failed" && runtime.status !== "interrupted" && runtime.status !== "closed"
  );
}

export type StoredChatMessage = Pick<
  ChatMessage,
  | "id"
  | "sessionId"
  | "role"
  | "content"
  | "taskId"
  | "debugTrace"
  | "attachments"
  | "attachmentTexts"
  | "createdAt"
  | "updatedAt"
> & {
  taskDisplayId: string | null;
  taskName: string | null;
  taskPrompt: string | null;
  taskStatus: TaskStatus | null;
};

export type ChatMessageOrderInput = {
  id: string;
  role: "user" | "assistant";
  createdAt: Date | string;
};

export function compareChatMessageOrder(left: ChatMessageOrderInput, right: ChatMessageOrderInput) {
  const timeDiff = chatMessageCreatedAtMs(left.createdAt) - chatMessageCreatedAtMs(right.createdAt);
  if (timeDiff !== 0) return timeDiff;

  const roleDiff = chatMessageRoleOrder(left.role) - chatMessageRoleOrder(right.role);
  if (roleDiff !== 0) return roleDiff;

  return left.id.localeCompare(right.id);
}

export function nextChatMessageCreatedAt(createdAt: Date) {
  return new Date(createdAt.getTime() + 1);
}

export function emptyAssistantDebugTrace(model: string) {
  return {
    schemaVersion: "goat.codex_chat.debug.v1" as const,
    model,
    uiMessageParts: [],
  };
}

export function textFromChatUiMessage(message: Pick<ChatUiMessage, "parts">) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

export function replaceChatUiMessageText(message: ChatUiMessage, text: string): ChatUiMessage {
  let replaced = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "text") return part;
    if (replaced) return { ...part, text: "" };
    replaced = true;
    return { ...part, text };
  });
  return {
    ...message,
    parts: replaced ? parts : [{ type: "text", text }, ...parts],
  };
}

export function toChatUiMessage(message: StoredChatMessage): ChatUiMessage {
  const metadata = toChatMessageMetadata(message);
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    ...(metadata ? { metadata } : {}),
    parts: toChatUiMessageParts(message, metadata),
  };
}

export function toChatMessageMetadata(
  message: Pick<
    StoredChatMessage,
    | "sessionId"
    | "taskId"
    | "taskDisplayId"
    | "taskName"
    | "taskStatus"
    | "debugTrace"
    | "attachments"
    | "createdAt"
    | "updatedAt"
  >,
): ChatMessageMetadata | undefined {
  const task =
    message.taskId && message.taskName && message.taskDisplayId
      ? {
          id: message.taskId,
          displayId: message.taskDisplayId,
          title: message.taskName,
          status: message.taskStatus,
        }
      : null;
  const error = message.debugTrace?.error;
  const model = message.debugTrace?.model;
  const scheduledWakeup = message.debugTrace?.scheduledWakeup;
  const aborted = message.debugTrace?.aborted === true;
  const timing = toChatMessageTiming(message);
  const attachments = toChatUiAttachments(message.attachments);
  const contextTokens = chatContextTokensFromUsage(message.debugTrace?.usage);

  if (
    !message.sessionId &&
    !model &&
    !scheduledWakeup &&
    !message.taskId &&
    !task &&
    !timing &&
    contextTokens === undefined &&
    !error &&
    !aborted &&
    !attachments
  ) {
    return undefined;
  }
  return {
    sessionId: message.sessionId,
    ...(model ? { model } : {}),
    ...(scheduledWakeup ? { scheduledWakeup } : {}),
    ...(attachments ? { attachments } : {}),
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(task ? { task } : {}),
    ...(timing ? { timing } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(error ? { error } : {}),
    ...(aborted ? { aborted } : {}),
  };
}

// Strips the private blob fields: the client fetches bytes through the
// auth-scoped attachment route, never from the blob store directly.
function toChatUiAttachments(
  attachments: StoredChatMessage["attachments"],
): ChatUiAttachment[] | null {
  if (!attachments || attachments.length === 0) return null;
  return attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
  }));
}

export function chatContextTokensFromUsage(
  usage:
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | null
    | undefined,
): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
  const sum = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return sum > 0 ? sum : undefined;
}

function toChatMessageTiming(
  message: Pick<StoredChatMessage, "createdAt" | "updatedAt" | "debugTrace">,
) {
  const createdAt = serializeChatMessageTimestamp(message.createdAt);
  const updatedAt = serializeChatMessageTimestamp(message.updatedAt);
  const durationMs = finiteDurationMs(message.debugTrace?.durationMs);
  if (!createdAt && !updatedAt && durationMs === null) return null;
  return {
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
}

function serializeChatMessageTimestamp(value: Date | string) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toChatUiMessageParts(
  message: StoredChatMessage,
  metadata: ChatMessageMetadata | undefined,
): ChatUiMessage["parts"] {
  if (message.role !== "assistant") return textParts(message.content);

  const persistedParts = parseDebugTraceUiMessageParts(message.debugTrace?.uiMessageParts);
  if (persistedParts) return withStoredContentFallback(persistedParts, message.content);

  const legacyTaskParts = legacyTaskOrderedParts(message, metadata?.task ?? null);
  if (legacyTaskParts) return legacyTaskParts;

  return textParts(message.content);
}

function textParts(content: string): ChatUiMessage["parts"] {
  return content ? [{ type: "text", text: content }] : [];
}

function withStoredContentFallback(
  parts: ChatUiMessage["parts"],
  content: string,
): ChatUiMessage["parts"] {
  if (!content || parts.some((part) => part.type === "text" && part.text.trim())) return parts;
  return [...parts, { type: "text", text: content }];
}

function parseDebugTraceUiMessageParts(value: unknown): ChatUiMessage["parts"] | null {
  if (!Array.isArray(value)) return null;

  const parts: ChatUiMessage["parts"] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      parts.push({ type: "reasoning", text: part.text, state: "done" });
      continue;
    }
    if (part.type === CHAT_ARTIFACT_DATA_PART_TYPE) {
      const artifact = parsePublishedChatArtifact({ ok: true, artifact: part.data });
      if (artifact) parts.push({ type: CHAT_ARTIFACT_DATA_PART_TYPE, data: artifact });
      continue;
    }
    if (isPersistedToolPart(part)) {
      parts.push(part as ChatUiMessage["parts"][number]);
    }
  }

  return parts.length > 0 ? parts : null;
}

function isPersistedToolPart(value: Record<string, unknown>) {
  return (
    typeof value.type === "string" &&
    (value.type === "dynamic-tool" || value.type.startsWith("tool-"))
  );
}

// ---------------------------------------------------------------------------
// Tool-approval part surgery. These operate on the raw persisted uiMessageParts
// (debug_trace) so both the chat route and the turn store can use them without
// round-tripping through UIMessage types.

export const APPROVAL_DISMISSED_REASON = "The user did not respond to the approval request.";
export const INCOMPLETE_TOOL_CALL_REASON =
  "The turn ended before the tool returned a result, so its outcome is unknown.";

type RawApprovalPart = Record<string, unknown> & {
  toolCallId: string;
  approval: { id: string };
};

function asPendingApprovalPart(value: unknown): RawApprovalPart | null {
  if (!isRecord(value) || value.type !== USE_ACTION_TOOL_PART_TYPE) return null;
  if (value.state !== "approval-requested") return null;
  if (typeof value.toolCallId !== "string") return null;
  const approval = value.approval;
  if (!isRecord(approval) || typeof approval.id !== "string") return null;
  return value as RawApprovalPart;
}

export function pendingApprovalIdsFromStoredParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    const pending = asPendingApprovalPart(part);
    return pending ? [pending.approval.id] : [];
  });
}

// Merges the user's approval decisions from a client-sent copy of the
// assistant message into the stored parts. Only the decision itself
// (approved/reason) is taken from the client — input, output, and everything
// else stay as recorded, so a tampered client cannot change what was approved.
// Pending approvals the client did not answer are denied as dismissed, keeping
// the history convertible for the model.
export function applyApprovalResponsesToStoredParts(
  storedParts: unknown,
  clientParts: unknown,
): {
  parts: unknown[];
  respondedApprovals: Array<{
    approvalId: string;
    toolCallId: string;
    action: string;
    approved: boolean;
  }>;
} {
  const parts = Array.isArray(storedParts) ? storedParts : [];
  const decisions = new Map<string, { approved: boolean; reason?: string }>();
  if (Array.isArray(clientParts)) {
    for (const part of clientParts) {
      if (!isRecord(part) || part.type !== USE_ACTION_TOOL_PART_TYPE) continue;
      if (part.state !== "approval-responded") continue;
      const approval = part.approval;
      if (!isRecord(approval)) continue;
      if (typeof approval.id !== "string" || typeof approval.approved !== "boolean") continue;
      decisions.set(approval.id, {
        approved: approval.approved,
        ...(typeof approval.reason === "string" && approval.reason
          ? { reason: approval.reason }
          : {}),
      });
    }
  }

  const respondedApprovals: Array<{
    approvalId: string;
    toolCallId: string;
    action: string;
    approved: boolean;
  }> = [];
  const merged = parts.map((part) => {
    const pending = asPendingApprovalPart(part);
    if (!pending) return part;
    const decision = decisions.get(pending.approval.id);
    if (!decision) {
      return {
        ...pending,
        state: "output-denied",
        approval: {
          id: pending.approval.id,
          approved: false,
          reason: APPROVAL_DISMISSED_REASON,
        },
      };
    }
    const input = isRecord(pending.input) ? pending.input : {};
    respondedApprovals.push({
      approvalId: pending.approval.id,
      toolCallId: pending.toolCallId,
      action: typeof input.action === "string" ? input.action : "",
      approved: decision.approved,
    });
    return {
      ...pending,
      state: "approval-responded",
      approval: { id: pending.approval.id, ...decision },
    };
  });
  return { parts: merged, respondedApprovals };
}

// A user message sent while approvals were still pending dismisses them: the
// model cannot resume a turn the user talked past, and an unresolved approval
// request would make the history unconvertible (a tool call with no result).
export function dismissPendingApprovalsInStoredParts(parts: unknown): {
  parts: unknown[];
  changed: boolean;
  toolCallIds: string[];
} {
  if (!Array.isArray(parts)) return { parts: [], changed: false, toolCallIds: [] };
  let changed = false;
  const toolCallIds: string[] = [];
  const dismissed = parts.map((part) => {
    const pending = asPendingApprovalPart(part);
    if (!pending) return part;
    changed = true;
    toolCallIds.push(pending.toolCallId);
    return {
      ...pending,
      state: "output-denied",
      approval: {
        id: pending.approval.id,
        approved: false,
        reason: APPROVAL_DISMISSED_REASON,
      },
    };
  });
  return { parts: dismissed, changed, toolCallIds };
}

// A stopped or failed stream can end after the model emitted a tool call but
// before its executor returned. `convertToModelMessages` requires every
// complete tool call to have a result, so carrying that transient UI state into
// a later turn poisons the session. Preserve calls with complete inputs as
// explicit errors; drop input-streaming parts because their partial input is
// not a valid model-visible tool call.
export function settleIncompleteToolCallsInStoredParts(parts: unknown): {
  parts: unknown[];
  changed: boolean;
  toolCallIds: string[];
} {
  if (!Array.isArray(parts)) return { parts: [], changed: false, toolCallIds: [] };
  let changed = false;
  const toolCallIds: string[] = [];
  const settled: unknown[] = [];

  for (const part of parts) {
    if (
      !isRecord(part) ||
      !isPersistedToolPart(part) ||
      typeof part.toolCallId !== "string" ||
      (part.state !== "input-streaming" && part.state !== "input-available")
    ) {
      settled.push(part);
      continue;
    }

    changed = true;
    toolCallIds.push(part.toolCallId);
    if (part.state === "input-streaming") continue;

    const { approval: _approval, output: _output, ...call } = part;
    settled.push({
      ...call,
      state: "output-error",
      errorText: INCOMPLETE_TOOL_CALL_REASON,
    });
  }

  return { parts: settled, changed, toolCallIds };
}

function chatMessageCreatedAtMs(value: Date | string) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function chatMessageRoleOrder(role: "user" | "assistant") {
  return role === "user" ? 0 : 1;
}

function legacyTaskOrderedParts(
  message: StoredChatMessage,
  task: TaskCardMetadata | null,
): ChatUiMessage["parts"] | null {
  const output = legacyStartTaskOutput(message, task);
  if (!output) return null;

  const part = {
    type: START_TASK_TOOL_PART_TYPE,
    toolCallId: `persisted-${output.taskId}`,
    state: "output-available",
    input: legacyStartTaskInput(message, output),
    output,
  } as ChatUiMessage["parts"][number];

  const split = splitTaskContentAroundTaskNotice(message.content);
  if (!split) return [...textParts(message.content), part];

  const parts: ChatUiMessage["parts"] = [];
  if (split.before) parts.push({ type: "text", text: split.before });
  parts.push(part);
  if (split.after) parts.push({ type: "text", text: split.after });
  return parts;
}

function legacyStartTaskOutput(
  message: StoredChatMessage,
  task: TaskCardMetadata | null,
): StartTaskToolOutput | null {
  const toolResults = message.debugTrace?.toolResults;
  if (Array.isArray(toolResults)) {
    for (const result of toolResults) {
      const output = isRecord(result) && isRecord(result.output) ? result.output : result;
      if (isStartTaskToolOutput(output)) return output;
    }
  }

  if (!task) return null;
  return {
    taskId: task.id,
    taskDisplayId: task.displayId ?? task.id,
    taskName: task.title ?? "Task",
    status: "queued",
    prompt: message.taskPrompt ?? "",
  };
}

function legacyStartTaskInput(
  message: StoredChatMessage,
  output: StartTaskToolOutput,
): StartTaskToolInput {
  const toolCalls = message.debugTrace?.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const input = isRecord(call.input) ? call.input : isRecord(call.args) ? call.args : null;
      if (!input) continue;
      const prompt = typeof input.prompt === "string" ? input.prompt : output.prompt;
      const name = typeof input.name === "string" ? input.name : output.taskName;
      const reason = typeof input.reason === "string" ? input.reason : undefined;
      return {
        prompt,
        name,
        ...(reason ? { reason } : {}),
      };
    }
  }

  return {
    prompt: output.prompt || message.taskPrompt || "",
    name: output.taskName,
  };
}

function splitTaskContentAroundTaskNotice(content: string) {
  const match = /\s*added to (?:Tasks|Results)\b/i.exec(content);
  if (!match) return null;

  return {
    before: content.slice(0, match.index).trim(),
    after: content.slice(match.index).trim(),
  };
}

function isStartTaskToolOutput(value: unknown): value is StartTaskToolOutput {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === "string" &&
    typeof value.taskDisplayId === "string" &&
    typeof value.taskName === "string" &&
    (value.status === "queued" || value.status === "already_started") &&
    typeof value.prompt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

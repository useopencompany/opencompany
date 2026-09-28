import type {
  ConversationDto,
  CreateMessageBody,
  CreateTaskCommentBody,
  ResolveApprovalBody,
  RunDto,
  TaskDto,
} from "@opencompany/protocol/schemas";
import type { ChatMessage, ChatPart } from "../chat";
import type { ChatModelId, ComposerAttachment } from "../chat-composer-context";

export const NEW_CHAT_ID = "new";

export interface ChatPartition {
  userId: string;
  workspaceId: string;
  signal?: AbortSignal;
}

export interface StoredTask {
  id: string;
  displayId: string;
  status: TaskDto["status"];
}

export interface StoredConversation {
  id: string;
  kind: "chat" | "task";
  title: string;
  engine: ConversationDto["engine"];
  model: string;
  runtime: ConversationDto["runtime"];
  updatedAt: string;
  lastViewedAt: number;
  provisional: boolean;
  pinnedAt: string | null;
  /** Listed by the last complete sidebar refresh. Archived and deleted conversations are not. */
  inSidebar: boolean;
  activityState: ConversationDto["activityState"];
  hasUnseen: boolean;
  awaitingInput: boolean;
  task: StoredTask | null;
  /** A message is still in the outbox, or a Run this device knows about has not settled. */
  hasLocalWork: boolean;
  /** A message typed on this device has not reached the server yet. */
  hasQueuedMessages: boolean;
}

export interface StoredDraft {
  conversationId: string;
  text: string;
  modelId: ChatModelId;
  attachments: ComposerAttachment[];
}

export type OutboxKind = "stop" | "approval" | "message";
export type OutboxStatus = "queued" | "in_flight";

export interface CommandBase {
  id: string;
  status: OutboxStatus;
  conversationId: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

interface MessageCommandBase extends CommandBase {
  kind: "message";
  clientMessageId: string;
  idempotencyKey: string;
}

export type MessageCommand =
  | (MessageCommandBase & {
      target: "chat";
      intent: { content: string; model: string; isNewConversation: boolean };
      frozenBody: CreateMessageBody | null;
    })
  | (MessageCommandBase & {
      // A reply to a Task goes through its comment endpoint, which keeps the Task's engine and
      // model and queues behind a Run that is still working.
      target: "task";
      intent: { content: string; taskId: string };
      frozenBody: CreateTaskCommentBody | null;
    });

export type OutboxCommand =
  | MessageCommand
  | (CommandBase & { kind: "stop"; runId: string })
  | (CommandBase & {
      kind: "approval";
      runId: string;
      approvalId: string;
      body: ResolveApprovalBody;
    });

export interface RunCheckpoint {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  status: RunDto["status"];
  content: string;
  parts: ChatPart[];
  cursor: string | null;
  presentationCursor: string | null;
  isStopping: boolean;
}

export interface DraftRow {
  conversation_id: string;
  text: string;
  model_id: ChatModelId;
}

export interface AttachmentRow {
  local_id: string;
  conversation_id: string;
  uri: string;
  kind: "image" | "file";
  filename: string;
  media_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  upload_generation: number;
  server_attachment_id: string | null;
  expires_at: string | null;
}

export interface ConversationRow {
  local_id: string;
  kind: "chat" | "task";
  title: string;
  engine: ConversationDto["engine"];
  model: string;
  runtime_json: string | null;
  updated_at: string;
  last_viewed_at: number;
  provisional: number;
  pinned_at: string | null;
  in_sidebar: number;
  activity_state: ConversationDto["activityState"];
  has_unseen: number;
  awaiting_input: number;
  task_id: string | null;
  task_display_id: string | null;
  task_status: TaskDto["status"] | null;
  has_local_work: number;
  has_queued_messages: number;
}

export interface MessageRow {
  local_id: string;
  role: "user" | "assistant";
  content: string;
  parts_json: string;
  delivery: ChatMessage["delivery"];
  created_at: number;
  presentation_revision: string | null;
  presentation_etag: string | null;
}

export interface MessagePresentationCache {
  revision: string | null;
  etag: string | null;
}

export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  status: OutboxStatus;
  conversation_id: string;
  client_message_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  intent_json: string;
  frozen_body_json: string | null;
  idempotency_key: string | null;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
}

export interface CheckpointRow {
  run_id: string;
  conversation_id: string;
  assistant_message_id: string;
  status: RunDto["status"];
  content: string;
  parts_json: string;
  durable_cursor: string | null;
  presentation_cursor: string | null;
  is_stopping: number;
}

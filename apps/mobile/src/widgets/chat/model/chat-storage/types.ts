import type {
  ConversationDto,
  CreateMessageBody,
  ResolveApprovalBody,
  RunDto,
} from "@opencompany/protocol/schemas";
import type { ChatMessage, ChatPart } from "../chat";
import type { ChatModelId, ComposerAttachment } from "../chat-composer-context";

export const NEW_CHAT_ID = "new";

export interface ChatPartition {
  userId: string;
  workspaceId: string;
  signal?: AbortSignal;
}

export interface StoredConversation {
  id: string;
  title: string;
  engine: ConversationDto["engine"];
  model: string;
  runtime: ConversationDto["runtime"];
  updatedAt: string;
  lastViewedAt: number;
  provisional: boolean;
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

export interface MessageCommand extends CommandBase {
  kind: "message";
  clientMessageId: string;
  intent: { content: string; model: string; isNewConversation: boolean };
  frozenBody: CreateMessageBody | null;
  idempotencyKey: string;
}

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
  title: string;
  engine: ConversationDto["engine"];
  model: string;
  runtime_json: string | null;
  updated_at: string;
  last_viewed_at: number;
  provisional: number;
}

export interface MessageRow {
  local_id: string;
  role: "user" | "assistant";
  content: string;
  parts_json: string;
  delivery: ChatMessage["delivery"];
  created_at: number;
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

import {
  type Actor,
  actorHasPermission,
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
} from "./actor";
import { CHAT_ATTACHMENTS_PER_MESSAGE } from "./attachments";

export const CHAT_ENGINES = ["opencompany", "codex", "claude_code"] as const;
export type ChatEngine = (typeof CHAT_ENGINES)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ATTEMPT_STATUSES = [
  "running",
  "completed",
  "failed",
  "canceled",
  "abandoned",
] as const;
export type RunAttemptStatus = (typeof RUN_ATTEMPT_STATUSES)[number];

export const RUN_APPROVAL_STATUSES = ["pending", "resolved", "canceled"] as const;
export type RunApprovalStatus = (typeof RUN_APPROVAL_STATUSES)[number];

export const APPROVAL_RESOLUTIONS = ["approved", "denied", "answered", "canceled"] as const;
export type ApprovalResolution = (typeof APPROVAL_RESOLUTIONS)[number];

export const MAX_APPROVAL_ANSWER_LENGTH = 10_000;

export const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.cancel_requested",
  "message.created",
  "message.content_updated",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "artifact.published",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.canceled",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type Conversation = {
  id: string;
  title: string;
  engine: ChatEngine;
  model: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  attachments: readonly MessageAttachment[];
  createdAt: Date;
  updatedAt: Date;
};

export type MessageAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  kind: "image" | "document" | "audio" | "video" | "other";
};

export type Run = {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  status: RunStatus;
  engine: ChatEngine;
  model: string;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RunAttempt = {
  id: string;
  runId: string;
  number: number;
  status: RunAttemptStatus;
  workerId: string;
  startedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type RunApproval = {
  id: string;
  runId: string;
  attemptId: string | null;
  kind: string;
  prompt: string;
  options: readonly string[] | null;
  status: RunApprovalStatus;
  resolution: ApprovalResolution | null;
  response: Readonly<Record<string, unknown>> | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

export type RunEvent = {
  id: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  type: RunEventType;
  payload: Readonly<Record<string, unknown>>;
  createdAt: Date;
};

export type ConversationPage = {
  conversations: Conversation[];
  nextCursor: string | null;
};

export type MessagePage = {
  messages: Message[];
  nextCursor: string | null;
};

export type CreateMessageCommand = {
  idempotencyKey: string;
  conversationId?: string;
  clientConversationId?: string;
  clientMessageId?: string;
  content: string;
  engine: ChatEngine;
  model: string;
  attachmentIds?: readonly string[];
};

export type CreateMessageResult = {
  conversationId: string;
  messageId: string;
  runId: string;
  transactionId: string;
  idempotentReplay: boolean;
};

export type RunEventPage = {
  events: RunEvent[];
  nextSequence: number;
};

export type WorkerIdentity = {
  workerId: string;
};

export type RunEventDraft = {
  id: string;
  type: RunEventType;
  payload: Readonly<Record<string, unknown>>;
};

// Worker-facing durability port. Lease fencing remains a persistence concern; the application
// core names only Runs, Attempts, workers, and semantic events.
export interface RunExecutionRepository {
  startAttempt(input: {
    worker: WorkerIdentity;
    runId: string;
    attemptId: string;
    leaseId: string;
  }): Promise<RunAttempt | null>;
  appendEvents(input: {
    worker: WorkerIdentity;
    runId: string;
    attemptId: string;
    leaseId: string;
    events: readonly RunEventDraft[];
  }): Promise<readonly RunEvent[]>;
  finishAttempt(input: {
    worker: WorkerIdentity;
    runId: string;
    attemptId: string;
    leaseId: string;
    status: Exclude<RunAttemptStatus, "running">;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<RunAttempt | null>;
}

export type CancelRunResult = {
  runId: string;
  status: RunStatus;
  idempotentReplay: boolean;
};

export type ResolveApprovalCommand = {
  runId: string;
  approvalId: string;
  resolution: ApprovalResolution;
  answer?: string;
};

export type ResolveApprovalResult = {
  approvalId: string;
  runId: string;
  resolution: ApprovalResolution;
  idempotentReplay: boolean;
};

export interface ChatRepository {
  listConversations(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
  }): Promise<ConversationPage>;
  getConversation(input: { actor: Actor; conversationId: string }): Promise<Conversation | null>;
  listMessages(input: {
    actor: Actor;
    conversationId: string;
    cursor?: string;
    limit: number;
  }): Promise<MessagePage | null>;
  createMessageAndRun(input: {
    actor: Actor;
    command: CreateMessageCommand;
  }): Promise<CreateMessageResult>;
  getRun(input: { actor: Actor; runId: string }): Promise<Run | null>;
  listRunEvents(input: {
    actor: Actor;
    runId: string;
    afterSequence: number;
    limit: number;
  }): Promise<RunEventPage | null>;
  cancelRun(input: { actor: Actor; runId: string }): Promise<CancelRunResult | null>;
  resolveApproval(input: {
    actor: Actor;
    command: ResolveApprovalCommand;
  }): Promise<ResolveApprovalResult | null>;
}

export class CoreError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid_argument" | "not_found" | "idempotency_conflict",
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

const MAX_MESSAGE_LENGTH = 10_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_RESOURCE_ID_LENGTH = 256;
const MAX_MODEL_ID_LENGTH = 256;

export class ChatApplicationService {
  constructor(private readonly repository: ChatRepository) {}

  listConversations(
    actor: Actor,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ConversationPage> {
    requirePermission(actor, CHAT_READ_PERMISSION);
    return this.repository.listConversations({
      actor,
      ...(input.cursor ? { cursor: boundedValue(input.cursor, "cursor") } : {}),
      limit: Math.max(1, Math.min(input.limit ?? 25, 100)),
    });
  }

  async getConversation(actor: Actor, conversationId: string): Promise<Conversation> {
    requirePermission(actor, CHAT_READ_PERMISSION);
    const result = await this.repository.getConversation({
      actor,
      conversationId: resourceId(conversationId, "conversationId"),
    });
    if (!result) throw new CoreError("not_found", "Conversation not found.");
    return result;
  }

  async listMessages(
    actor: Actor,
    input: { conversationId: string; cursor?: string; limit?: number },
  ): Promise<MessagePage> {
    requirePermission(actor, CHAT_READ_PERMISSION);
    const result = await this.repository.listMessages({
      actor,
      conversationId: resourceId(input.conversationId, "conversationId"),
      ...(input.cursor ? { cursor: boundedValue(input.cursor, "cursor") } : {}),
      limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
    });
    if (!result) throw new CoreError("not_found", "Conversation not found.");
    return result;
  }

  createMessage(actor: Actor, input: CreateMessageCommand): Promise<CreateMessageResult> {
    requirePermission(actor, CHAT_WRITE_PERMISSION);
    const content = input.content.trim();
    const attachmentIds = (input.attachmentIds ?? []).map((id) => resourceId(id, "attachmentId"));
    if (!content && attachmentIds.length === 0) {
      throw new CoreError("invalid_argument", "Message content or an attachment is required.");
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new CoreError(
        "invalid_argument",
        `Message content cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
      );
    }
    if (attachmentIds.length > CHAT_ATTACHMENTS_PER_MESSAGE) {
      throw new CoreError(
        "invalid_argument",
        `A Message cannot contain more than ${CHAT_ATTACHMENTS_PER_MESSAGE} attachments.`,
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new CoreError("invalid_argument", "Attachment references must be unique.");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(idempotencyKey)
    ) {
      throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
    }
    if (!CHAT_ENGINES.includes(input.engine)) {
      throw new CoreError("invalid_argument", "Unknown Chat engine.");
    }
    const model = input.model.trim();
    if (!model || model.length > MAX_MODEL_ID_LENGTH) {
      throw new CoreError("invalid_argument", "A valid model is required.");
    }
    if (input.conversationId && input.clientConversationId) {
      throw new CoreError(
        "invalid_argument",
        "conversationId and clientConversationId cannot both be provided.",
      );
    }

    const command: CreateMessageCommand = {
      idempotencyKey,
      content,
      engine: input.engine,
      model,
      ...(input.conversationId
        ? { conversationId: resourceId(input.conversationId, "conversationId") }
        : {}),
      ...(input.clientConversationId
        ? {
            clientConversationId: resourceId(input.clientConversationId, "clientConversationId"),
          }
        : {}),
      ...(input.clientMessageId
        ? { clientMessageId: resourceId(input.clientMessageId, "clientMessageId") }
        : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    };
    return this.repository.createMessageAndRun({ actor, command });
  }

  async getRun(actor: Actor, runId: string): Promise<Run> {
    requirePermission(actor, CHAT_READ_PERMISSION);
    const result = await this.repository.getRun({ actor, runId: resourceId(runId, "runId") });
    if (!result) throw new CoreError("not_found", "Run not found.");
    return result;
  }

  async listRunEvents(
    actor: Actor,
    input: { runId: string; afterSequence?: number; limit?: number },
  ): Promise<RunEventPage> {
    requirePermission(actor, CHAT_READ_PERMISSION);
    const afterSequence = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new CoreError("invalid_argument", "The event cursor is invalid.");
    }
    const result = await this.repository.listRunEvents({
      actor,
      runId: resourceId(input.runId, "runId"),
      afterSequence,
      limit: Math.max(1, Math.min(input.limit ?? 100, 500)),
    });
    if (!result) throw new CoreError("not_found", "Run not found.");
    return result;
  }

  async cancelRun(actor: Actor, runId: string): Promise<CancelRunResult> {
    requirePermission(actor, CHAT_WRITE_PERMISSION);
    const result = await this.repository.cancelRun({
      actor,
      runId: resourceId(runId, "runId"),
    });
    if (!result) throw new CoreError("not_found", "Run not found.");
    return result;
  }

  async resolveApproval(
    actor: Actor,
    input: ResolveApprovalCommand,
  ): Promise<ResolveApprovalResult> {
    requirePermission(actor, CHAT_WRITE_PERMISSION);
    if (!APPROVAL_RESOLUTIONS.includes(input.resolution)) {
      throw new CoreError("invalid_argument", "The approval resolution is invalid.");
    }
    const answer = input.answer?.trim();
    if (input.resolution === "answered" && !answer) {
      throw new CoreError("invalid_argument", "An answer is required for this resolution.");
    }
    if (input.resolution !== "answered" && answer) {
      throw new CoreError("invalid_argument", "An answer is only valid for an answered approval.");
    }
    if (input.resolution !== "answered" && answer) {
      throw new CoreError("invalid_argument", "An answer is only valid for an answered approval.");
    }
    if (answer && answer.length > MAX_APPROVAL_ANSWER_LENGTH) {
      throw new CoreError("invalid_argument", "The approval answer is too long.");
    }
    const result = await this.repository.resolveApproval({
      actor,
      command: {
        runId: resourceId(input.runId, "runId"),
        approvalId: resourceId(input.approvalId, "approvalId"),
        resolution: input.resolution,
        ...(answer ? { answer } : {}),
      },
    });
    if (!result) throw new CoreError("not_found", "Approval not found.");
    return result;
  }
}

function requirePermission(actor: Actor, permission: string) {
  if (!actor.userId.trim() || !actor.workspaceId.trim() || !actorHasPermission(actor, permission)) {
    throw new CoreError("forbidden", "The actor is not allowed to access Chat.");
  }
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RESOURCE_ID_LENGTH) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function boundedValue(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RESOURCE_ID_LENGTH) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

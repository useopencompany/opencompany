import { z } from "@hono/zod-openapi";
import { API_VERSION, PROTOCOL_VERSION } from "./version";

export const ResourceIdSchema = z.string().min(1).max(256).openapi({ example: "run_019fed53" });
export const CursorSchema = z
  .string()
  .regex(/^v1:[1-9][0-9]*$/u)
  .openapi({ example: "v1:42", description: "Opaque, versioned event cursor." });
export const TimestampSchema = z.iso.datetime({ offset: true });
export const ChatEngineSchema = z.enum(["opencompany", "codex", "claude_code"]);
export const MessageMentionSchema = z
  .object({ kind: z.literal("skill"), id: ResourceIdSchema })
  .strict()
  .openapi("MessageMention");
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
]);

export const ProtocolMetadataSchema = z
  .object({ apiVersion: z.literal(API_VERSION), protocolVersion: z.literal(PROTOCOL_VERSION) })
  .strict()
  .openapi("ProtocolMetadata");

export const AttachmentSchema = z
  .object({
    id: ResourceIdSchema,
    filename: z.string().min(1).max(512),
    mediaType: z.string().min(1).max(255),
    sizeBytes: z.number().int().min(0),
    kind: z.enum(["image", "document", "audio", "video", "other"]),
  })
  .strict()
  .openapi("Attachment");

export const ConversationSchema = z
  .object({
    id: ResourceIdSchema,
    title: z.string(),
    engine: ChatEngineSchema,
    model: z.string(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Conversation");

export const MessageSchema = z
  .object({
    id: ResourceIdSchema,
    conversationId: ResourceIdSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    attachments: z.array(AttachmentSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Message");

export const RunSchema = z
  .object({
    id: ResourceIdSchema,
    conversationId: ResourceIdSchema,
    triggerMessageId: ResourceIdSchema,
    status: RunStatusSchema,
    engine: ChatEngineSchema,
    model: z.string(),
    attemptCount: z.number().int().min(0),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Run");

// Electric read models are versioned protocol resources. Their implementation may project from
// existing physical tables, but clients only select one of these fixed names and receive canonical
// field names through the shared collection adapter.
export const ChatReadModelSchema = z.enum([
  "chat-conversations-v1",
  "chat-messages-v1",
  "chat-runs-v1",
]);

export const ChatPresentationAttachmentSchema = z
  .object({
    id: ResourceIdSchema,
    filename: z.string().min(1).max(512),
    mediaType: z.string().min(1).max(255),
    sizeBytes: z.number().int().min(0),
    kind: z.enum(["image", "pdf", "docx", "xlsx", "srt", "csv", "tsv", "json", "text"]),
  })
  .strict()
  .openapi("ChatPresentationAttachment");

export const ConversationReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    title: z.string(),
    engine: ChatEngineSchema,
    model: z.string(),
    archivedAt: TimestampSchema.nullable(),
    pinnedAt: TimestampSchema.nullable(),
    lastSeenAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("ConversationReadModelV1");

export const MessageReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    conversationId: ResourceIdSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    taskId: ResourceIdSchema.nullable(),
    presentation: z.record(z.string(), z.unknown()).nullable(),
    attachments: z.array(ChatPresentationAttachmentSchema).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("MessageReadModelV1");

export const RunReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    conversationId: ResourceIdSchema,
    triggerMessageId: ResourceIdSchema,
    assistantMessageId: ResourceIdSchema,
    status: RunStatusSchema,
    engine: ChatEngineSchema,
    model: z.string(),
    attemptCount: z.number().int().min(0),
    error: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("RunReadModelV1");

export const ErrorCodeSchema = z.enum([
  "authentication_required",
  "forbidden",
  "invalid_request",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "rate_limited",
  "internal_error",
  "unavailable",
]);

export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string(),
        requestId: z.string().min(1),
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ErrorEnvelope");

export const ConversationPageSchema = z
  .object({
    data: z.array(ConversationSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ConversationPage");

export const ConversationEnvelopeSchema = z
  .object({ data: ConversationSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("ConversationEnvelope");

export const UpdateConversationBodySchema = z
  .object({
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    markSeen: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value: { archived?: boolean; pinned?: boolean; markSeen?: true }) =>
      value.archived !== undefined || value.pinned !== undefined || value.markSeen !== undefined,
    { message: "A Conversation update is required." },
  )
  .openapi("UpdateConversationBody");

export const UpdateConversationEnvelopeSchema = z
  .object({
    data: z
      .object({
        conversationId: ResourceIdSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("UpdateConversationEnvelope");

export const MessagePageSchema = z
  .object({
    data: z.array(MessageSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("MessagePage");

export const AttachmentUploadBodySchema = z
  .object({
    file: z
      .file()
      .max(20 * 1024 * 1024)
      .openapi({ type: "string", format: "binary" }),
  })
  .strict()
  .openapi("AttachmentUploadBody");

export const AttachmentUploadEnvelopeSchema = z
  .object({
    data: z
      .object({
        attachment: AttachmentSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("AttachmentUploadEnvelope");

export const CreateMessageBodySchema = z
  .object({
    conversationId: ResourceIdSchema.optional(),
    clientConversationId: ResourceIdSchema.optional(),
    clientMessageId: ResourceIdSchema.optional(),
    content: z.string().max(10_000),
    engine: ChatEngineSchema,
    model: z.string().min(1).max(256).optional(),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
    mentions: z.array(MessageMentionSchema).max(16).optional(),
  })
  .strict()
  .refine(
    (body: { conversationId?: string; clientConversationId?: string }) =>
      !(body.conversationId && body.clientConversationId),
    {
      message: "conversationId and clientConversationId are mutually exclusive",
    },
  )
  .refine(
    (body: { content: string; attachmentIds?: string[] }) =>
      Boolean(body.content.trim()) || Boolean(body.attachmentIds?.length),
    { message: "content or an attachment is required" },
  )
  .openapi("CreateMessageBody");

export const CreateMessageEnvelopeSchema = z
  .object({
    data: z
      .object({
        conversationId: ResourceIdSchema,
        messageId: ResourceIdSchema,
        assistantMessageId: ResourceIdSchema,
        runId: ResourceIdSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CreateMessageEnvelope");

export const RunEnvelopeSchema = z
  .object({ data: RunSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("RunEnvelope");

export const CancelRunEnvelopeSchema = z
  .object({
    data: z.object({ runId: ResourceIdSchema, status: RunStatusSchema, replayed: z.boolean() }),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CancelRunEnvelope");

export const ResolveApprovalBodySchema = z
  .object({
    resolution: z.enum(["approved", "denied", "answered", "canceled"]),
    answer: z.string().max(10_000).optional(),
  })
  .strict()
  .refine(
    (body: { resolution: string; answer?: string }) =>
      body.resolution !== "answered" || Boolean(body.answer?.trim()),
    { message: "answer is required when resolution is answered" },
  )
  .refine(
    (body: { resolution: string; answer?: string }) =>
      body.resolution === "answered" || !body.answer?.trim(),
    { message: "answer is only valid when resolution is answered" },
  )
  .openapi("ResolveApprovalBody");

export const ResolveApprovalEnvelopeSchema = z
  .object({
    data: z
      .object({
        approvalId: ResourceIdSchema,
        runId: ResourceIdSchema,
        resolution: z.enum(["approved", "denied", "answered", "canceled"]),
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ResolveApprovalEnvelope");

export type ConversationDto = z.infer<typeof ConversationSchema>;
export type UpdateConversationBody = z.infer<typeof UpdateConversationBodySchema>;
export type MessageDto = z.infer<typeof MessageSchema>;
export type RunDto = z.infer<typeof RunSchema>;
export type ChatReadModel = z.infer<typeof ChatReadModelSchema>;
export type ConversationReadModel = z.infer<typeof ConversationReadModelSchema>;
export type MessageReadModel = z.infer<typeof MessageReadModelSchema>;
export type RunReadModel = z.infer<typeof RunReadModelSchema>;
export type AttachmentUploadEnvelope = z.infer<typeof AttachmentUploadEnvelopeSchema>;
export type CreateMessageBody = z.infer<typeof CreateMessageBodySchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

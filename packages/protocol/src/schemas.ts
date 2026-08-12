import { z } from "@hono/zod-openapi";
import { API_VERSION, PROTOCOL_VERSION } from "./version";

export const ResourceIdSchema = z.string().min(1).max(256).openapi({ example: "run_019fed53" });
export const CursorSchema = z
  .string()
  .regex(/^v1:[1-9][0-9]*$/u)
  .openapi({ example: "v1:42", description: "Opaque, versioned event cursor." });
export const PresentationCursorSchema = z
  .string()
  .regex(/^p1:[1-9][0-9]*-[0-9]+$/u)
  .openapi({
    example: "p1:1786449600000-0",
    description: "Opaque, best-effort cursor within the transient presentation window.",
  });
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
export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "canceled",
  "archived",
]);
export const TaskSourceSchema = z.enum(["manual", "workflow", "schedule", "agent"]);

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

export const TaskOutcomeSchema = z
  .object({
    result: z.string().nullable(),
    error: z.string().nullable(),
    reportedStatus: z.enum(["done", "needs_attention"]).nullable(),
    comment: z.string().nullable(),
  })
  .strict()
  .openapi("TaskOutcome");

export const TaskSchema = z
  .object({
    id: ResourceIdSchema,
    displayId: z.string().min(1).max(64),
    name: z.string().min(1).max(160),
    goal: z.string().min(1).max(10_000),
    conversationId: ResourceIdSchema,
    status: TaskStatusSchema,
    source: TaskSourceSchema,
    engine: ChatEngineSchema,
    model: z.string().min(1).max(256),
    workflowId: ResourceIdSchema.nullable(),
    scheduleId: ResourceIdSchema.nullable(),
    scheduledFor: TimestampSchema.nullable(),
    outcome: TaskOutcomeSchema,
    archivedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Task");

export const WorkflowStatusSchema = z.enum(["draft", "active"]);
export const WorkflowStepSchema = z
  .object({
    id: ResourceIdSchema,
    title: z.string().max(120),
    model: z.string().max(256),
    runtimeModel: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(64).optional(),
    instructions: z.string().max(20_000),
  })
  .strict()
  .openapi("WorkflowStep");

export const WorkflowTriggerSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("manual") }).strict(),
    z
      .object({
        type: z.literal("schedule"),
        cron: z.string().min(1).max(128),
        timezone: z.string().min(1).max(128),
        prompt: z.string().min(1).max(10_000),
        enabled: z.boolean(),
        lastRunAt: TimestampSchema.nullable(),
        nextRunAt: TimestampSchema.nullable(),
      })
      .strict(),
  ])
  .openapi("WorkflowTrigger");

export const WorkflowTriggerInputSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("manual") }).strict(),
    z
      .object({
        type: z.literal("schedule"),
        cron: z.string().min(1).max(128),
        timezone: z.string().min(1).max(128).optional(),
        prompt: z.string().max(10_000).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
  ])
  .openapi("WorkflowTriggerInput");

export const WorkflowSchema = z
  .object({
    id: ResourceIdSchema,
    slug: z.string().min(1).max(80),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
    // Historical drafts can be empty. Mutations still require at least one step, and the Core
    // refuses to invoke an incomplete definition.
    steps: z.array(WorkflowStepSchema).max(20),
    status: WorkflowStatusSchema,
    trigger: WorkflowTriggerSchema,
    version: z.number().int().min(1),
    archivedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Workflow");

export const TaskScheduleSchema = z
  .object({
    id: ResourceIdSchema,
    name: z.string().min(1).max(80),
    sourceDescription: z.string().max(1_024),
    cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128),
    prompt: z.string().min(1).max(10_000),
    enabled: z.boolean(),
    lastRunAt: TimestampSchema.nullable(),
    nextRunAt: TimestampSchema,
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("TaskSchedule");

export const WorkflowScheduleReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    workflowId: ResourceIdSchema,
    workflowSlug: z.string().min(1).max(80),
    name: z.string().min(1).max(64),
    cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128),
    prompt: z.string().min(1).max(10_000),
    enabled: z.boolean(),
    lastRunAt: TimestampSchema.nullable(),
    nextRunAt: TimestampSchema.nullable(),
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("WorkflowScheduleReadModelV1");

// Electric read models are versioned protocol resources. Their implementation may project from
// existing physical tables, but clients only select one of these fixed names and receive canonical
// field names through the shared collection adapter.
export const ChatReadModelSchema = z.enum([
  "chat-conversations-v1",
  "chat-messages-v1",
  "chat-runs-v1",
]);
export const TaskReadModelNameSchema = z.literal("tasks-v1");
export const WorkflowReadModelNameSchema = z.literal("workflows-v1");
export const WorkflowScheduleReadModelNameSchema = z.literal("workflow-schedules-v1");
export const TaskScheduleReadModelNameSchema = z.literal("task-schedules-v1");
export const ReadModelSchema = z.enum([
  ...ChatReadModelSchema.options,
  TaskReadModelNameSchema.value,
  WorkflowReadModelNameSchema.value,
  WorkflowScheduleReadModelNameSchema.value,
  TaskScheduleReadModelNameSchema.value,
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

export const TaskReadModelSchema = TaskSchema.openapi("TaskReadModelV1");
export const WorkflowReadModelSchema = WorkflowSchema.openapi("WorkflowReadModelV1");
export const TaskScheduleReadModelSchema = TaskScheduleSchema.openapi("TaskScheduleReadModelV1");

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

export const TaskPageSchema = z
  .object({
    data: z.array(TaskSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("TaskPage");

export const TaskEnvelopeSchema = z
  .object({ data: TaskSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("TaskEnvelope");

export const TaskSummarySchema = z
  .object({
    cost: z
      .object({
        hasRecordedCosts: z.boolean(),
        totalCostUsdMicros: z.number().int().min(0),
      })
      .strict(),
    durationMs: z.number().int().min(0).nullable(),
  })
  .strict()
  .openapi("TaskSummary");

export const TaskSummaryEnvelopeSchema = z
  .object({ data: TaskSummarySchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("TaskSummaryEnvelope");

export const WorkflowPageSchema = z
  .object({
    data: z.array(WorkflowSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkflowPage");

export const WorkflowEnvelopeSchema = z
  .object({ data: WorkflowSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WorkflowEnvelope");

export const CreateWorkflowBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(1_024).optional(),
  })
  .strict()
  .openapi("CreateWorkflowBody");

export const UpdateWorkflowBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
    steps: z.array(WorkflowStepSchema).min(1).max(20),
    status: WorkflowStatusSchema,
    trigger: WorkflowTriggerInputSchema,
  })
  .strict()
  .openapi("UpdateWorkflowBody");

export const ArchiveVersionBodySchema = z
  .object({ expectedVersion: z.number().int().min(1) })
  .strict()
  .openapi("ArchiveVersionBody");

export const WorkflowMutationEnvelopeSchema = z
  .object({
    data: z
      .object({
        workflow: WorkflowSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkflowMutationEnvelope");

export const WorkflowUpdateEnvelopeSchema = z
  .object({
    data: z
      .object({
        workflow: WorkflowSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkflowUpdateEnvelope");

export const WorkflowArchiveEnvelopeSchema = z
  .object({
    data: z
      .object({
        workflowId: ResourceIdSchema,
        version: z.number().int().min(1),
        transactionId: z.string().regex(/^[0-9]+$/u),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkflowArchiveEnvelope");

export const InvokeWorkflowBodySchema = z
  .object({
    description: z.string().min(1).max(10_000),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
    skillIds: z.array(ResourceIdSchema).max(16).optional(),
  })
  .strict()
  .openapi("InvokeWorkflowBody");

export const TaskSchedulePageSchema = z
  .object({
    data: z.array(TaskScheduleSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("TaskSchedulePage");

export const TaskScheduleEnvelopeSchema = z
  .object({ data: TaskScheduleSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("TaskScheduleEnvelope");

export const CreateTaskScheduleBodySchema = z
  .object({
    name: z.string().max(80).optional(),
    sourceDescription: z.string().max(1_024).optional(),
    cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128).optional(),
    prompt: z.string().min(1).max(10_000),
  })
  .strict()
  .openapi("CreateTaskScheduleBody");

export const UpdateTaskScheduleBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: z.string().min(1).max(80),
    sourceDescription: z.string().max(1_024).optional(),
    cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128).optional(),
    prompt: z.string().min(1).max(10_000),
  })
  .strict()
  .openapi("UpdateTaskScheduleBody");

export const SetTaskScheduleEnabledBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    enabled: z.boolean(),
  })
  .strict()
  .openapi("SetTaskScheduleEnabledBody");

export const UpdateTaskScheduleCommandSchema = z
  .union([UpdateTaskScheduleBodySchema, SetTaskScheduleEnabledBodySchema])
  .openapi("UpdateTaskScheduleCommand");

export const TaskScheduleMutationEnvelopeSchema = z
  .object({
    data: z
      .object({
        schedule: TaskScheduleSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("TaskScheduleMutationEnvelope");

export const TaskScheduleUpdateEnvelopeSchema = z
  .object({
    data: z
      .object({
        schedule: TaskScheduleSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("TaskScheduleUpdateEnvelope");

export const TaskScheduleArchiveEnvelopeSchema = z
  .object({
    data: z
      .object({
        scheduleId: ResourceIdSchema,
        version: z.number().int().min(1),
        transactionId: z.string().regex(/^[0-9]+$/u),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("TaskScheduleArchiveEnvelope");

export const LegacyTaskSchema = TaskSchema.omit({ conversationId: true }).openapi("LegacyTask");

export const LegacyTaskHistoryMessageSchema = z
  .object({
    id: ResourceIdSchema,
    role: z.enum(["user", "assistant", "tool"]),
    status: z.enum(["created", "running", "completed", "failed"]),
    content: z.string(),
    toolName: z.string().nullable(),
    toolCallId: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("LegacyTaskHistoryMessage");

export const LegacyTaskHistoryEventSchema = z
  .object({
    id: z.number().int().min(1),
    messageId: ResourceIdSchema.nullable(),
    type: z.enum([
      "task.status",
      "harness.planned",
      "artifact.created",
      "assistant.delta",
      "reasoning.completed",
      "message.created",
      "message.completed",
      "message.failed",
      "tool.started",
      "tool.completed",
      "tool.failed",
    ]),
    payload: z.record(z.string(), z.unknown()),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("LegacyTaskHistoryEvent");

export const LegacyTaskPageSchema = z
  .object({ data: z.array(LegacyTaskSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("LegacyTaskPage");

export const LegacyTaskHistoryEnvelopeSchema = z
  .object({
    data: z
      .object({
        task: LegacyTaskSchema,
        messages: z.array(LegacyTaskHistoryMessageSchema),
        events: z.array(LegacyTaskHistoryEventSchema),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("LegacyTaskHistoryEnvelope");

export const CreateTaskBodySchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    goal: z.string().min(1).max(10_000),
    engine: ChatEngineSchema,
    model: z.string().min(1).max(256).optional(),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
  })
  .strict()
  .openapi("CreateTaskBody");

export const CreateTaskEnvelopeSchema = z
  .object({
    data: z
      .object({
        task: TaskSchema,
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
  .openapi("CreateTaskEnvelope");

export const UpdateTaskBodySchema = z
  .union([
    z.object({ archived: z.boolean() }).strict(),
    z.object({ name: z.string().min(1).max(160) }).strict(),
  ])
  .openapi("UpdateTaskBody");

export const UpdateTaskEnvelopeSchema = z
  .object({
    data: z.object({ task: TaskSchema, transactionId: z.string().regex(/^[0-9]+$/u) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("UpdateTaskEnvelope");

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
        model: z.string().min(1).max(256).optional(),
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
export type ReadModel = z.infer<typeof ReadModelSchema>;
export type TaskDto = z.infer<typeof TaskSchema>;
export type TaskSummaryDto = z.infer<typeof TaskSummarySchema>;
export type LegacyTaskDto = z.infer<typeof LegacyTaskSchema>;
export type LegacyTaskHistoryMessageDto = z.infer<typeof LegacyTaskHistoryMessageSchema>;
export type LegacyTaskHistoryEventDto = z.infer<typeof LegacyTaskHistoryEventSchema>;
export type LegacyTaskHistoryDto = z.infer<typeof LegacyTaskHistoryEnvelopeSchema>["data"];
export type TaskReadModel = z.infer<typeof TaskReadModelSchema>;
export type WorkflowDto = z.infer<typeof WorkflowSchema>;
export type WorkflowReadModel = z.infer<typeof WorkflowReadModelSchema>;
export type WorkflowScheduleReadModel = z.infer<typeof WorkflowScheduleReadModelSchema>;
export type TaskScheduleDto = z.infer<typeof TaskScheduleSchema>;
export type TaskScheduleReadModel = z.infer<typeof TaskScheduleReadModelSchema>;
export type CreateWorkflowBody = z.infer<typeof CreateWorkflowBodySchema>;
export type UpdateWorkflowBody = z.infer<typeof UpdateWorkflowBodySchema>;
export type ArchiveVersionBody = z.infer<typeof ArchiveVersionBodySchema>;
export type InvokeWorkflowBody = z.infer<typeof InvokeWorkflowBodySchema>;
export type CreateTaskScheduleBody = z.infer<typeof CreateTaskScheduleBodySchema>;
export type UpdateTaskScheduleBody = z.infer<typeof UpdateTaskScheduleBodySchema>;
export type SetTaskScheduleEnabledBody = z.infer<typeof SetTaskScheduleEnabledBodySchema>;
export type ConversationReadModel = z.infer<typeof ConversationReadModelSchema>;
export type MessageReadModel = z.infer<typeof MessageReadModelSchema>;
export type RunReadModel = z.infer<typeof RunReadModelSchema>;
export type AttachmentUploadEnvelope = z.infer<typeof AttachmentUploadEnvelopeSchema>;
export type CreateMessageBody = z.infer<typeof CreateMessageBodySchema>;
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;
export type UpdateTaskBody = z.infer<typeof UpdateTaskBodySchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

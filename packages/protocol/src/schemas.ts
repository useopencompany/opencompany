import { z } from "@hono/zod-openapi";
import {
  normalizeWikiToolInput,
  WIKI_TOOL_INPUT_JSON_SCHEMA,
  type WikiToolInput,
} from "@opencompany/wiki/tool";
import { API_VERSION, PROTOCOL_VERSION } from "./version";

export const ResourceIdSchema = z.string().min(1).max(256).openapi({ example: "run_019fed53" });
export const ENGINE_SESSION_ERROR_MAX_LENGTH = 2_000;
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
export const ConversationActivityStateSchema = z.enum(["working", "idle"]);
export const ConversationRuntimeStatusSchema = z.enum([
  "queued",
  "starting",
  "idle",
  "running",
  "failed",
  "interrupted",
  "closed",
]);
export const ConversationRuntimeSchema = z
  .object({
    status: ConversationRuntimeStatusSchema,
    activeRunId: ResourceIdSchema.nullable(),
    hasError: z.boolean(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("ConversationRuntime");
export const CodexReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export const ClaudeCodeReasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
]);
export const EngineReasoningEffortSchema = ClaudeCodeReasoningEffortSchema;
export const CodexGoalModeSchema = z
  .object({
    objective: z.string().min(1).max(4_000),
    tokenBudget: z.number().int().min(1).max(2_000_000).nullable().optional(),
  })
  .strict()
  .openapi("CodexGoalModeV1");
export const ConversationComposerSettingsSchema = z
  .object({
    reasoningEffort: EngineReasoningEffortSchema,
    planModeEnabled: z.boolean().optional(),
    goalMode: CodexGoalModeSchema.nullable().optional(),
  })
  .strict()
  .openapi("ConversationComposerSettingsV1");
export const MessageEngineSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("opencompany"),
        schemaVersion: z.literal(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("codex"),
        schemaVersion: z.literal(1),
        settings: z
          .object({
            reasoningEffort: CodexReasoningEffortSchema,
            planModeEnabled: z.boolean().optional(),
            goalMode: CodexGoalModeSchema.nullable().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("claude_code"),
        schemaVersion: z.literal(1),
        settings: z
          .object({
            reasoningEffort: ClaudeCodeReasoningEffortSchema,
          })
          .strict(),
      })
      .strict(),
  ])
  .openapi("MessageEngineV1");
export const MessageMentionSchema = z
  .object({
    kind: z.literal("skill"),
    id: ResourceIdSchema,
    name: z.string().min(1).max(64).optional(),
  })
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
    composerSettings: ConversationComposerSettingsSchema.nullable(),
    runtime: ConversationRuntimeSchema.nullable(),
    activityState: ConversationActivityStateSchema,
    hasUnseen: z.boolean(),
    awaitingInput: z.boolean(),
    pinnedAt: TimestampSchema.nullable().optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Conversation");

export const ChatShareIdSchema = z
  .string()
  .regex(
    /^(?:share_|goat_chat_share_)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  )
  .openapi({
    example: "share_01234567-89ab-4cde-8f01-23456789abcd",
    description: "Unguessable public Chat share capability.",
  });

export const ConversationShareSchema = z
  .object({
    conversationId: ResourceIdSchema,
    shareId: ChatShareIdSchema.nullable(),
  })
  .strict()
  .openapi("ConversationShareV1");

// Public transcripts are a presentation read model rather than a second Message
// protocol. Parts remain extensible because their discriminated tool/data variants
// evolve with the canonical presentation mapper.
export const PublicChatMessageSchema = z
  .object({
    id: ResourceIdSchema,
    role: z.enum(["user", "assistant"]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    parts: z.array(z.record(z.string(), z.unknown())),
  })
  .strict()
  .openapi("PublicChatMessageV1");

export const PublicChatShareSchema = z
  .object({
    shareId: ChatShareIdSchema,
    title: z.string(),
    kind: z.enum(["chat", "task"]),
    engine: ChatEngineSchema,
    messages: z.array(PublicChatMessageSchema),
  })
  .strict()
  .openapi("PublicChatShareV1");

export const PublicChatShareMetadataSchema = PublicChatShareSchema.omit({ messages: true })
  .strict()
  .openapi("PublicChatShareMetadataV1");

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
// Mirrors Skills: a company workflow belongs to the workspace, a personal one only to its creator.
export const WorkflowScopeSchema = z.enum(["personal", "company"]).openapi("WorkflowScope");

// Slack is the only workflow channel today. `enabled` decides whether a run is given the Slack
// send tool at all; `displayName` and `avatarUrl` are cosmetic chat.postMessage identity overrides
// and are empty when the workflow posts under the default bot identity.
export const WorkflowSlackChannelSchema = z
  .object({
    enabled: z.boolean(),
    // Trimmed before measuring, so this matches the Core rule the API delegates to.
    displayName: z.string().trim().max(80),
    avatarUrl: z.string().trim().max(2_048).default(""),
  })
  .strict()
  .openapi("WorkflowSlackChannel");
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

const WorkflowEventFilterValueSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    key: z.string().min(1).max(64).optional(),
    metadata: z.record(z.string().max(64), z.string().max(256)).optional(),
  })
  .strict();

export const WorkflowTriggerSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("manual") }).strict(),
    z
      .object({
        type: z.literal("event"),
        provider: z.string().min(1).max(64),
        event: z.string().min(1).max(128),
        integrationId: ResourceIdSchema,
        filters: z.record(z.string().max(64), WorkflowEventFilterValueSchema),
        prompt: z.string().min(1).max(10_000),
      })
      .strict(),
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
        type: z.literal("event"),
        provider: z.string().min(1).max(64),
        event: z.string().min(1).max(128),
        integrationId: ResourceIdSchema,
        filters: z.record(z.string().max(64), WorkflowEventFilterValueSchema),
        prompt: z.string().max(10_000).optional(),
      })
      .strict(),
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

export const WorkflowAutomationTriggerSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        id: ResourceIdSchema,
        type: z.literal("event"),
        provider: z.string().min(1).max(64),
        event: z.string().min(1).max(128),
        integrationId: ResourceIdSchema,
        filters: z.record(z.string().max(64), WorkflowEventFilterValueSchema),
        prompt: z.string().min(1).max(10_000),
      })
      .strict(),
    z
      .object({
        id: ResourceIdSchema,
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
  .openapi("WorkflowAutomationTrigger");

export const WorkflowAutomationTriggerInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        id: ResourceIdSchema,
        type: z.literal("event"),
        provider: z.string().min(1).max(64),
        event: z.string().min(1).max(128),
        integrationId: ResourceIdSchema,
        filters: z.record(z.string().max(64), WorkflowEventFilterValueSchema),
        prompt: z.string().max(10_000).optional(),
      })
      .strict(),
    z
      .object({
        id: ResourceIdSchema,
        type: z.literal("schedule"),
        cron: z.string().min(1).max(128),
        timezone: z.string().min(1).max(128).optional(),
        prompt: z.string().max(10_000).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
  ])
  .openapi("WorkflowAutomationTriggerInput");

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
    scope: WorkflowScopeSchema,
    slackChannel: WorkflowSlackChannelSchema,
    // Null for company workflows created before scopes existed; only an admin can take one personal.
    createdByUserId: z.string().max(256).nullable(),
    trigger: WorkflowTriggerSchema,
    triggers: z.array(WorkflowAutomationTriggerSchema).max(20).optional(),
    version: z.number().int().min(1),
    archivedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Workflow");

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
  "chat-conversations-v2",
  "chat-messages-v1",
  "chat-messages-v2",
  "chat-runs-v1",
  "engine-sessions-v1",
]);
export const TaskReadModelNameSchema = z.literal("tasks-v1");
export const TaskActivityReadModelNameSchema = z.literal("task-activities-v1");
export const WorkflowReadModelNameSchema = z.literal("workflows-v1");
export const WorkflowScheduleReadModelNameSchema = z.literal("workflow-schedules-v1");
export const WikiImportRunReadModelNameSchema = z.literal("wiki-import-runs-v1");
export const WikiPageReadModelNameSchema = z.literal("wiki-pages-v2");
export const WikiTimelineReadModelNameSchema = z.literal("wiki-timeline-v1");
export const IntegrationAccountReadModelNameSchema = z.literal("integration-accounts-v1");
export const ReadModelSchema = z.enum([
  ...ChatReadModelSchema.options,
  TaskReadModelNameSchema.value,
  TaskActivityReadModelNameSchema.value,
  WorkflowReadModelNameSchema.value,
  WorkflowScheduleReadModelNameSchema.value,
  WikiPageReadModelNameSchema.value,
  WikiTimelineReadModelNameSchema.value,
  IntegrationAccountReadModelNameSchema.value,
]);

export const IntegrationAccountReadModelSchema = z
  .object({
    id: z.string().min(1).max(128),
    provider: z.enum([
      "gmail",
      "google_admin",
      "google_calendar",
      "google_drive",
      "linear",
      "github",
      "github_user",
      "jamie",
      "slack",
      "slack_bot",
      "hubspot",
      "granola",
      "fathom",
      "attio",
      "betterstack",
      "convex",
      "render",
      "vercel",
      "signoz",
      "dash0",
      "stripe",
      "latitude",
      "posthog",
      "neon",
      "notion",
      "supabase",
      "resend",
      "todoist",
      "x_account",
      "custom_mcp",
    ]),
    workspaceId: z.string().min(1).max(128).nullable(),
    externalId: z.string().max(1_024),
    connectionLabel: z.string().max(512).nullable(),
    accountName: z.string().max(512).nullable(),
    accountEmail: z.string().max(320).nullable(),
    accountType: z.string().max(256).nullable(),
    status: z.enum(["connected", "needs_reauth", "sync_failed", "disconnected"]),
    statusReason: z.string().max(2_000).nullable(),
    scopes: z.array(z.string().max(512)).max(1_000),
    capabilityModes: z.record(z.string(), z.unknown()),
    toolModes: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("IntegrationAccountReadModelV1");

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

export const ConversationReadModelV1Schema = z
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

export const ConversationReadModelSchema = ConversationReadModelV1Schema.extend({
  runtime: ConversationRuntimeSchema.nullable(),
  activityState: ConversationActivityStateSchema,
  hasUnseen: z.boolean(),
  awaitingInput: z.boolean(),
  messageShapeEpoch: z.number().int().min(0),
})
  .strict()
  .openapi("ConversationReadModelV2");

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

export const MessageSummaryReadModelSchema = MessageReadModelSchema.omit({
  presentation: true,
})
  .extend({
    presentationSummary: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .openapi("MessageReadModelV2");

export const MessagePresentationSchema = z
  .object({
    presentation: z.record(z.string(), z.unknown()).nullable(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("MessagePresentation");

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

export const EngineSessionReadModelSchema = z
  .object({
    // The physical runtime row id. Electric keys every change on the primary key and a partial
    // update carries only that key plus the changed columns, so it is the one field a client can
    // rely on to match an update to the row it already holds.
    id: ResourceIdSchema,
    conversationId: ResourceIdSchema,
    engine: z.enum(["opencompany", "codex", "claude_code"]),
    status: z.enum(["queued", "starting", "idle", "running", "failed", "interrupted", "closed"]),
    activeRunId: ResourceIdSchema.nullable(),
    error: z.string().max(ENGINE_SESSION_ERROR_MAX_LENGTH).nullable(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("EngineSessionReadModelV1");

export const EngineRuntimeStatusSchema = z.enum(["running", "sleeping", "deleted"]);
export const EngineRuntimeStatusEnvelopeSchema = z
  .object({
    data: z
      .object({
        conversationId: ResourceIdSchema,
        status: EngineRuntimeStatusSchema.nullable(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("EngineRuntimeStatusEnvelope");

export const EngineRuntimeAccessEnvelopeSchema = z
  .object({
    data: z
      .object({
        conversationId: ResourceIdSchema,
        websocketUrl: z.url(),
        ticket: z.string().min(1).max(8_192),
        expiresAt: z.number().int().positive(),
        runtimeStatus: z.enum(["running", "sleeping"]),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("EngineRuntimeAccessEnvelope");

// The streamed Task projection carries the unread and awaiting-input flags that the Task resource
// itself does not: both belong to the Task's conversation and only ever matter to surfaces reading
// a live queue.
export const TaskReadModelSchema = TaskSchema.extend({
  hasUnseen: z.boolean(),
  awaitingInput: z.boolean(),
}).openapi("TaskReadModelV1");
export const TaskActivityAuthorSchema = z.enum(["user", "orchestrator", "system"]);
export const TaskActivityKindSchema = z.enum([
  "created",
  "run_started",
  "run_finished",
  "status_changed",
  "comment",
  "retry",
]);
export const TaskActivityReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    taskId: ResourceIdSchema,
    author: TaskActivityAuthorSchema,
    authorWorkosId: ResourceIdSchema.nullable(),
    kind: TaskActivityKindSchema,
    body: z.string().max(10_000).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("TaskActivityReadModelV1");
// The v1 read model projects the workflow list. Channel configuration is only read on the detail
// route, which goes through the API, so it deliberately stays out of this replicated shape.
export const WorkflowReadModelSchema = WorkflowSchema.omit({ slackChannel: true }).openapi(
  "WorkflowReadModelV1",
);

export const WikiKindSchema = z.enum([
  "person",
  "company",
  "project",
  "research",
  "meeting",
  "other",
]);
export const WikiNodeTypeSchema = z.enum(["page", "folder"]);

export const WikiPageSchema = z
  .object({
    id: ResourceIdSchema,
    slug: z.string().min(1).max(80),
    path: z.string().min(1).max(512),
    title: z.string().max(160),
    nodeType: WikiNodeTypeSchema,
    kind: WikiKindSchema,
    body: z.string(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z.number().int().min(0),
    format: z.string().min(1).max(32),
    mimeType: z.string().max(255).nullable(),
    originalFileName: z.string().max(512).nullable(),
    assetSizeBytes: z.number().int().min(0).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("WikiPage");

export const WikiTimelineEntrySchema = z
  .object({
    id: ResourceIdSchema,
    pageId: ResourceIdSchema,
    at: TimestampSchema,
    text: z.string(),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("WikiTimelineEntry");

export const WikiPageReadModelSchema = WikiPageSchema.openapi("WikiPageReadModelV2");
export const WikiTimelineReadModelSchema =
  WikiTimelineEntrySchema.openapi("WikiTimelineReadModelV1");

export const WikiSourceProviderSchema = z.enum(["gmail", "granola", "linear"]);

export const WikiSourceConfigSchema = z
  .record(z.string().min(1).max(128), z.unknown())
  .refine((config: Record<string, unknown>) => Object.keys(config).length <= 100, {
    message: "Wiki source configuration has too many fields.",
  })
  .refine((config: Record<string, unknown>) => JSON.stringify(config).length <= 64 * 1024, {
    message: "Wiki source configuration is too large.",
  })
  .openapi("WikiSourceConfig");

export const WikiSourceSchema = z
  .object({
    id: ResourceIdSchema,
    provider: WikiSourceProviderSchema,
    integrationId: ResourceIdSchema,
    enabled: z.boolean(),
    config: WikiSourceConfigSchema,
    integrationStatus: z.enum(["connected", "needs_reauth", "sync_failed", "disconnected"]),
    accountName: z.string().max(512).nullable(),
    accountEmail: z.string().max(320).nullable(),
    connectionLabel: z.string().max(512).nullable(),
    ownerName: z.string().max(512).nullable(),
    ownerEmail: z.string().max(320).nullable(),
    ownerAvatarUrl: z.string().max(2_048).nullable(),
    ownerKind: z.enum(["workspace", "user"]),
    isOwn: z.boolean(),
    canConfigure: z.boolean(),
    canToggle: z.boolean(),
    canDelete: z.boolean(),
  })
  .strict()
  .openapi("WikiSource");

export const WikiIngestActivityPageSchema = z
  .object({
    path: z.string().min(1).max(512),
    title: z.string().min(1).max(160),
    action: z.enum(["created", "updated", "moved", "deleted"]),
  })
  .strict()
  .openapi("WikiIngestActivityPage");

export const WikiIngestActivityItemSchema = z
  .object({
    id: ResourceIdSchema,
    provider: WikiSourceProviderSchema,
    sourceType: z.enum(["meeting", "conversation", "issue", "activity", "thread"]),
    title: z.string().max(512).nullable(),
    outcome: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
    reason: z.string().max(2_000).nullable(),
    pages: z.array(WikiIngestActivityPageSchema).max(100),
    attempts: z.number().int().min(0),
    occurredAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("WikiIngestActivityItem");

export const ExternalSkillSourceSchema = z
  .object({
    type: z.enum(["github", "skills.sh"]),
    url: z.url().max(2_048),
    ref: z.string().max(256),
    path: z.string().max(512),
    resolvedCommit: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict()
  .openapi("ExternalSkillSource");

export const WorkspaceSkillSourceSchema = z
  .object({ type: z.literal("workspace") })
  .strict()
  .openapi("WorkspaceSkillSource");

export const SkillSourceSchema = z
  .discriminatedUnion("type", [ExternalSkillSourceSchema, WorkspaceSkillSourceSchema])
  .openapi("SkillSource");

export const SkillBundleFileMetadataSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    executable: z.boolean(),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(512 * 1_024),
  })
  .strict()
  .openapi("SkillBundleFileMetadata");

export const SkillImportFileMetadataSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(512 * 1_024),
  })
  .strict()
  .openapi("SkillImportFileMetadata");

export const SkillBundleSummarySchema = z
  .object({
    id: ResourceIdSchema,
    integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1_024),
    license: z.string().nullable(),
    compatibility: z.string().max(500).nullable(),
    metadata: z.record(z.string(), z.string()).nullable(),
    allowedTools: z.string().nullable(),
    source: SkillSourceSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("SkillBundleSummary");

export const SkillBundleSchema = SkillBundleSummarySchema.extend({
  body: z.string(),
  files: z.array(SkillBundleFileMetadataSchema).max(512),
})
  .strict()
  .openapi("SkillBundle");

export const SkillScopeSchema = z.enum(["personal", "company"]).openapi("SkillScope");
export const SetSkillScopeBodySchema = z
  .object({ scope: SkillScopeSchema, expectedScope: SkillScopeSchema })
  .strict()
  .openapi("SetSkillScopeBody");

export const SkillListItemSchema = z
  .object({
    id: ResourceIdSchema,
    scope: SkillScopeSchema.nullable(),
    createdByUserId: z.string().nullable(),
    canEdit: z.boolean(),
    canManage: z.boolean(),
    name: z.string().min(1).max(64),
    enabled: z.boolean(),
    archivedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
    bundle: SkillBundleSummarySchema,
  })
  .strict()
  .openapi("SkillInstallationListItem");

export const SkillInstallationSchema = SkillListItemSchema.extend({
  createdAt: TimestampSchema,
  bundle: SkillBundleSchema,
})
  .strict()
  .openapi("SkillInstallation");
export const SkillCatalogItemSchema = z
  .object({
    id: ResourceIdSchema,
    scope: SkillScopeSchema.nullable(),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
  })
  .strict()
  .openapi("SkillCatalogItem");

export const SkillImportCandidateSchema = z
  .object({
    path: z.string().max(512),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
  })
  .strict()
  .openapi("SkillImportCandidate");

export const SkillImportWarningSchema = z
  .object({
    code: z.literal("source_directory_normalized"),
    message: z.string().min(1).max(1_024),
  })
  .strict()
  .openapi("SkillImportWarning");

export const SkillImportPreviewSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resolved"),
        name: z.string().min(1).max(64),
        description: z.string().min(1).max(1_024),
        license: z.string().optional(),
        compatibility: z.string().max(500).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        allowedTools: z.string().optional(),
        source: ExternalSkillSourceSchema,
        integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
        files: z.array(SkillImportFileMetadataSchema).min(1).max(512),
        fileCount: z.number().int().min(1).max(512),
        totalBytes: z
          .number()
          .int()
          .min(0)
          .max(1024 * 1024),
        warnings: z.array(SkillImportWarningSchema).max(10),
      })
      .strict(),
    z
      .object({
        status: z.literal("ambiguous"),
        candidates: z.array(SkillImportCandidateSchema).min(1).max(25),
        source: ExternalSkillSourceSchema.omit({ path: true }),
      })
      .strict(),
  ])
  .openapi("SkillImportPreview");

export const PluginManifestSchema = z
  .object({
    name: z.string().min(1).max(64),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi("PluginManifest");

export const PluginSourceSchema = z
  .union([
    ExternalSkillSourceSchema,
    z
      .object({
        type: z.literal("custom_mcp"),
        url: z.string().url().max(2048),
        ref: z.literal(""),
        path: z.literal(""),
        resolvedCommit: z.literal(""),
      })
      .strict(),
  ])
  .openapi("PluginSource");

export const PluginFileMetadataSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    executable: z.boolean(),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024),
  })
  .strict()
  .openapi("PluginFileMetadata");

export const PluginImportFileMetadataSchema = PluginFileMetadataSchema.omit({
  executable: true,
}).openapi("PluginImportFileMetadata");

export const PluginStdioServerSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
    envKeys: z.array(z.string()),
    cwd: z.string().optional(),
  })
  .strict()
  .openapi("PluginStdioServer");

export const PluginMcpServerReportSchema = z
  .object({
    name: z.string(),
    status: z.enum(["selected", "gateway-registered", "unsupported", "invalid"]),
    transport: z.enum(["stdio", "streamable-http", "sse"]).optional(),
    reason: z.string().optional(),
  })
  .strict()
  .openapi("PluginMcpServerReport");

export const PluginSkillReportSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        path: z.string().min(1).max(1_024),
        name: z.string().min(1).max(64),
        status: z.literal("valid"),
        integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .strict(),
    z
      .object({
        path: z.string().min(1).max(1_024),
        name: z.string().min(1).max(64),
        status: z.literal("skipped"),
        reason: z.string().min(1),
      })
      .strict(),
  ])
  .openapi("PluginSkillReport");

export const PluginMcpReportSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("absent") }).strict(),
    z
      .object({ present: z.literal(true), status: z.literal("disabled"), reason: z.string() })
      .strict(),
    z
      .object({
        present: z.literal(true),
        status: z.literal("parsed"),
        reports: z.array(PluginMcpServerReportSchema),
      })
      .strict(),
  ])
  .openapi("PluginMcpReport");

export const PluginSkillCollisionSchema = z
  .object({
    skillName: z.string().min(1).max(64),
    winner: z.discriminatedUnion("source", [
      z.object({ source: z.literal("standalone") }).strict(),
      z.object({ source: z.literal("plugin"), pluginName: z.string().min(1).max(64) }).strict(),
    ]),
    hiddenPluginNames: z.array(z.string().min(1).max(64)).min(1),
  })
  .strict()
  .openapi("PluginSkillCollision");

export const PluginActionPriceSchema = z
  .object({
    action: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    unit: z.enum(["per_call", "per_result"]),
    amountUsdMicros: z.number().int().min(1),
  })
  .strict()
  .openapi("PluginActionPrice");

export const PluginPricingSchema = z
  .object({ currency: z.literal("USD"), actions: z.array(PluginActionPriceSchema) })
  .strict()
  .openapi("PluginPricing");

export const PluginValidationReportSchema = z
  .object({
    ignoredManifestFields: z.array(z.string()),
    skills: z.array(PluginSkillReportSchema),
    mcp: PluginMcpReportSchema,
    capabilities: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("absent") }).strict(),
        z
          .object({
            present: z.literal(true),
            status: z.literal("ignored"),
            reason: z.string(),
          })
          .strict(),
        z
          .object({
            present: z.literal(true),
            status: z.literal("parsed"),
            issues: z.array(z.string()),
          })
          .strict(),
      ])
      .optional(),
    events: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("absent") }).strict(),
        z
          .object({
            present: z.literal(true),
            status: z.literal("ignored"),
            reason: z.string(),
          })
          .strict(),
        z
          .object({
            present: z.literal(true),
            status: z.literal("parsed"),
            issues: z.array(z.string()),
          })
          .strict(),
      ])
      .optional(),
    pricing: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("absent") }).strict(),
        z
          .object({
            present: z.literal(true),
            status: z.literal("ignored"),
            reason: z.string(),
          })
          .strict(),
        z
          .object({
            present: z.literal(true),
            status: z.literal("parsed"),
            issues: z.array(z.string()),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .openapi("PluginValidationReport");

export const PluginInstallReportSchema = PluginValidationReportSchema.extend({
  collisions: z.array(PluginSkillCollisionSchema),
})
  .strict()
  .openapi("PluginInstallReport");

export const PluginSkillSummarySchema = z
  .object({
    name: z.string().min(1).max(64),
    path: z.string().min(1).max(1_024),
    bundleId: ResourceIdSchema,
    integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    description: z.string().min(1).max(1_024),
  })
  .strict()
  .openapi("PluginSkillSummary");

export const PluginCapabilityDefinitionSchema = z
  .object({
    id: z.enum(["read", "query", "draft", "write"]),
    label: z.string().min(1).max(128),
    defaultMode: z.enum(["on", "ask", "off"]),
    tools: z.array(z.string().min(1).max(256)).max(512),
  })
  .strict()
  .openapi("PluginCapabilityDefinition");

export const PluginEventFilterDefinitionSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(120),
        kind: z.literal("integration_resource"),
        resourceType: z.string().min(1).max(64),
        required: z.boolean(),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(120),
        kind: z.literal("choice"),
        options: z
          .array(
            z.object({ id: z.string().min(1).max(64), name: z.string().min(1).max(120) }).strict(),
          )
          .min(1)
          .max(64),
        required: z.boolean(),
      })
      .strict(),
  ])
  .openapi("PluginEventFilterDefinition");

export const PluginEventDefinitionSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    delivery: z.enum(["webhook", "poll"]),
    filters: z.array(PluginEventFilterDefinitionSchema).max(16),
  })
  .strict()
  .openapi("PluginEventDefinition");

export const PluginDiscoveredToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(4_096).optional(),
    classification: z
      .object({
        capabilityId: z.enum(["read", "query", "draft", "write"]),
        capabilityLabel: z.string().min(1).max(128),
        defaultMode: z.enum(["on", "ask", "off"]),
        bucket: z.enum(["read", "write"]),
        curated: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .openapi("PluginDiscoveredTool");

export const CustomMcpCredentialsSchema = z
  .object({
    headers: z.record(z.string().min(1).max(100), z.string().min(1).max(8192)).default({}),
  })
  .strict();
export const CustomMcpDefinitionBodySchema = CustomMcpCredentialsSchema.extend({
  label: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(2048),
}).strict();
export const CustomMcpCreateBodySchema = CustomMcpDefinitionBodySchema.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const CustomMcpPermissionBodySchema = z
  .object({
    tool: z.string().min(1).max(128),
    mode: z.enum(["on", "ask", "off"]),
    revision: z.string().uuid(),
  })
  .strict();
export const CustomMcpProbeSchema = z
  .object({ tools: z.array(PluginDiscoveredToolSchema).max(500), fingerprint: z.string() })
  .strict();
export const CustomMcpStatusSchema = z
  .object({
    label: z.string(),
    url: z.string(),
    enabled: z.boolean(),
    account: z
      .object({
        integrationId: ResourceIdSchema,
        revision: z.string(),
        connected: z.boolean(),
        tools: z.array(PluginDiscoveredToolSchema).max(500),
        toolModes: z.record(z.string(), z.enum(["on", "ask", "off"])),
        checkedAt: TimestampSchema,
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const CustomMcpProbeEnvelopeSchema = z
  .object({ data: CustomMcpProbeSchema, meta: ProtocolMetadataSchema })
  .strict();
export const CustomMcpStatusEnvelopeSchema = z
  .object({ data: CustomMcpStatusSchema, meta: ProtocolMetadataSchema })
  .strict();
export type CustomMcpStatusDto = z.infer<typeof CustomMcpStatusSchema>;
export type CustomMcpProbeDto = z.infer<typeof CustomMcpProbeSchema>;
export type CustomMcpDefinitionBody = z.infer<typeof CustomMcpDefinitionBodySchema>;

export const PluginRemoteMcpServerSchema = z
  .object({
    name: z.string().min(1).max(128),
    type: z.enum(["streamable-http", "sse"]),
    connectionProvider: z.string().min(1).max(64),
    capabilities: z.array(PluginCapabilityDefinitionSchema).max(64),
    tools: z.array(PluginDiscoveredToolSchema).max(512),
    discoveryStatus: z.enum(["pending", "ready", "stale", "error"]),
    discoveredAt: TimestampSchema.nullable(),
    refreshAfter: TimestampSchema,
    lastDiscoveryError: z.string().max(2_000).nullable(),
  })
  .strict()
  .openapi("PluginRemoteMcpServer");

export const PluginRemoteMcpPreviewServerSchema = PluginRemoteMcpServerSchema.pick({
  name: true,
  type: true,
  connectionProvider: true,
  capabilities: true,
})
  .strict()
  .openapi("PluginRemoteMcpPreviewServer");

const PluginBaseSchema = z
  .object({
    id: ResourceIdSchema,
    name: z.string().min(1).max(64),
    status: z.enum(["enabled", "disabled", "archived"]),
    manifest: PluginManifestSchema,
    source: PluginSourceSchema,
    integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    installReport: PluginInstallReportSchema,
    events: z.array(PluginEventDefinitionSchema).max(64),
    pricing: PluginPricingSchema.nullable(),
    eventModes: z.record(z.string(), z.boolean()),
    mcpApprovedIntegrity: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })
  .strict();

export const PluginListItemSchema = PluginBaseSchema.extend({
  fileCount: z.number().int().min(1).max(512),
  skillCount: z.number().int().min(0),
  stdioServerCount: z.number().int().min(0),
})
  .strict()
  .openapi("PluginListItem");

export const PluginInstallationSchema = PluginBaseSchema.extend({
  files: z.array(PluginFileMetadataSchema).min(1).max(512),
  skills: z.array(PluginSkillSummarySchema),
  stdioServers: z.array(PluginStdioServerSchema),
  remoteMcpServers: z.array(PluginRemoteMcpServerSchema),
})
  .strict()
  .openapi("PluginInstallation");

export const PluginImportPreviewSchema = z
  .object({
    manifest: PluginManifestSchema,
    source: PluginSourceSchema,
    integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    files: z.array(PluginImportFileMetadataSchema).min(1).max(512),
    fileCount: z.number().int().min(1).max(512),
    totalBytes: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    skills: z.array(
      z
        .object({
          path: z.string().min(1).max(1_024),
          name: z.string().min(1).max(64),
          description: z.string().min(1).max(1_024),
          integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          fileCount: z.number().int().min(1).max(512),
          totalBytes: z
            .number()
            .int()
            .min(0)
            .max(1024 * 1024),
        })
        .strict(),
    ),
    stdioServers: z.array(PluginStdioServerSchema),
    remoteMcpServers: z.array(PluginRemoteMcpPreviewServerSchema),
    events: z.array(PluginEventDefinitionSchema).max(64),
    pricing: PluginPricingSchema.nullable(),
    report: PluginValidationReportSchema,
  })
  .strict()
  .openapi("PluginImportPreview");

export const WikiAccessSchema = z.enum(["workspace", "restricted"]).openapi("WikiAccess");
export const WikiSchema = z
  .object({
    id: ResourceIdSchema,
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(64),
    instructions: z.string().max(20_000),
    access: WikiAccessSchema,
    // The three states a reader sees, resolved server-side: "restricted" alone cannot tell
    // "only me" from "me and the people I invited", and the client holds no member list.
    visibility: z.enum(["workspace", "private", "shared"]),
    isDefault: z.boolean(),
    // Whether this actor may rename the wiki, edit its instructions, or change
    // its access. Resolved server-side from the actor's role and the wiki's
    // creator so the client never has to hold other members' identities to
    // decide whether to offer a control that would only 403.
    canManage: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Wiki");
export const WikiListEnvelopeSchema = z
  .object({ data: z.array(WikiSchema).max(200), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WikiListEnvelope");
export const WikiMutationEnvelopeSchema = z
  .object({ data: WikiSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WikiMutationEnvelope");
export const WikiAccessEnvelopeSchema = z
  .object({
    data: z
      .object({
        access: WikiAccessSchema,
        memberIds: z.array(z.string().min(1).max(256)).max(500),
        workspaceMembers: z
          .array(
            z
              .object({
                id: z.string().min(1).max(256),
                email: z.string().max(320),
                name: z.string().max(320),
                avatarUrl: z.string().max(2_048).nullable(),
                role: z.enum(["admin", "member"]),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WikiAccessEnvelope");
export const CreateWikiBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    access: WikiAccessSchema.default("workspace"),
    instructions: z.string().max(20_000).optional(),
  })
  .strict()
  .openapi("CreateWikiBody");
export const UpdateWikiBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    instructions: z.string().max(20_000).optional(),
  })
  .strict()
  .refine(
    (body: { name?: string; instructions?: string }) =>
      body.name !== undefined || body.instructions !== undefined,
    { message: "A wiki name or instructions are required." },
  )
  .openapi("UpdateWikiBody");
export const SetWikiAccessBodySchema = z
  .object({
    access: WikiAccessSchema,
    memberIds: z.array(z.string().min(1).max(256)).max(500).default([]),
  })
  .strict()
  .openapi("SetWikiAccessBody");

export const WikiPageListEnvelopeSchema = z
  .object({ data: z.array(WikiPageSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WikiPageListEnvelope");
export const WikiPageMutationEnvelopeSchema = z
  .object({
    data: z
      .object({
        page: WikiPageSchema,
        transactionIds: z.array(z.number().int().min(1)),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WikiPageMutationEnvelope");
export const WikiPageDeleteEnvelopeSchema = z
  .object({
    data: z
      .object({
        deletedPaths: z.array(z.string().min(1).max(512)),
        transactionIds: z.array(z.number().int().min(1)),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WikiPageDeleteEnvelope");
export const WikiTimelineMutationEnvelopeSchema = z
  .object({
    data: z
      .object({ entry: WikiTimelineEntrySchema, transactionId: z.number().int().min(0) })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WikiTimelineMutationEnvelope");
export const WikiSourceListEnvelopeSchema = z
  .object({ data: z.array(WikiSourceSchema).max(1_000), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WikiSourceListEnvelope");
export const WikiIngestActivityListEnvelopeSchema = z
  .object({
    data: z
      .object({
        items: z.array(WikiIngestActivityItemSchema).max(100),
        nextCursor: z.string().max(1_024).nullable(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WikiIngestActivityListEnvelope");
export const WikiSourceMutationEnvelopeSchema = z
  .object({ data: WikiSourceSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WikiSourceMutationEnvelope");
export const WikiSourceDeleteEnvelopeSchema = z
  .object({
    data: z.object({ sourceId: ResourceIdSchema, deleted: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WikiSourceDeleteEnvelope");
export const UpsertWikiSourceBodySchema = z
  .object({
    integrationId: ResourceIdSchema,
    provider: WikiSourceProviderSchema,
    enabled: z.boolean(),
    config: WikiSourceConfigSchema.optional(),
  })
  .strict()
  .openapi("UpsertWikiSourceBody");
export const SetWikiSourceEnabledBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi("SetWikiSourceEnabledBody");
export const CreateWikiPageBodySchema = z
  .object({
    wikiId: ResourceIdSchema.optional(),
    clientPageId: ResourceIdSchema.optional(),
    nodeType: WikiNodeTypeSchema.default("page"),
    parentPath: z.string().min(1).max(512).nullable(),
    title: z.string().max(160),
    slug: z.string().min(1).max(80).optional(),
  })
  .strict()
  .openapi("CreateWikiPageBody");
export const UpdateWikiPageBodySchema = z
  .object({
    wikiId: ResourceIdSchema.optional(),
    body: z.string().max(1_000_000).optional(),
    kind: WikiKindSchema.optional(),
    slug: z.string().min(1).max(80).optional(),
    title: z.string().max(160).optional(),
  })
  .strict()
  .refine(
    (body: {
      body?: string;
      kind?: z.infer<typeof WikiKindSchema>;
      slug?: string;
      title?: string;
    }) =>
      body.body !== undefined ||
      body.kind !== undefined ||
      body.slug !== undefined ||
      body.title !== undefined,
    { message: "At least one Wiki field is required." },
  )
  .openapi("UpdateWikiPageBody");
export const DeleteWikiPageBodySchema = z
  .object({ wikiId: ResourceIdSchema.optional(), recursive: z.boolean().optional() })
  .strict()
  .openapi("DeleteWikiPageBody");
export const AddWikiTimelineEntryBodySchema = z
  .object({
    wikiId: ResourceIdSchema.optional(),
    clientEntryId: ResourceIdSchema.optional(),
    text: z.string().min(1).max(20_000),
    at: TimestampSchema.optional(),
  })
  .strict()
  .openapi("AddWikiTimelineEntryBody");

// Derive the internal runtime validator from the exact JSON Schema advertised
// to AI-SDK and MCP clients. Provider-generated empty placeholders are removed
// first; command-specific requirements remain domain errors from the command
// service, allowing the model to correct a malformed invocation.
export const WikiCommandSchema = z.preprocess(
  normalizeWikiToolInput,
  z.fromJSONSchema(WIKI_TOOL_INPUT_JSON_SCHEMA),
) as z.ZodType<WikiToolInput>;

// Body of POST /internal/wiki/commands. The API never trusts the caller-supplied
// tenancy: it reloads the user, onboarding, membership, role, and
// permissions from Postgres before executing the command.
export const InternalWikiCommandRequestSchema = z
  .object({
    userWorkosId: z.string().min(1).max(256),
    workspaceId: z.string().min(1).max(256),
    // Which wiki to operate on. Absent means the workspace's default wiki.
    wikiId: z.string().min(1).max(256).optional(),
    command: WikiCommandSchema,
  })
  .strict();

export type WikiCommandRequest = z.infer<typeof InternalWikiCommandRequestSchema>;

// Response envelope: the tool output ({ ok, result } | { ok, error }) under `data`.
export const InternalWikiCommandResponseSchema = z
  .object({
    data: z.union([
      z
        .object({
          ok: z.literal(true),
          result: z.unknown(),
          wikiContext: z
            .object({
              wiki: z.object({ id: z.string(), name: z.string(), slug: z.string() }).strict(),
              instructions: z.string(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          error: z.string(),
          wikiContext: z
            .object({
              wiki: z.object({ id: z.string(), name: z.string(), slug: z.string() }).strict(),
              instructions: z.string(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
    meta: ProtocolMetadataSchema,
  })
  .strict();

export const SkillListEnvelopeSchema = z
  .object({ data: z.array(SkillListItemSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillListEnvelope");
export const SkillCatalogEnvelopeSchema = z
  .object({ data: z.array(SkillCatalogItemSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillCatalogEnvelope");
export const SkillImportPreviewBodySchema = z
  .object({
    url: z.string().min(1).max(2_048),
    selectedPath: z.string().max(512).optional(),
  })
  .strict()
  .openapi("SkillImportPreviewBody");
export const SkillImportPreviewEnvelopeSchema = z
  .object({ data: SkillImportPreviewSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillImportPreviewEnvelope");
export const ImportSkillBodySchema = SkillImportPreviewBodySchema.extend({
  scope: SkillScopeSchema.optional(),
  expectedResolvedCommit: z.string().regex(/^[0-9a-f]{40}$/iu),
  expectedIntegrity: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
})
  .strict()
  .openapi("ImportSkillBody");
export const WorkspaceSkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const CreateWorkspaceSkillBodySchema = z
  .object({
    name: WorkspaceSkillNameSchema,
    scope: SkillScopeSchema.optional(),
    description: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value: string) => !value.includes("\0"), {
        message: "Skill descriptions must not contain NUL characters.",
      }),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(512 * 1_024)
      .refine((value: string) => !value.includes("\0"), {
        message: "Skill instructions must not contain NUL characters.",
      }),
  })
  .strict()
  .openapi("CreateWorkspaceSkillBody");
export const UpdateWorkspaceSkillBodySchema = CreateWorkspaceSkillBodySchema.omit({
  name: true,
  scope: true,
})
  .extend({ expectedBundleId: z.string().trim().min(1).max(200).optional() })
  .strict()
  .openapi("UpdateWorkspaceSkillBody");
export const SkillImportEnvelopeSchema = z
  .object({
    data: z.object({ installation: SkillInstallationSchema, replayed: z.boolean() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("SkillImportEnvelope");
export const SkillInstallationEnvelopeSchema = z
  .object({ data: SkillInstallationSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillInstallationEnvelope");
export const SkillFileChunkSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    executable: z.boolean(),
    sizeBytes: z.number().int().min(0),
    offset: z.number().int().min(0),
    nextOffset: z.number().int().min(0),
    eof: z.boolean(),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  })
  .strict()
  .openapi("SkillFileChunk");
export const SkillFileChunkEnvelopeSchema = z
  .object({ data: SkillFileChunkSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillFileChunkEnvelope");
export const SkillArchiveEnvelopeSchema = z
  .object({
    data: z.object({ name: z.string().min(1).max(64) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("SkillArchiveEnvelope");

export const PluginImportPreviewBodySchema = z
  .object({
    url: z.string().min(1).max(2_048),
    selectedPath: z.string().max(512).optional(),
  })
  .strict()
  .openapi("PluginImportPreviewBody");
export const InstallPluginBodySchema = PluginImportPreviewBodySchema.extend({
  expectedResolvedCommit: z.string().regex(/^[0-9a-f]{40}$/iu),
  expectedIntegrity: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
})
  .strict()
  .openapi("InstallPluginBody");
export const ApprovePluginMcpBodySchema = z
  .object({ integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/iu) })
  .strict()
  .openapi("ApprovePluginMcpBody");
export const SetPluginEventEnabledBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi("SetPluginEventEnabledBody");
export const PluginListEnvelopeSchema = z
  .object({ data: z.array(PluginListItemSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("PluginListEnvelope");
export const PluginInstallationEnvelopeSchema = z
  .object({ data: PluginInstallationSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("PluginInstallationEnvelope");
export const PluginImportPreviewEnvelopeSchema = z
  .object({ data: PluginImportPreviewSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("PluginImportPreviewEnvelope");
export const PluginImportEnvelopeSchema = z
  .object({
    data: z.object({ plugin: PluginInstallationSchema, replayed: z.boolean() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("PluginImportEnvelope");
export const PluginArchiveEnvelopeSchema = z
  .object({
    data: z.object({ name: z.string().min(1).max(64) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("PluginArchiveEnvelope");
export const PluginDataDeleteEnvelopeSchema = z
  .object({
    data: z.object({ name: z.string().min(1).max(64), deleted: z.boolean() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("PluginDataDeleteEnvelope");

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

export type GitHubRepositoryAccessItemDto = {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
};

export type GitHubInstallationAccessDto = {
  id: string;
  account: {
    id: string;
    login: string;
    type: "Organization" | "User";
    avatarUrl: string | null;
    htmlUrl: string | null;
  };
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  pendingPermissions: string[];
  suspendedAt: string | null;
  repositories: GitHubRepositoryAccessItemDto[];
};

export type GitHubRepositoryAccessTargetDto = {
  owner: string;
  repo: string | null;
  state: "available" | "missing_installation" | "missing_repository" | "suspended";
};

export type GitHubRepositoryAccessDto = {
  checkedAt: string;
  installations: GitHubInstallationAccessDto[];
  target: GitHubRepositoryAccessTargetDto | null;
};

export const GitHubRepositoryAccessItemSchema: z.ZodType<GitHubRepositoryAccessItemDto> = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    fullName: z.string().min(1),
    private: z.boolean(),
    htmlUrl: z.url(),
  })
  .strict();

export const GitHubInstallationAccessSchema: z.ZodType<GitHubInstallationAccessDto> = z
  .object({
    id: z.string().min(1),
    account: z
      .object({
        id: z.string().min(1),
        login: z.string().min(1),
        type: z.enum(["Organization", "User"]),
        avatarUrl: z.url().nullable(),
        htmlUrl: z.url().nullable(),
      })
      .strict(),
    repositorySelection: z.enum(["all", "selected"]),
    permissions: z.record(z.string(), z.string()),
    pendingPermissions: z.array(z.string()),
    suspendedAt: TimestampSchema.nullable(),
    repositories: z.array(GitHubRepositoryAccessItemSchema),
  })
  .strict();

export const GitHubRepositoryAccessTargetSchema: z.ZodType<GitHubRepositoryAccessTargetDto> = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1).nullable(),
    state: z.enum(["available", "missing_installation", "missing_repository", "suspended"]),
  })
  .strict();

export const GitHubRepositoryAccessSchema: z.ZodType<GitHubRepositoryAccessDto> = z
  .object({
    checkedAt: TimestampSchema,
    installations: z.array(GitHubInstallationAccessSchema),
    target: GitHubRepositoryAccessTargetSchema.nullable(),
  })
  .strict();

export const BillingOverviewSchema = z
  .object({
    creditBalanceUsdMicros: z.number().int(),
    includedBalanceUsdMicros: z.number().int().min(0),
    topUpBalanceUsdMicros: z.number().int().min(0),
    plan: z.enum(["hobby", "pro"]),
    subscriptionStatus: z.string().max(64).nullable(),
    seatQuantity: z.number().int().min(0),
    includedUsagePeriodEnd: TimestampSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEnd: TimestampSchema.nullable(),
    paymentNeedsAttention: z.boolean(),
    proMonthlyPriceCents: z.number().int().min(0),
    hobbyIncludedUsageCents: z.number().int().min(0),
    memberCount: z.number().int().min(0),
    memberCap: z.number().int().min(0),
    spendThisMonthUsdMicros: z.number().int().min(0),
    spendThisMonthByCategory: z
      .object({
        chat: z.number().int().min(0),
        ingestion: z.number().int().min(0),
        capabilities: z.number().int().min(0),
        sandbox: z.number().int().min(0),
      })
      .strict(),
    recentActivity: z.array(
      z
        .object({
          activityId: ResourceIdSchema,
          source: z.string().min(1).max(128),
          amountUsdMicros: z.number().int(),
          providerCostUsdMicros: z.number().int().min(0),
          platformFeeUsdMicros: z.number().int().min(0),
          capabilityAction: z.string().max(256).nullable(),
          isAutoRefill: z.boolean(),
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    lowBalanceWarnUsdMicros: z.number().int().min(0),
    includedUsagePerSeatCents: z.number().int().min(0),
    topUpAmountsCents: z.array(z.number().int().min(1)).max(20),
    defaultTopUpCents: z.number().int().min(1),
    minTopUpCents: z.number().int().min(1),
    maxTopUpCents: z.number().int().min(1),
    autoRefillMonthlyMaxCents: z.number().int().min(1),
    autoRefill: z
      .object({
        enabled: z.boolean(),
        amountCents: z.number().int().min(0),
        hasPaymentMethod: z.boolean(),
        lastError: z.string().max(1_000).nullable(),
      })
      .strict(),
    isAdmin: z.boolean(),
  })
  .strict()
  .openapi("BillingOverview");

export const BillingUsageSchema = z
  .object({
    breakdown: z.array(
      z
        .object({
          day: z.string().min(1).max(32),
          category: z.enum(["chat", "ingestion", "capabilities", "sandbox", "other"]),
          spendUsdMicros: z.number().int().min(0),
          providerCostUsdMicros: z.number().int().min(0),
          platformFeeUsdMicros: z.number().int().min(0),
        })
        .strict(),
    ),
    ingestedThisMonth: z.number().int().min(0),
    pending: z.number().int().min(0),
    creditBalanceUsdMicros: z.number().int(),
    providers: z.array(
      z.object({ provider: z.string().min(1).max(128), count: z.number().int().min(0) }).strict(),
    ),
    recent: z.array(
      z
        .object({
          activityId: ResourceIdSchema,
          provider: z.string().min(1).max(128),
          rawEventCount: z.number().int().min(0),
          status: z.enum(["pending", "consumed"]),
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("BillingUsage");

export const BillingBalanceSchema = z
  .object({
    balanceUsdMicros: z.number().int(),
    lowBalanceWarnUsdMicros: z.number().int().min(0),
    enforcementEnabled: z.boolean(),
  })
  .strict()
  .openapi("BillingBalance");

export const CreateBillingTopUpBodySchema = z
  .object({ amountCents: z.number().int().min(1) })
  .strict()
  .openapi("CreateBillingTopUpBody");
export const UpdateBillingAutoRefillBodySchema = z
  .object({ enabled: z.boolean(), amountCents: z.number().int().min(1) })
  .strict()
  .openapi("UpdateBillingAutoRefillBody");
export const BillingOverviewEnvelopeSchema = z
  .object({ data: BillingOverviewSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BillingOverviewEnvelope");
export const BillingUsageEnvelopeSchema = z
  .object({ data: BillingUsageSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BillingUsageEnvelope");
export const BillingBalanceEnvelopeSchema = z
  .object({ data: BillingBalanceSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BillingBalanceEnvelope");
export const BillingRedirectEnvelopeSchema = z
  .object({
    data: z.object({ redirectUrl: z.url() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BillingRedirectEnvelope");
export const BillingAutoRefillEnvelopeSchema = z
  .object({
    data: z.object({ updated: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BillingAutoRefillEnvelope");

export const ConversationPageSchema = z
  .object({
    data: z.array(ConversationSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ConversationPage");

export const SessionPullRequestSchema = z
  .object({
    conversationId: z.string(),
    repository: z.string(),
    number: z.number().int().positive(),
    url: z.string(),
    state: z.enum(["draft", "open", "blocked", "merged", "closed"]),
  })
  .strict()
  .openapi("SessionPullRequest");

export const SessionPullRequestListSchema = z
  .object({
    data: z.array(SessionPullRequestSchema),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("SessionPullRequestList");

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
    // Company keeps the pre-scope behavior for clients that do not send a scope yet.
    scope: WorkflowScopeSchema.optional(),
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
    // Omitted leaves the current visibility untouched.
    scope: WorkflowScopeSchema.optional(),
    // Omitted leaves the current channel configuration untouched.
    slackChannel: WorkflowSlackChannelSchema.optional(),
    trigger: WorkflowTriggerInputSchema,
    triggers: z.array(WorkflowAutomationTriggerInputSchema).max(20).optional(),
  })
  .strict()
  .openapi("UpdateWorkflowBody");

// The workflow's single markdown memory. `updatedAt` is null until a run writes one.
export const WorkflowMemorySchema = z
  .object({
    workflowId: ResourceIdSchema,
    enabled: z.boolean(),
    content: z.string(),
    updatedAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("WorkflowMemory");

export const WorkflowMemoryEnvelopeSchema = z
  .object({ data: WorkflowMemorySchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WorkflowMemoryEnvelope");

export const UpdateWorkflowMemoryBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi("UpdateWorkflowMemoryBody");

export const ArchiveVersionBodySchema = z
  .object({ expectedVersion: z.number().int().min(1) })
  .strict()
  .openapi("ArchiveVersionBody");

// --- Company agents -------------------------------------------------------------------------
// An agent is one standing responsibility with one set of instructions, so it has no step list.
// Shared-bot display overrides use `name` and `photoUrl`; dedicated profiles are managed in Slack.

export const CompanyAgentSlackSchema = z
  .object({
    installed: z.boolean(),
    ready: z.boolean(),
    status: z.string(),
    statusReason: z.string().nullable(),
    teamName: z.string().nullable(),
    appUrl: z.string().nullable(),
    openUrl: z.string().nullable(),
    eventsUrl: z.string(),
    createUrl: z.string(),
    manifest: z.string(),
    provisioning: z
      .object({ configured: z.boolean(), state: z.string(), reason: z.string().nullable() })
      .optional(),
  })
  .strict()
  .openapi("CompanyAgentSlack");
export const CompanyAgentSlackEnvelopeSchema = z
  .object({ data: CompanyAgentSlackSchema, meta: ProtocolMetadataSchema })
  .strict();
export const ConnectCompanyAgentSlackBodySchema = z.union([
  z.object({}).strict(),
  z
    .object({
      botToken: z
        .string()
        .trim()
        .regex(/^xoxb-[A-Za-z0-9-]+$/)
        .max(500),
      signingSecret: z
        .string()
        .trim()
        .regex(/^[a-fA-F0-9]{32}$/),
    })
    .strict(),
]);
export type CompanyAgentSlackDto = z.infer<typeof CompanyAgentSlackSchema>;

export const CompanyAgentStatusSchema = z.enum(["active", "paused"]).openapi("CompanyAgentStatus");

export const CompanyAgentSchema = z
  .object({
    id: ResourceIdSchema,
    slug: z.string().min(1).max(80),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
    instructions: z.string().max(20_000),
    photoUrl: z.string().max(2_048),
    model: z.string().max(256),
    runtimeModel: z.string().max(256).optional(),
    reasoningEffort: z.string().max(64).optional(),
    status: CompanyAgentStatusSchema,
    // The member whose authorized connections execute this agent's work. Null once that member
    // leaves the workspace, which blocks runs rather than reassigning them.
    ownerUserId: z.string().max(256).nullable(),
    ownerActive: z.boolean(),
    slackEnabled: z.boolean(),
    triggers: z.array(WorkflowAutomationTriggerSchema).max(20),
    lastRunAt: TimestampSchema.nullable(),
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("CompanyAgent");

export const CompanyAgentPageSchema = z
  .object({
    data: z.array(CompanyAgentSchema),
    nextCursor: z.string().nullable(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CompanyAgentPage");

export const CompanyAgentEnvelopeSchema = z
  .object({ data: CompanyAgentSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CompanyAgentEnvelope");

export const CreateCompanyAgentBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(1_024).optional(),
  })
  .strict()
  .openapi("CreateCompanyAgentBody");

export const UpdateCompanyAgentBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
    instructions: z.string().max(20_000),
    photoUrl: z.string().max(2_048),
    model: z.string().max(256),
    runtimeModel: z.string().max(256).optional(),
    reasoningEffort: z.string().max(64).optional(),
    status: CompanyAgentStatusSchema,
    slackEnabled: z.boolean(),
    triggers: z.array(WorkflowAutomationTriggerInputSchema).max(20),
  })
  .strict()
  .openapi("UpdateCompanyAgentBody");

export const CompanyAgentMutationEnvelopeSchema = z
  .object({
    data: z
      .object({
        agent: CompanyAgentSchema,
        transactionId: z.string().regex(/^[0-9]+$/u),
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CompanyAgentMutationEnvelope");

export const CompanyAgentUpdateEnvelopeSchema = z
  .object({
    data: z
      .object({ agent: CompanyAgentSchema, transactionId: z.string().regex(/^[0-9]+$/u) })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CompanyAgentUpdateEnvelope");

export const CompanyAgentRunSchema = z
  .object({
    id: ResourceIdSchema,
    // Null on a blocked run: the event matched, but no work was ever started.
    taskId: ResourceIdSchema.nullable(),
    displayId: z.string().max(64).nullable(),
    conversationId: ResourceIdSchema.nullable(),
    name: z.string().max(256),
    status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "canceled", "blocked"]),
    triggerKind: z.enum(["manual", "schedule", "event"]),
    triggerLabel: z.string().max(256),
    result: z.string().nullable(),
    error: z.string().nullable(),
    awaitingInput: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("CompanyAgentRun");

export const CompanyAgentRunPageSchema = z
  .object({ data: z.array(CompanyAgentRunSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CompanyAgentRunPage");

export const CompanyAgentPhotoUploadEnvelopeSchema = z
  .object({
    data: z
      .object({
        // Absolute, unauthenticated URL. Slack downloads it directly for the per-message avatar,
        // and the editor saves it onto the agent through the normal update command.
        photoUrl: z.string().url().max(2_048),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CompanyAgentPhotoUploadEnvelope");

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

export const WorkflowStepModelOverrideSchema = WorkflowStepSchema.pick({
  id: true,
  model: true,
  runtimeModel: true,
  reasoningEffort: true,
})
  .strict()
  .openapi("WorkflowStepModelOverride");

export const InvokeWorkflowBodySchema = z
  .object({
    description: z.string().min(1).max(10_000),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
    skillIds: z.array(ResourceIdSchema).max(16).optional(),
    stepModelOverrides: z.array(WorkflowStepModelOverrideSchema).max(20).optional(),
  })
  .strict()
  .openapi("InvokeWorkflowBody");

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

export const CreateTaskCommentBodySchema = z
  .object({
    id: ResourceIdSchema,
    body: z.string().max(10_000),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
  })
  .strict()
  .refine(
    (body: { body: string; attachmentIds?: string[] }) =>
      Boolean(body.body.trim()) || Boolean(body.attachmentIds?.length),
    { message: "body or an attachment is required" },
  )
  .openapi("CreateTaskCommentBody");

export const TaskCommentSchema = z
  .object({
    id: ResourceIdSchema,
    taskId: ResourceIdSchema,
    author: z.literal("user"),
    kind: z.literal("comment"),
    body: z.string().max(10_000),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("TaskComment");

export const CreateTaskCommentEnvelopeSchema = z
  .object({
    data: z
      .object({
        task: TaskSchema,
        comment: TaskCommentSchema,
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
  .openapi("CreateTaskCommentEnvelope");

export const UpdateTaskBodySchema = z
  .union([
    z.object({ archived: z.boolean() }).strict(),
    z.object({ name: z.string().min(1).max(160) }).strict(),
    z.object({ markSeen: z.literal(true) }).strict(),
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

export const ConversationShareEnvelopeSchema = z
  .object({ data: ConversationShareSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("ConversationShareEnvelopeV1");

export const GenerateConversationTitleBodySchema = z
  .object({ messageId: ResourceIdSchema })
  .strict()
  .openapi("GenerateConversationTitleBodyV1");

export const GenerateConversationTitleEnvelopeSchema = z
  .object({
    data: z
      .object({
        conversationId: ResourceIdSchema,
        title: z.string().nullable(),
        generated: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("GenerateConversationTitleEnvelopeV1");

export const PublicChatShareEnvelopeSchema = z
  .object({ data: PublicChatShareSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("PublicChatShareEnvelopeV1");

export const PublicChatShareMetadataEnvelopeSchema = z
  .object({ data: PublicChatShareMetadataSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("PublicChatShareMetadataEnvelopeV1");

export const ChatArtifactDeleteEnvelopeSchema = z
  .object({
    data: z.object({ artifactId: ResourceIdSchema, state: z.literal("deleted") }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ChatArtifactDeleteEnvelopeV1");

export const ChatArtifactVersionSchema = z
  .object({
    artifactVersionId: ResourceIdSchema,
    version: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().optional(),
    filename: z.string().min(1),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().min(0),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("ChatArtifactVersionV1");

export const ChatArtifactVersionListEnvelopeSchema = z
  .object({
    data: z
      .object({
        artifactId: ResourceIdSchema,
        currentVersion: z.number().int().positive(),
        versions: z.array(ChatArtifactVersionSchema),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ChatArtifactVersionListEnvelopeV1");

export const MessagePresentationEnvelopeSchema = z
  .object({ data: MessagePresentationSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("MessagePresentationEnvelopeV1");

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
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("AttachmentUploadEnvelope");

export const WorkflowSlackAvatarUploadBodySchema = z
  .object({
    file: z
      .file()
      .max(1024 * 1024)
      .openapi({ type: "string", format: "binary" }),
  })
  .strict()
  .openapi("WorkflowSlackAvatarUploadBody");

export const WorkflowSlackAvatarUploadEnvelopeSchema = z
  .object({
    data: z
      .object({
        // Absolute, unauthenticated URL. The caller saves it onto the workflow through the normal
        // update command; uploading alone does not change the workflow.
        avatarUrl: z.string().url().max(2_048),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkflowSlackAvatarUploadEnvelope");

export const CreateMessageBodySchema = z
  .object({
    conversationId: ResourceIdSchema.optional(),
    clientConversationId: ResourceIdSchema.optional(),
    clientMessageId: ResourceIdSchema.optional(),
    content: z.string().max(10_000),
    engine: MessageEngineSchema,
    model: z.string().min(1).max(256).optional(),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
    mentions: z.array(MessageMentionSchema).max(16).optional(),
    // Files the Conversation this message creates under a sidebar Project. Only meaningful for a
    // new Conversation; an existing one is moved through the Project's own membership routes.
    projectId: ResourceIdSchema.optional(),
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
    (body: { conversationId?: string; projectId?: string }) =>
      !(body.conversationId && body.projectId),
    { message: "projectId applies only to a new conversation" },
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

export const SteerRunEnvelopeSchema = z
  .object({
    data: z.object({
      // The queued Run whose message was promoted, and the running Run it was promoted into.
      runId: ResourceIdSchema,
      targetRunId: ResourceIdSchema,
    }),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("SteerRunEnvelope");

export const ResolveApprovalBodySchema = z
  .object({
    resolution: z.enum(["approved", "denied", "answered", "canceled"]),
    answer: z
      .union([
        z.string().max(10_000),
        z
          .object({
            type: z.literal("engine_questions"),
            schemaVersion: z.literal(1),
            answers: z
              .record(
                ResourceIdSchema,
                z.object({ answers: z.array(z.string().min(1).max(4_000)).min(1).max(8) }).strict(),
              )
              .refine(
                (answers: Record<string, { answers: string[] }>) =>
                  Object.values(answers).reduce(
                    (total, entry) =>
                      total + entry.answers.reduce((sum, answer) => sum + answer.length, 0),
                    0,
                  ) <= 12_000,
                { message: "The engine answers are too long." },
              ),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (body: {
      resolution: "approved" | "denied" | "answered" | "canceled";
      answer?: string | { type: "engine_questions"; schemaVersion: 1 };
    }) =>
      body.resolution !== "answered" ||
      (typeof body.answer === "string" ? Boolean(body.answer.trim()) : Boolean(body.answer)),
    { message: "answer is required when resolution is answered" },
  )
  .refine(
    (body: { resolution: "approved" | "denied" | "answered" | "canceled"; answer?: unknown }) =>
      body.resolution === "answered" || body.answer === undefined,
    { message: "answer is only valid when resolution is answered" },
  )
  .openapi("ResolveApprovalBody");

export type ResolveApprovalBody = z.input<typeof ResolveApprovalBodySchema>;

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

export const BrowserProfileSchema = z
  .object({
    id: ResourceIdSchema,
    name: z.string().min(1).max(80),
    siteHost: z.string().min(1).max(255),
    allowedHosts: z.array(z.string().min(1).max(255)).max(50),
    status: z.enum(["pending_login", "connected", "needs_reauth", "disconnected"]),
    active: z.boolean(),
    lastUsedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("BrowserProfile");

export const BrowserProfileListEnvelopeSchema = z
  .object({ data: z.array(BrowserProfileSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrowserProfileListEnvelope");

export const BrowserProfileEnvelopeSchema = z
  .object({ data: BrowserProfileSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrowserProfileEnvelope");

export const CreateBrowserProfileBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    url: z.string().min(1).max(2_048),
  })
  .strict()
  .openapi("CreateBrowserProfileBody");

export const BrowserProfileDeleteEnvelopeSchema = z
  .object({
    data: z.object({ profileId: ResourceIdSchema, deleted: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrowserProfileDeleteEnvelope");

export const BrowserProfileLoginSessionSchema = z
  .object({
    profileId: ResourceIdSchema,
    sessionId: z.string().min(1).max(256),
    liveViewUrl: z.url().max(4_096),
  })
  .strict()
  .openapi("BrowserProfileLoginSession");

export const BrowserProfileLoginSessionEnvelopeSchema = z
  .object({ data: BrowserProfileLoginSessionSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrowserProfileLoginSessionEnvelope");

export const BrowserProfileLoginCompleteEnvelopeSchema = z
  .object({
    data: z
      .object({
        profileId: ResourceIdSchema,
        sessionId: z.string().min(1).max(256),
        completed: z.literal(true),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrowserProfileLoginCompleteEnvelope");

export const BrowserProfileLiveViewEnvelopeSchema = z
  .object({
    data: z.object({ url: z.url().max(4_096) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrowserProfileLiveViewEnvelope");

// Workspace capabilities and their browser-polled approval reads (#1203
// 5a4b). Approval mutations remain on the universal-Chat boundary.
export const ManagedCapabilitySourceSchema = z.enum([
  "x",
  "linkedin",
  "youtube",
  "instagram",
  "tiktok",
  "lead",
  "seo",
  "image",
]);

export const WorkspaceCapabilitySchema = z
  .object({ source: ManagedCapabilitySourceSchema, enabled: z.boolean() })
  .strict()
  .openapi("WorkspaceCapability");

export const WorkspaceCapabilitySettingsEnvelopeSchema = z
  .object({
    data: z
      .object({
        capabilities: z.array(WorkspaceCapabilitySchema),
        sessionBudgetUsdMicros: z.number().int().min(1),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkspaceCapabilitySettingsEnvelope");

export const SetWorkspaceCapabilityBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi("SetWorkspaceCapabilityBody");

export const WorkspaceCapabilityMutationEnvelopeSchema = z
  .object({ data: WorkspaceCapabilitySchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WorkspaceCapabilityMutationEnvelope");

export const SetCapabilitySessionBudgetBodySchema = z
  .object({ budgetUsd: z.number().nullable() })
  .strict()
  .openapi("SetCapabilitySessionBudgetBody");

export const CapabilitySessionBudgetEnvelopeSchema = z
  .object({
    data: z.object({ sessionBudgetUsdMicros: z.number().int().min(1) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CapabilitySessionBudgetEnvelope");

export const PluginBillingSchema = z
  .object({
    pluginName: z.string().min(1).max(64),
    pricing: PluginPricingSchema.nullable(),
    dailyLimitUsdMicros: z.number().int().min(1).nullable(),
    spentTodayUsdMicros: z.number().int().min(0),
  })
  .strict()
  .openapi("PluginBilling");

export const PluginBillingEnvelopeSchema = z
  .object({ data: PluginBillingSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("PluginBillingEnvelope");

export const SetPluginDailySpendLimitBodySchema = z
  .object({ dailyLimitUsd: z.number().nullable() })
  .strict()
  .openapi("SetPluginDailySpendLimitBody");

export const CapabilityApprovalStatusSchema = z.enum([
  "awaiting_approval",
  "approved",
  "canceled",
  "expired",
  "executing",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "stopped",
  "timed_out",
]);

export const CapabilityApprovalSchema = z
  .object({
    runId: ResourceIdSchema,
    source: ManagedCapabilitySourceSchema,
    action: z.string().min(1).max(256),
    status: CapabilityApprovalStatusSchema,
    maxCostUsdMicros: z.number().int().min(0),
    expiresAt: TimestampSchema.nullable(),
    settledCostUsdMicros: z.number().int().min(0).nullable(),
    sessionBudgetUsdMicros: z.number().int().min(1).optional(),
  })
  .strict()
  .openapi("CapabilityApproval");

export const CapabilityApprovalEnvelopeSchema = z
  .object({ data: CapabilityApprovalSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CapabilityApprovalEnvelope");

export const WorkspaceMemberSchema = z
  .object({
    id: ResourceIdSchema,
    email: z.email().max(320),
    name: z.string().min(1).max(512),
    firstName: z.string().max(256).nullable(),
    lastName: z.string().max(256).nullable(),
    avatarUrl: z.string().max(4_096).nullable(),
    role: z.enum(["admin", "member"]),
  })
  .strict()
  .openapi("WorkspaceMember");

export const WorkspaceInvitationSchema = z
  .object({
    id: ResourceIdSchema,
    email: z.email().max(320),
    state: z.string().min(1).max(64),
    expiresAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("WorkspaceInvitation");

export const WorkspaceSettingsSchema = z
  .object({
    workspace: z.object({ id: ResourceIdSchema, name: z.string().min(1).max(80) }).strict(),
    role: z.enum(["admin", "member"]),
    plan: z.enum(["hobby", "pro"]),
    memberCap: z.number().int().min(1),
    members: z.array(WorkspaceMemberSchema).max(1_000),
    invitations: z.array(WorkspaceInvitationSchema).max(1_000),
  })
  .strict()
  .openapi("WorkspaceSettings");

export const WorkspaceSettingsEnvelopeSchema = z
  .object({ data: WorkspaceSettingsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WorkspaceSettingsEnvelope");

export const InviteWorkspaceMemberBodySchema = z
  .object({ email: z.email().max(320) })
  .strict()
  .openapi("InviteWorkspaceMemberBody");

export const RenameWorkspaceBodySchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict()
  .openapi("RenameWorkspaceBody");

export const WorkspaceRenameEnvelopeSchema = z
  .object({
    data: z.object({ id: ResourceIdSchema, name: z.string().min(1).max(80) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkspaceRenameEnvelope");

// Machine size for the workspace's cloud coding sandboxes. Mirrors
// `SANDBOX_SIZES` in @opencompany/core; the wire contract keeps its own literal
// list so the protocol package stays dependency-free, like
// ManagedCapabilitySourceSchema above.
export const SandboxSizeSchema = z.enum(["small", "standard", "large"]);

export const WorkspaceSandboxSizeEnvelopeSchema = z
  .object({
    data: z.object({ sandboxSize: SandboxSizeSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkspaceSandboxSizeEnvelope");

export const SetWorkspaceSandboxSizeBodySchema = z
  .object({ sandboxSize: SandboxSizeSchema })
  .strict()
  .openapi("SetWorkspaceSandboxSizeBody");

export const WorkspaceCommandEnvelopeSchema = z
  .object({
    data: z.object({ completed: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkspaceCommandEnvelope");

const WorkspaceCreationIdSchema = ResourceIdSchema.regex(/^(?:workspace_|goat_ws_)/u, {
  message: "workspaceId must be an opencompany workspace id.",
});

export const CreateWorkspaceBodySchema = z
  .object({
    workspaceId: WorkspaceCreationIdSchema,
    name: z.string().trim().min(1).max(80),
  })
  .strict()
  .openapi("CreateWorkspaceBody");

export const WorkspaceActivationSchema = z
  .object({
    workspaceId: ResourceIdSchema,
    organizationId: ResourceIdSchema,
  })
  .strict()
  .openapi("WorkspaceActivation");

export const WorkspaceActivationEnvelopeSchema = z
  .object({ data: WorkspaceActivationSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WorkspaceActivationEnvelope");

export const OnboardingRoleSchema = z.enum([
  "founder",
  "product",
  "sales",
  "marketing",
  "operations",
  "investing",
  "consulting",
  "research",
]);

export const OnboardingStateSchema = z
  .object({
    onboarding: z
      .object({
        role: z.string().nullable(),
        companyDomain: z.string().nullable(),
        contextUrls: z.array(z.url()).max(20).nullable(),
        referralSource: z.string().nullable(),
      })
      .strict()
      .nullable(),
    workspace: z
      .object({
        id: ResourceIdSchema,
        name: z.string().min(1).max(80),
        slug: z.string().max(40).nullable(),
        createdByCaller: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .openapi("OnboardingState");

export const OnboardingStateEnvelopeSchema = z
  .object({ data: OnboardingStateSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("OnboardingStateEnvelope");

export const SaveOnboardingProfileBodySchema = z
  .object({ role: OnboardingRoleSchema, companyUrl: z.url().max(2_048) })
  .strict()
  .openapi("SaveOnboardingProfileBody");

// The slug is derived from the name server-side; onboarding never asks for one.
export const SaveOnboardingWorkspaceBodySchema = z
  .object({
    workspaceId: WorkspaceCreationIdSchema,
    name: z.string().trim().min(1).max(80),
  })
  .strict()
  .openapi("SaveOnboardingWorkspaceBody");

export const OnboardingWorkspaceEnvelopeSchema = z
  .object({
    data: z
      .object({
        workspaceId: ResourceIdSchema,
        organizationId: ResourceIdSchema,
        createdByCaller: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("OnboardingWorkspaceEnvelope");

export const FinishOnboardingBodySchema = z
  .object({ referralSource: z.string().trim().max(200).nullable() })
  .strict()
  .openapi("FinishOnboardingBody");

export const OnboardingCommandEnvelopeSchema = z
  .object({
    data: z.object({ completed: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("OnboardingCommandEnvelope");

export const OnboardingEmailStepSchema = z
  .enum(["welcome", "checkin", "feedback_call"])
  .openapi("OnboardingEmailStep");

export const OnboardingEmailClaimSchema = z
  .object({
    id: ResourceIdSchema,
    workosUserId: ResourceIdSchema,
    step: OnboardingEmailStepSchema,
    attempts: z.number().int().positive(),
    email: z.email().max(320),
    firstName: z.string().max(128).nullable(),
    terminalOnFailure: z.boolean(),
  })
  .strict()
  .openapi("OnboardingEmailClaim");

export const OnboardingEmailClaimEnvelopeSchema = z
  .object({
    data: z.object({ emails: z.array(OnboardingEmailClaimSchema).max(100) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("OnboardingEmailClaimEnvelope");

export const TaskViewModeSchema = z.enum(["board", "list"]);
export const TaskTimeRangeSchema = z.enum(["24h", "2d", "7d", "30d", "90d", "all"]);
export const McpClientSchema = z.enum(["claude", "chatgpt", "cursor"]);

// Authenticated browser identity read model. Provider organization ids and raw
// persistence rows stay server-side; the web auth shell only receives the
// presentation fields its request-cached resolver needs.
export const IdentityUserSchema = z
  .object({
    id: ResourceIdSchema,
    email: z.email().max(320),
    firstName: z.string().max(128).nullable(),
    lastName: z.string().max(128).nullable(),
    avatarUrl: z.string().max(4_096).nullable(),
    timezone: z.string().min(1).max(100),
    botsEnabled: z.boolean().optional(),
    /** @deprecated Tasks & Workflows is always enabled. */
    taskSpawningEnabled: z.literal(true),
    autoModelRoutingEnabled: z.boolean(),
    approveForMeEnabled: z.boolean(),
    chatCapabilitiesBetaEnabled: z.boolean(),
    reviewInboxEnabled: z.boolean(),
    sidebarProjectsEnabled: z.boolean(),
    subagentsEnabled: z.boolean(),
    companyAgentsEnabled: z.boolean(),
    pastSessionAccessEnabled: z.boolean(),
    imessageEnabled: z.boolean(),
    whatsappEnabled: z.boolean(),
    /** @deprecated Wiki is always enabled. */
    wikiEnabled: z.literal(true),
    taskViewMode: TaskViewModeSchema,
    taskTimeRange: TaskTimeRangeSchema,
    preferredMcpClient: McpClientSchema.nullable(),
    mcpSetupCompletedAt: TimestampSchema.nullable(),
    onboardedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("IdentityUser");

export const IdentityWorkspaceSchema = z
  .object({
    id: ResourceIdSchema,
    name: z.string().min(1).max(80),
    slug: z.string().max(40).nullable(),
    role: z.enum(["admin", "member"]),
  })
  .strict()
  .openapi("IdentityWorkspace");

export const IdentitySchema = z
  .object({
    user: IdentityUserSchema,
    workspaces: z.array(IdentityWorkspaceSchema).max(1_000),
    activeWorkspaceId: ResourceIdSchema.nullable(),
  })
  .strict()
  .openapi("Identity");

export const IdentityEnvelopeSchema = z
  .object({ data: IdentitySchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("IdentityEnvelope");

export const UserPreferencesSchema = z
  .object({
    botsEnabled: z.boolean(),
    timezone: z.string().min(1).max(100),
    /** @deprecated Tasks & Workflows is always enabled. */
    taskSpawningEnabled: z.literal(true),
    /** @deprecated Wiki is always enabled. */
    wikiEnabled: z.literal(true),
    taskViewMode: TaskViewModeSchema,
    taskTimeRange: TaskTimeRangeSchema,
    autoModelRoutingEnabled: z.boolean(),
    approveForMeEnabled: z.boolean(),
    reviewInboxEnabled: z.boolean(),
    sidebarProjectsEnabled: z.boolean(),
    subagentsEnabled: z.boolean(),
    companyAgentsEnabled: z.boolean(),
    pastSessionAccessEnabled: z.boolean(),
    imessageEnabled: z.boolean(),
    whatsappEnabled: z.boolean(),
  })
  .strict()
  .openapi("UserPreferences");

export const UpdateUserPreferencesBodySchema = z
  .object({
    botsEnabled: z.boolean().optional(),
    timezone: z.string().min(1).max(100).optional(),
    /** @deprecated Accepted for compatibility and ignored; Tasks & Workflows is always enabled. */
    taskSpawningEnabled: z.boolean().optional(),
    /** @deprecated Accepted for compatibility and ignored; Wiki is always enabled. */
    wikiEnabled: z.boolean().optional(),
    taskViewMode: TaskViewModeSchema.optional(),
    taskTimeRange: TaskTimeRangeSchema.optional(),
    autoModelRoutingEnabled: z.boolean().optional(),
    approveForMeEnabled: z.boolean().optional(),
    reviewInboxEnabled: z.boolean().optional(),
    sidebarProjectsEnabled: z.boolean().optional(),
    subagentsEnabled: z.boolean().optional(),
    companyAgentsEnabled: z.boolean().optional(),
    pastSessionAccessEnabled: z.boolean().optional(),
    imessageEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((body: Record<string, unknown>) => Object.keys(body).length > 0, {
    message: "At least one preference field is required.",
  })
  .openapi("UpdateUserPreferencesBody");

export const UserPreferencesEnvelopeSchema = z
  .object({ data: UserPreferencesSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("UserPreferencesEnvelope");

export const McpSetupSchema = z
  .object({
    preferredClient: McpClientSchema.nullable(),
    complete: z.boolean(),
    completedAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("McpSetup");

export const UpdateMcpSetupBodySchema = z
  .object({ preferredClient: McpClientSchema })
  .strict()
  .openapi("UpdateMcpSetupBody");

export const McpSetupEnvelopeSchema = z
  .object({ data: McpSetupSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("McpSetupEnvelope");

export const FeedbackKindSchema = z.enum(["bug", "feedback", "idea"]);

// What the reporter had open when they hit the feedback button. Only the two
// references worth chasing a bug through — a chat session or a task — so triage
// lands on the exact run instead of guessing from the message.
export const FeedbackContextSchema = z
  .object({
    kind: z.enum(["chat", "task"]),
    id: z.string().trim().min(1).max(128),
  })
  .strict()
  .openapi("FeedbackContext");

export const SubmitFeedbackBodySchema = z
  .object({
    kind: FeedbackKindSchema,
    message: z.string().trim().min(3).max(4_000),
    context: FeedbackContextSchema.optional(),
    attachmentIds: z.array(ResourceIdSchema).max(5).optional(),
  })
  .strict()
  .openapi("SubmitFeedbackBody");

export const FeedbackSubmissionEnvelopeSchema = z
  .object({
    data: z.object({ submitted: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("FeedbackSubmissionEnvelope");

// GitHub repository ids are numeric strings; using them as the path key keeps
// repository full names (which contain "/") out of URL segments.
export const RepositoryExternalIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,63}$/u)
  .openapi({ example: "123456789", description: "Numeric GitHub repository id." });

export const WorkspaceRepositorySchema = z
  .object({
    repositoryExternalId: RepositoryExternalIdSchema,
    repositoryFullName: z.string().min(1).max(512),
    private: z.boolean(),
  })
  .strict()
  .openapi("WorkspaceRepository");

// Stored env values are secret-bearing and must never appear in responses;
// only the saved key names are exposed.
export const RepoConfigSchema = z
  .object({
    repositoryExternalId: RepositoryExternalIdSchema,
    repositoryFullName: z.string().min(1).max(512),
    envKeys: z.array(z.string().min(1).max(256)).max(512),
    setupInstructions: z.string().max(4_000),
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("RepoConfig");

export const RepoConfigListEnvelopeSchema = z
  .object({
    data: z
      .object({
        repositories: z.array(WorkspaceRepositorySchema),
        configs: z.array(RepoConfigSchema),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("RepoConfigListEnvelope");

export const SetRepoConfigEnvBodySchema = z
  .object({
    // A string replaces the stored env file; null clears it. Detailed content
    // validation happens server-side so limits produce human-readable errors.
    content: z.string().max(300_000).nullable(),
  })
  .strict()
  .openapi("SetRepoConfigEnvBody");

export const SetRepoConfigSetupBodySchema = z
  .object({ setupInstructions: z.string().max(100_000) })
  .strict()
  .openapi("SetRepoConfigSetupBody");

export const RepoConfigMutationEnvelopeSchema = z
  .object({ data: RepoConfigSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("RepoConfigMutationEnvelope");

export const RepoConfigDeleteEnvelopeSchema = z
  .object({
    data: z
      .object({ repositoryExternalId: RepositoryExternalIdSchema, deleted: z.literal(true) })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("RepoConfigDeleteEnvelope");

export const IntegrationAccountIdSchema = z
  .string()
  .min(1)
  .max(128)
  .openapi({ example: "gint_0f8e7d6c5b4a", description: "Integration connection id." });

// A connection's lifecycle status as surfaced to settings UIs. "disconnected"
// rows are filtered out server-side, so responses never carry it.
export const IntegrationAccountStatusSchema = z.enum([
  "not_connected",
  "connected",
  "needs_reauth",
  "sync_failed",
]);

export const PersonalIntegrationProviderSchema = z.enum([
  "gmail",
  "google_admin",
  "google_calendar",
  "google_drive",
  "linear",
  "github_user",
  "slack",
  "hubspot",
  "posthog",
  "granola",
  "fathom",
  "attio",
  "betterstack",
  "convex",
  "render",
  "vercel",
  "signoz",
  "dash0",
  "latitude",
  "neon",
  "supabase",
  "resend",
  "todoist",
  "x_account",
]);

export const IntegrationAccountSchema = z
  .object({
    integrationId: IntegrationAccountIdSchema,
    provider: PersonalIntegrationProviderSchema,
    status: IntegrationAccountStatusSchema,
    connected: z.boolean(),
    accountEmail: z.string().max(320).nullable(),
    accountName: z.string().max(512).nullable(),
    connectionLabel: z.string().max(512).nullable(),
    statusReason: z.string().max(2_000).nullable(),
    scopes: z.array(z.string().max(512)).max(1_000),
    capabilityModes: z.record(z.string(), z.unknown()),
    toolModes: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("IntegrationAccount");

export const IntegrationAccountListEnvelopeSchema = z
  .object({ data: z.array(IntegrationAccountSchema).max(1_000), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("IntegrationAccountListEnvelope");

export const SlackBotChannelRefSchema = z
  .object({ id: z.string().trim().min(1).max(256), name: z.string().trim().min(1).max(512) })
  .strict()
  .openapi("SlackBotChannelRef");

export const SlackBotWorkspaceSettingsSchema = z
  .object({
    isAdmin: z.boolean(),
    configured: z.boolean(),
    installed: z.boolean(),
    status: z.enum(["connected", "needs_reauth", "sync_failed", "not_connected"]),
    needsScopeUpgrade: z.boolean(),
    canCustomizeIdentity: z.boolean(),
    teamName: z.string().max(512).nullable(),
    statusReason: z.string().max(2_000).nullable(),
  })
  .strict()
  .openapi("SlackBotWorkspaceSettings");

export const SlackBotWorkspaceSettingsEnvelopeSchema = z
  .object({ data: SlackBotWorkspaceSettingsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SlackBotWorkspaceSettingsEnvelope");

// Plugins → Company → GitHub. Every member can read which GitHub accounts the workspace linked,
// because company automations bind their event triggers to them; only admins change the links.
export const CompanyGitHubInstallationSchema = z
  .object({
    integrationId: IntegrationAccountIdSchema,
    installationId: z.string().min(1).max(64),
    accountLogin: z.string().min(1).max(256),
    accountType: z.enum(["Organization", "User"]),
    status: z.enum(["connected", "needs_reauth", "sync_failed", "disconnected"]),
    statusReason: z.string().max(2_000).nullable(),
    linkedAt: TimestampSchema,
  })
  .strict()
  .openapi("CompanyGitHubInstallation");

export const CompanyGitHubPluginSchema = z
  .object({
    configured: z.boolean(),
    canManage: z.boolean(),
    installations: z.array(CompanyGitHubInstallationSchema).max(100),
    events: z.array(PluginEventDefinitionSchema).max(64),
  })
  .strict()
  .openapi("CompanyGitHubPlugin");

export const CompanyGitHubPluginEnvelopeSchema = z
  .object({ data: CompanyGitHubPluginSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CompanyGitHubPluginEnvelope");

// The App installations the admin's own GitHub account can reach, offered for linking. `null`
// installations means the admin has not connected GitHub as themselves yet.
export const CompanyGitHubAvailableInstallationsSchema = z
  .object({
    installations: z
      .array(
        z
          .object({
            installationId: z.string().min(1).max(64),
            accountLogin: z.string().min(1).max(256),
            accountType: z.enum(["Organization", "User"]),
            avatarUrl: z.url().nullable(),
            suspended: z.boolean(),
          })
          .strict(),
      )
      .max(500)
      .nullable(),
  })
  .strict()
  .openapi("CompanyGitHubAvailableInstallations");

export const CompanyGitHubAvailableInstallationsEnvelopeSchema = z
  .object({ data: CompanyGitHubAvailableInstallationsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CompanyGitHubAvailableInstallationsEnvelope");

export const LinkCompanyGitHubInstallationBodySchema = z
  .object({
    installationId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/u),
  })
  .strict()
  .openapi("LinkCompanyGitHubInstallationBody");

// Settings → Channels → iMessage. `binding` is null until the member asks for a link code.
export const ImessageSettingsSchema = z
  .object({
    configured: z.boolean(),
    lineHandle: z.string().max(64).nullable(),
    binding: z
      .object({
        status: z.enum(["pending", "linked"]),
        linkCode: z.string().max(12).nullable(),
        linkCodeExpiresAt: TimestampSchema.nullable(),
        handle: z.string().max(64).nullable(),
        conversationId: z.string().max(128).nullable(),
        linkedAt: TimestampSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .openapi("ImessageSettings");
export type ImessageSettingsDto = z.infer<typeof ImessageSettingsSchema>;

export const ImessageSettingsEnvelopeSchema = z
  .object({ data: ImessageSettingsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("ImessageSettingsEnvelope");

export const WhatsappSettingsSchema = z
  .object({
    configured: z.boolean(),
    lineHandle: z.string().max(64).nullable(),
    binding: z
      .object({
        status: z.enum(["pending", "linked"]),
        linkCode: z.string().max(12).nullable(),
        linkCodeExpiresAt: TimestampSchema.nullable(),
        handle: z.string().max(64).nullable(),
        conversationId: z.string().max(128).nullable(),
        linkedAt: TimestampSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .openapi("WhatsappSettings");
export type WhatsappSettingsDto = z.infer<typeof WhatsappSettingsSchema>;

export const WhatsappSettingsEnvelopeSchema = z
  .object({ data: WhatsappSettingsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("WhatsappSettingsEnvelope");
export const SlackBotMutationEnvelopeSchema = z
  .object({ data: z.object({ updated: z.literal(true) }).strict(), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SlackBotMutationEnvelope");

// Workflow event triggers offer real filter options (a Linear team, a Gmail
// label, a Granola folder, a GitHub repository) from the author's connected account.
// Wiki company imports are retired; the routes stay mounted so a stale client
// gets an explicit 410 instead of a 404.
export const RetiredWikiImportBodySchema = z.looseObject({}).openapi("RetiredWikiImportBody");

export const IntegrationResourceOptionsBodySchema = z
  .discriminatedUnion("provider", [
    z
      .object({ provider: z.literal("linear"), includeTriageStateIds: z.boolean().optional() })
      .strict(),
    z.object({ provider: z.literal("granola") }).strict(),
    z.object({ provider: z.literal("gmail") }).strict(),
    z.object({ provider: z.literal("github_app") }).strict(),
  ])
  .openapi("IntegrationResourceOptionsBody");

export const IntegrationResourceOptionsSchema = z
  .discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("linear"),
        teams: z
          .array(
            z
              .object({
                id: z.string().min(1).max(256),
                name: z.string().min(1).max(200),
                key: z.string().max(40).optional(),
                triageStateId: z.string().min(1).max(256).optional(),
              })
              .strict(),
          )
          .max(2_000),
        partial: z.boolean(),
      })
      .strict(),
    z
      .object({
        provider: z.literal("granola"),
        folders: z
          .array(
            z
              .object({
                id: z.string().min(1).max(256),
                name: z.string().min(1).max(200),
                parentFolderId: z.string().min(1).max(256).nullable(),
              })
              .strict(),
          )
          .max(2_000),
        partial: z.boolean(),
      })
      .strict(),
    z
      .object({
        provider: z.literal("gmail"),
        labels: z
          .array(
            z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(200) }).strict(),
          )
          .max(2_000),
      })
      .strict(),
    z
      .object({
        provider: z.literal("github_app"),
        // GitHub's own pagination ceiling for one installation's repositories.
        repositories: z
          .array(
            z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(200) }).strict(),
          )
          .max(10_000),
      })
      .strict(),
  ])
  .openapi("IntegrationResourceOptions");

export const IntegrationResourceOptionsEnvelopeSchema = z
  .object({ data: IntegrationResourceOptionsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("IntegrationResourceOptionsEnvelope");

export const IntegrationAccountDeleteEnvelopeSchema = z
  .object({
    data: z
      .object({ integrationId: IntegrationAccountIdSchema, deleted: z.literal(true) })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("IntegrationAccountDeleteEnvelope");

// The mode and capability vocabularies live in the shared capability registry;
// the API validates them there so unknown values keep their human-readable
// error copy instead of a generic validation failure.
export const SetIntegrationCapabilityModeBodySchema = z
  .object({ mode: z.string().min(1).max(16) })
  .strict()
  .openapi("SetIntegrationCapabilityModeBody");

export const SetIntegrationToolModeBodySchema = z
  .object({ mode: z.string().min(1).max(16) })
  .strict()
  .openapi("SetIntegrationToolModeBody");

export const IntegrationToolModeEnvelopeSchema = z
  .object({
    data: z
      .object({
        integrationId: IntegrationAccountIdSchema,
        toolId: z.string().min(1).max(128),
        mode: z.enum(["on", "ask", "off", "inherit"]),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("IntegrationToolModeEnvelope");

export const IntegrationCapabilityModeEnvelopeSchema = z
  .object({
    data: z
      .object({
        integrationId: IntegrationAccountIdSchema,
        capabilityId: z.string().min(1).max(64),
        mode: z.enum(["on", "ask", "off"]),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("IntegrationCapabilityModeEnvelope");

export const ActionPermissionEnvelopeSchema = z
  .object({
    data: z
      .object({
        actionId: z.string().min(1).max(255),
        state: z.literal("allowed"),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ActionPermissionEnvelope");

// Provider API keys arrive in request bodies over TLS, exactly as the retired
// Server Actions received them. They never appear in any response.
export const IntegrationApiKeyBodySchema = z
  .object({ apiKey: z.string().min(1).max(4_000) })
  .strict()
  .openapi("IntegrationApiKeyBody");

export const PostHogEventsConnectBodySchema = z
  .object({
    apiKey: z.string().min(1).max(4_000),
    projectId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    region: z.enum(["us", "eu"]),
  })
  .strict()
  .openapi("PostHogEventsConnectBody");

export const ConvexAccountStateSchema = z
  .object({
    provider: z.literal("convex"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    accountName: z.string().nullable(),
    statusReason: z.string().nullable(),
    capabilityModes: z.record(z.string(), z.unknown()),
    toolModes: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("ConvexAccountState");

export const ConvexAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: ConvexAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ConvexAccountStateEnvelope");

export const RenderAccountStateSchema = z
  .object({
    provider: z.literal("render"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    accountName: z.string().nullable(),
    statusReason: z.string().nullable(),
    capabilityModes: z.record(z.string(), z.unknown()),
    toolModes: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("RenderAccountState");

export const RenderAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: RenderAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("RenderAccountStateEnvelope");

export const AttioAccountStateSchema = z
  .object({
    provider: z.literal("attio"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    workspaceName: z.string().nullable(),
    statusReason: z.string().nullable(),
  })
  .strict()
  .openapi("AttioAccountState");

export const AttioAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: AttioAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("AttioAccountStateEnvelope");

export const FathomAccountStateSchema = z
  .object({
    provider: z.literal("fathom"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    accountEmail: z.string().nullable(),
    accountName: z.string().nullable(),
    statusReason: z.string().nullable(),
  })
  .strict()
  .openapi("FathomAccountState");

export const FathomAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: FathomAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("FathomAccountStateEnvelope");

export const GranolaAccountStateSchema = z
  .object({
    provider: z.literal("granola"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    accountEmail: z.string().nullable(),
    accountName: z.string().nullable(),
    statusReason: z.string().nullable(),
  })
  .strict()
  .openapi("GranolaAccountState");

export const GranolaAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: GranolaAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("GranolaAccountStateEnvelope");

export const PostHogEventsAccountStateSchema = z
  .object({
    provider: z.literal("posthog"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    projectId: z.string().nullable(),
    region: z.enum(["us", "eu"]).nullable(),
    connectionLabel: z.string().nullable(),
    statusReason: z.string().nullable(),
  })
  .strict()
  .openapi("PostHogEventsAccountState");

export const PostHogEventsAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: PostHogEventsAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("PostHogEventsAccountStateEnvelope");

export const PostHogEventDefinitionListEnvelopeSchema = z
  .object({
    data: z
      .object({
        events: z
          .array(z.object({ id: z.string().max(512), name: z.string().max(512) }).strict())
          .max(500),
        partial: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("PostHogEventDefinitionListEnvelope");

// Jamie's event connection is a webhook the user creates in Jamie against opencompany's fixed
// endpoint; only the digest of the key Jamie mints is stored. The URL is what the setup UI asks the
// user to copy, and the last verified delivery is the only confirmation Jamie's key ever works,
// because Jamie offers nothing to validate it against on save.
export const JamieEventsAccountStateSchema = z
  .object({
    provider: z.literal("jamie"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    statusReason: z.string().nullable(),
    webhookUrl: z.string().url().nullable(),
    lastDeliveryAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi("JamieEventsAccountState");

export const JamieEventsAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: JamieEventsAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("JamieEventsAccountStateEnvelope");

// Convex's event connection is a webhook log stream opencompany provisions in Convex with the
// deploy key the plugin already holds, so nothing is pasted in either direction. The state names
// the deployment the stream belongs to and the last signature-verified delivery, which is the only
// confirmation that the stream reaches opencompany rather than only that Convex accepted it.
export const ConvexEventsAccountStateSchema = z
  .object({
    provider: z.literal("convex"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    statusReason: z.string().nullable(),
    deployment: z.string().nullable(),
    webhookUrl: z.string().url().nullable(),
    lastDeliveryAt: z.string().datetime().nullable(),
  })
  .strict()
  .openapi("ConvexEventsAccountState");

export const ConvexEventsAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: ConvexEventsAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ConvexEventsAccountStateEnvelope");

export const StripeAccountStateSchema = z
  .object({
    provider: z.literal("stripe"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    accountName: z.string().nullable(),
    livemode: z.boolean().nullable(),
    statusReason: z.string().nullable(),
  })
  .strict()
  .openapi("StripeAccountState");

export const StripeAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: StripeAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("StripeAccountStateEnvelope");

export const StripeAccountDeleteEnvelopeSchema = z
  .object({
    data: z.object({ deleted: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("StripeAccountDeleteEnvelope");

// Engine + secrets-manager auth commands (#1203 5a3). Credential material
// (the Claude Code setup token, the Infisical browser token) arrives in
// request bodies over TLS exactly as the retired Server Actions received it;
// no status DTO or response envelope ever carries it back out.

export const EngineAuthConnectionStatusSchema = z.enum(["connected", "needs_reauth"]);

export const ClaudeCodeAuthStatusSchema = z
  .object({
    status: EngineAuthConnectionStatusSchema.nullable(),
    statusReason: z.string().nullable(),
    lastValidatedAt: TimestampSchema.nullable(),
    lastRotatedAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("ClaudeCodeAuthStatus");

export const ClaudeCodeAuthStatusEnvelopeSchema = z
  .object({ data: ClaudeCodeAuthStatusSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("ClaudeCodeAuthStatusEnvelope");

// No .min(1): empty submissions must reach the service so its validator keeps
// the retired "Paste the token printed by `claude setup-token`." copy.
export const SaveClaudeCodeTokenBodySchema = z
  .object({ token: z.string().max(4_000) })
  .strict()
  .openapi("SaveClaudeCodeTokenBody");

export const EngineAuthDisconnectEnvelopeSchema = z
  .object({
    data: z.object({ deleted: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("EngineAuthDisconnectEnvelope");

export const CodexAuthStatusSchema = z
  .object({
    status: EngineAuthConnectionStatusSchema.nullable(),
    statusReason: z.string().nullable(),
    lastValidatedAt: TimestampSchema.nullable(),
    lastRotatedAt: TimestampSchema.nullable(),
    workspaceEngine: z
      .object({
        enabled: z.boolean(),
        providerDisplayName: z.string().min(1),
        providerEmail: z.string().email(),
        credentialStatus: EngineAuthConnectionStatusSchema,
        credentialStatusReason: z.string().nullable(),
        lastValidatedAt: TimestampSchema.nullable(),
        isCurrentUser: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .openapi("CodexAuthStatus");

export const CodexAuthStatusEnvelopeSchema = z
  .object({ data: CodexAuthStatusSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CodexAuthStatusEnvelope");

export const UpdateCodexWorkspaceEngineBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi("UpdateCodexWorkspaceEngineBody");

// Shared by the Codex and Claude Code subscription cards: a provider-agnostic
// snapshot of the connected account's remaining allowance per limit window.
export type SubscriptionUsage = {
  windows: {
    id: string;
    label: string;
    usedPercent: number;
    resetsAt: string;
  }[];
  updatedAt: string;
};

export const SubscriptionUsageSchema: z.ZodType<SubscriptionUsage> = z
  .object({
    windows: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          usedPercent: z.number().min(0).max(100),
          resetsAt: z.string().datetime(),
        })
        .strict(),
    ),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .openapi("SubscriptionUsage");

export const SubscriptionUsageEnvelopeSchema = z
  .object({ data: SubscriptionUsageSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SubscriptionUsageEnvelope");

export const EngineAuthFlowIdSchema = z
  .string()
  .min(1)
  .max(128)
  .openapi({ example: "gcodf_0f8e7d6c5b4a", description: "Engine auth flow id." });

export const CodexDeviceAuthFlowSchema = z
  .object({
    id: EngineAuthFlowIdSchema,
    status: z.enum(["pending", "code_ready", "completed", "failed", "expired"]),
    userCode: z.string().nullable(),
    verificationUri: z.string().nullable(),
    statusReason: z.string().nullable(),
    expiresAt: TimestampSchema,
  })
  .strict()
  .openapi("CodexDeviceAuthFlow");

export const CodexDeviceAuthFlowEnvelopeSchema = z
  .object({
    data: z.object({ flow: CodexDeviceAuthFlowSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("CodexDeviceAuthFlowEnvelope");

export const InfisicalAuthStatusSchema = z
  .object({
    status: z.enum(["connected", "needs_reauth", "disconnected"]).nullable(),
    statusReason: z.string().nullable(),
    accountEmail: z.string().nullable(),
    // The supported host vocabulary lives beside the credential table in
    // @opencompany/db; the service validates membership so unsupported regions
    // keep the retired human-readable copy.
    host: z.string().nullable(),
    lastValidatedAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("InfisicalAuthStatus");

export const InfisicalAuthStatusEnvelopeSchema = z
  .object({ data: InfisicalAuthStatusSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("InfisicalAuthStatusEnvelope");

export const StartInfisicalAuthBodySchema = z
  .object({ host: z.string().min(1).max(256) })
  .strict()
  .openapi("StartInfisicalAuthBody");

// The retired action rejected browser tokens above 64 KiB; the protocol pins
// the same ceiling so oversized payloads never reach the runner.
export const CompleteInfisicalAuthBodySchema = z
  .object({ browserToken: z.string().max(64 * 1024) })
  .strict()
  .openapi("CompleteInfisicalAuthBody");

export const InfisicalAuthFlowSchema = z
  .object({
    id: EngineAuthFlowIdSchema,
    status: z.enum(["pending", "link_ready", "completed", "failed", "expired"]),
    loginUrl: z.string().nullable(),
    statusReason: z.string().nullable(),
    expiresAt: TimestampSchema,
  })
  .strict()
  .openapi("InfisicalAuthFlow");

export const InfisicalAuthFlowEnvelopeSchema = z
  .object({
    data: z.object({ flow: InfisicalAuthFlowSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("InfisicalAuthFlowEnvelope");

export const DopplerAuthStatusSchema = z
  .object({
    status: z.enum(["connected", "needs_reauth", "disconnected"]).nullable(),
    statusReason: z.string().nullable(),
    accountName: z.string().nullable(),
    lastValidatedAt: TimestampSchema.nullable(),
  })
  .strict()
  .openapi("DopplerAuthStatus");

export const DopplerAuthStatusEnvelopeSchema = z
  .object({ data: DopplerAuthStatusSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("DopplerAuthStatusEnvelope");

export const DopplerAuthFlowSchema = z
  .object({
    id: EngineAuthFlowIdSchema,
    status: z.enum(["pending", "link_ready", "completed", "failed", "expired"]),
    loginUrl: z.string().nullable(),
    userCode: z.string().nullable(),
    statusReason: z.string().nullable(),
    expiresAt: TimestampSchema,
  })
  .strict()
  .openapi("DopplerAuthFlow");

export const DopplerAuthFlowEnvelopeSchema = z
  .object({
    data: z.object({ flow: DopplerAuthFlowSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("DopplerAuthFlowEnvelope");

export type ConversationDto = z.infer<typeof ConversationSchema>;
export type SessionPullRequestDto = z.infer<typeof SessionPullRequestSchema>;
export type ConversationRuntimeDto = z.infer<typeof ConversationRuntimeSchema>;
export type AttachmentDto = z.infer<typeof AttachmentSchema>;
export type ConversationShareDto = z.infer<typeof ConversationShareSchema>;
export type PublicChatMessageDto = z.infer<typeof PublicChatMessageSchema>;
export type PublicChatShareDto = z.infer<typeof PublicChatShareSchema>;
export type PublicChatShareMetadataDto = z.infer<typeof PublicChatShareMetadataSchema>;
export type UpdateConversationBody = z.infer<typeof UpdateConversationBodySchema>;
export type MessageDto = z.infer<typeof MessageSchema>;
export type RunDto = z.infer<typeof RunSchema>;
export type MessageEngine = z.infer<typeof MessageEngineSchema>;
export type ChatReadModel = z.infer<typeof ChatReadModelSchema>;
export type ReadModel = z.infer<typeof ReadModelSchema>;
export type TaskDto = z.infer<typeof TaskSchema>;
export type TaskSummaryDto = z.infer<typeof TaskSummarySchema>;
export type LegacyTaskDto = z.infer<typeof LegacyTaskSchema>;
export type LegacyTaskHistoryMessageDto = z.infer<typeof LegacyTaskHistoryMessageSchema>;
export type LegacyTaskHistoryEventDto = z.infer<typeof LegacyTaskHistoryEventSchema>;
export type LegacyTaskHistoryDto = z.infer<typeof LegacyTaskHistoryEnvelopeSchema>["data"];
export type TaskReadModel = z.infer<typeof TaskReadModelSchema>;
export type TaskActivityReadModel = z.infer<typeof TaskActivityReadModelSchema>;
export type WorkflowDto = z.infer<typeof WorkflowSchema>;
export type WorkflowScope = z.infer<typeof WorkflowScopeSchema>;
export type WorkflowSlackChannel = z.infer<typeof WorkflowSlackChannelSchema>;
export type WorkflowMemoryDto = z.infer<typeof WorkflowMemorySchema>;
export type WorkflowReadModel = z.infer<typeof WorkflowReadModelSchema>;
export type WorkflowScheduleReadModel = z.infer<typeof WorkflowScheduleReadModelSchema>;
export type IntegrationAccountReadModel = z.infer<typeof IntegrationAccountReadModelSchema>;
export type WikiPageDto = z.infer<typeof WikiPageSchema>;
export type WikiPageReadModel = z.infer<typeof WikiPageReadModelSchema>;
export type WikiTimelineReadModel = z.infer<typeof WikiTimelineReadModelSchema>;
export type WikiSourceProvider = "gmail" | "granola" | "linear";
export type WikiSourceDto = z.infer<typeof WikiSourceSchema>;
export type WikiIngestActivityItemDto = {
  id: string;
  provider: WikiSourceProvider;
  sourceType: "meeting" | "conversation" | "issue" | "activity" | "thread";
  title: string | null;
  outcome: "queued" | "running" | "succeeded" | "failed" | "skipped";
  reason: string | null;
  pages: Array<{
    path: string;
    title: string;
    action: "created" | "updated" | "moved" | "deleted";
  }>;
  attempts: number;
  occurredAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type WikiIngestActivityPageDto = {
  items: WikiIngestActivityItemDto[];
  nextCursor: string | null;
};
export type UpsertWikiSourceBody = z.infer<typeof UpsertWikiSourceBodySchema>;
export type SetWikiSourceEnabledBody = z.infer<typeof SetWikiSourceEnabledBodySchema>;
export type WikiDto = z.infer<typeof WikiSchema>;
export type WikiAccessDto = z.infer<typeof WikiAccessSchema>;
export type CreateWikiBody = z.infer<typeof CreateWikiBodySchema>;
export type UpdateWikiBody = z.infer<typeof UpdateWikiBodySchema>;
export type SetWikiAccessBody = z.infer<typeof SetWikiAccessBodySchema>;
// Written out rather than inferred, like `WikiIngestActivityItemDto` above: `z.infer` does not
// resolve this schema's nested array of objects, so it widens to `any` and every consumer loses
// its types. Keep it in step with `WikiAccessEnvelopeSchema` by hand -- a type-level guard here
// would have to compare against that same widened `any` and so could never fail.
export type WikiAccessDetailsDto = {
  access: WikiAccessDto;
  memberIds: string[];
  workspaceMembers: Array<{
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    role: "admin" | "member";
  }>;
};
export type CreateWikiPageBody = z.infer<typeof CreateWikiPageBodySchema>;
export type UpdateWikiPageBody = z.infer<typeof UpdateWikiPageBodySchema>;
export type DeleteWikiPageBody = z.infer<typeof DeleteWikiPageBodySchema>;
export type AddWikiTimelineEntryBody = z.infer<typeof AddWikiTimelineEntryBodySchema>;
export type SkillSourceDto = z.infer<typeof SkillSourceSchema>;
export type SkillListItemDto = z.infer<typeof SkillListItemSchema>;
export type SkillInstallationDto = z.infer<typeof SkillInstallationSchema>;
export type SkillBundleDto = z.infer<typeof SkillBundleSchema>;
export type SkillBundleFileMetadataDto = z.infer<typeof SkillBundleFileMetadataSchema>;
export type SkillImportFileMetadataDto = z.infer<typeof SkillImportFileMetadataSchema>;
export type SkillFileChunkDto = z.infer<typeof SkillFileChunkSchema>;
export type SkillCatalogItemDto = z.infer<typeof SkillCatalogItemSchema>;
export type SkillImportCandidateDto = z.infer<typeof SkillImportCandidateSchema>;
export type SkillImportWarningDto = z.infer<typeof SkillImportWarningSchema>;
export type SkillImportPreviewDto = z.infer<typeof SkillImportPreviewSchema>;
export type SkillImportPreviewBody = z.infer<typeof SkillImportPreviewBodySchema>;
export type ImportSkillBody = z.infer<typeof ImportSkillBodySchema>;
export type CreateWorkspaceSkillBody = z.infer<typeof CreateWorkspaceSkillBodySchema>;
export type UpdateWorkspaceSkillBody = z.infer<typeof UpdateWorkspaceSkillBodySchema>;
export type PluginManifestDto = z.infer<typeof PluginManifestSchema>;
export type PluginSourceDto = z.infer<typeof PluginSourceSchema>;
export type PluginRemoteMcpServerDto = z.infer<typeof PluginRemoteMcpServerSchema>;
export type PluginListItemDto = z.infer<typeof PluginListItemSchema>;
export type PluginInstallationDto = z.infer<typeof PluginInstallationSchema>;
export type PluginPricingDto = z.infer<typeof PluginPricingSchema>;
export type PluginActionPriceDto = z.infer<typeof PluginActionPriceSchema>;
export type PluginBillingDto = z.infer<typeof PluginBillingSchema>;
export type PluginEventDefinitionDto = z.infer<typeof PluginEventDefinitionSchema>;
export type PluginEventFilterDefinitionDto = z.infer<typeof PluginEventFilterDefinitionSchema>;
export type PluginImportPreviewDto = z.infer<typeof PluginImportPreviewSchema>;
export type PluginImportPreviewBody = z.infer<typeof PluginImportPreviewBodySchema>;
export type InstallPluginBody = z.infer<typeof InstallPluginBodySchema>;
export type ApprovePluginMcpBody = z.infer<typeof ApprovePluginMcpBodySchema>;
export type SetPluginEventEnabledBody = z.infer<typeof SetPluginEventEnabledBodySchema>;
export type CompanyAgentDto = z.infer<typeof CompanyAgentSchema>;
export type CompanyAgentRunDto = z.infer<typeof CompanyAgentRunSchema>;
export type CompanyAgentStatus = z.infer<typeof CompanyAgentStatusSchema>;
export type CreateCompanyAgentBody = z.infer<typeof CreateCompanyAgentBodySchema>;
export type UpdateCompanyAgentBody = z.infer<typeof UpdateCompanyAgentBodySchema>;
export type CreateWorkflowBody = z.infer<typeof CreateWorkflowBodySchema>;
export type UpdateWorkflowBody = z.infer<typeof UpdateWorkflowBodySchema>;
export type ArchiveVersionBody = z.infer<typeof ArchiveVersionBodySchema>;
export type InvokeWorkflowBody = z.infer<typeof InvokeWorkflowBodySchema>;
export type ConversationReadModel = z.infer<typeof ConversationReadModelSchema>;
export type ConversationReadModelV1 = z.infer<typeof ConversationReadModelV1Schema>;
export type MessageReadModel = z.infer<typeof MessageReadModelSchema>;
export type MessageSummaryReadModel = z.infer<typeof MessageSummaryReadModelSchema>;
export type MessagePresentation = z.infer<typeof MessagePresentationSchema>;
export type SteerRunResult = z.infer<typeof SteerRunEnvelopeSchema>["data"];
export type RunReadModel = z.infer<typeof RunReadModelSchema>;
export type EngineSessionReadModel = z.infer<typeof EngineSessionReadModelSchema>;
export type EngineRuntimeStatus = z.infer<typeof EngineRuntimeStatusSchema>;
export type EngineRuntimeAccess = z.infer<typeof EngineRuntimeAccessEnvelopeSchema>["data"];
export type AttachmentUploadEnvelope = z.infer<typeof AttachmentUploadEnvelopeSchema>;
export type WorkflowSlackAvatarUploadEnvelope = z.infer<
  typeof WorkflowSlackAvatarUploadEnvelopeSchema
>;
export type CreateMessageBody = z.infer<typeof CreateMessageBodySchema>;
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;
export type CreateTaskCommentBody = z.infer<typeof CreateTaskCommentBodySchema>;
export type CreateTaskCommentResult = z.infer<typeof CreateTaskCommentEnvelopeSchema>["data"];
export type UpdateTaskBody = z.infer<typeof UpdateTaskBodySchema>;
export type BrowserProfileDto = z.infer<typeof BrowserProfileSchema>;
export type CreateBrowserProfileBody = z.infer<typeof CreateBrowserProfileBodySchema>;
export type BrowserProfileLoginSessionDto = z.infer<typeof BrowserProfileLoginSessionSchema>;
export type ManagedCapabilitySource = z.infer<typeof ManagedCapabilitySourceSchema>;
export type WorkspaceCapabilityDto = z.infer<typeof WorkspaceCapabilitySchema>;
export type WorkspaceCapabilitySettingsDto = z.infer<
  typeof WorkspaceCapabilitySettingsEnvelopeSchema
>["data"];
export type CapabilityApprovalDto = z.infer<typeof CapabilityApprovalSchema>;
export type WorkspaceMemberDto = z.infer<typeof WorkspaceMemberSchema>;
export type WorkspaceInvitationDto = z.infer<typeof WorkspaceInvitationSchema>;
export type WorkspaceSettingsDto = z.infer<typeof WorkspaceSettingsSchema>;
export type WorkspaceActivationDto = z.infer<typeof WorkspaceActivationSchema>;
export type OnboardingRole = z.infer<typeof OnboardingRoleSchema>;
export type OnboardingStateDto = z.infer<typeof OnboardingStateSchema>;
export type OnboardingEmailStep = "welcome" | "checkin" | "feedback_call";
export type OnboardingEmailClaimDto = {
  id: string;
  workosUserId: string;
  step: OnboardingEmailStep;
  attempts: number;
  email: string;
  firstName: string | null;
  terminalOnFailure: boolean;
};
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type TaskViewMode = z.infer<typeof TaskViewModeSchema>;
export type McpClient = z.infer<typeof McpClientSchema>;
export type IdentityUserDto = z.infer<typeof IdentityUserSchema>;
export type IdentityWorkspaceDto = z.infer<typeof IdentityWorkspaceSchema>;
export type IdentityDto = z.infer<typeof IdentitySchema>;
export type UserPreferencesDto = z.infer<typeof UserPreferencesSchema>;
export type UpdateUserPreferencesBody = z.infer<typeof UpdateUserPreferencesBodySchema>;
export type McpSetupDto = z.infer<typeof McpSetupSchema>;
export type UpdateMcpSetupBody = z.infer<typeof UpdateMcpSetupBodySchema>;
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;
export type SubmitFeedbackBody = z.infer<typeof SubmitFeedbackBodySchema>;
export type BillingOverviewDto = {
  creditBalanceUsdMicros: number;
  includedBalanceUsdMicros: number;
  topUpBalanceUsdMicros: number;
  plan: "hobby" | "pro";
  subscriptionStatus: string | null;
  seatQuantity: number;
  includedUsagePeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  paymentNeedsAttention: boolean;
  proMonthlyPriceCents: number;
  hobbyIncludedUsageCents: number;
  memberCount: number;
  memberCap: number;
  spendThisMonthUsdMicros: number;
  spendThisMonthByCategory: {
    chat: number;
    ingestion: number;
    capabilities: number;
    sandbox: number;
  };
  recentActivity: Array<{
    activityId: string;
    source: string;
    amountUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    capabilityAction: string | null;
    isAutoRefill: boolean;
    createdAt: string;
  }>;
  lowBalanceWarnUsdMicros: number;
  includedUsagePerSeatCents: number;
  topUpAmountsCents: number[];
  defaultTopUpCents: number;
  minTopUpCents: number;
  maxTopUpCents: number;
  autoRefillMonthlyMaxCents: number;
  autoRefill: {
    enabled: boolean;
    amountCents: number;
    hasPaymentMethod: boolean;
    lastError: string | null;
  };
  isAdmin: boolean;
};
export type BillingUsageDto = {
  breakdown: Array<{
    day: string;
    category: "chat" | "ingestion" | "capabilities" | "sandbox" | "other";
    spendUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
  }>;
  ingestedThisMonth: number;
  pending: number;
  creditBalanceUsdMicros: number;
  providers: Array<{ provider: string; count: number }>;
  recent: Array<{
    activityId: string;
    provider: string;
    rawEventCount: number;
    status: "pending" | "consumed";
    createdAt: string;
  }>;
};
export type BillingBalanceDto = {
  balanceUsdMicros: number;
  lowBalanceWarnUsdMicros: number;
  enforcementEnabled: boolean;
};
export type CreateBillingTopUpBody = z.infer<typeof CreateBillingTopUpBodySchema>;
export type UpdateBillingAutoRefillBody = z.infer<typeof UpdateBillingAutoRefillBodySchema>;
export type WorkspaceRepositoryDto = z.infer<typeof WorkspaceRepositorySchema>;
export type RepoConfigDto = z.infer<typeof RepoConfigSchema>;
export type SetRepoConfigEnvBody = z.infer<typeof SetRepoConfigEnvBodySchema>;
export type SetRepoConfigSetupBody = z.infer<typeof SetRepoConfigSetupBodySchema>;
export type IntegrationAccountStatus = z.infer<typeof IntegrationAccountStatusSchema>;
export type PersonalIntegrationProvider = z.infer<typeof PersonalIntegrationProviderSchema>;
export type IntegrationAccountDto = z.infer<typeof IntegrationAccountSchema>;
export type SlackBotWorkspaceSettingsDto = z.infer<typeof SlackBotWorkspaceSettingsSchema>;
export type CompanyGitHubInstallationDto = z.infer<typeof CompanyGitHubInstallationSchema>;
export type CompanyGitHubPluginDto = z.infer<typeof CompanyGitHubPluginSchema>;
export type CompanyGitHubAvailableInstallationsDto = z.infer<
  typeof CompanyGitHubAvailableInstallationsSchema
>;
export type AttioAccountStateDto = z.infer<typeof AttioAccountStateSchema>;
export type FathomAccountStateDto = z.infer<typeof FathomAccountStateSchema>;
export type GranolaAccountStateDto = z.infer<typeof GranolaAccountStateSchema>;
export type StripeAccountStateDto = z.infer<typeof StripeAccountStateSchema>;

export const BotBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(4000),
  })
  .strict();
export const BotSchema = BotBodySchema.extend({ id: ResourceIdSchema.regex(/^[a-zA-Z0-9_-]+$/) });
export type BotDto = z.infer<typeof BotSchema>;
export const BotEnvelopeSchema = z
  .object({ data: BotSchema, meta: ProtocolMetadataSchema })
  .strict();
export const BotListEnvelopeSchema = z
  .object({ data: z.array(BotSchema), meta: ProtocolMetadataSchema })
  .strict();

export type SetSkillScopeBody = z.infer<typeof SetSkillScopeBodySchema>;

export const ProjectBodySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const CreateProjectBodySchema = ProjectBodySchema.extend({ id: ResourceIdSchema }).strict();
export const ProjectSchema = z
  .object({
    id: ResourceIdSchema,
    name: z.string(),
    // The chats and Tasks filed under this project, newest first. Both kinds are Conversations,
    // so one list covers the sidebar rows for either.
    conversationIds: z.array(ResourceIdSchema),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("Project");
export const ProjectListEnvelopeSchema = z
  .object({ data: z.array(ProjectSchema), meta: ProtocolMetadataSchema })
  .strict();
export const ProjectConversationBodySchema = z
  .object({ conversationId: ResourceIdSchema })
  .strict();
export type ProjectDto = z.infer<typeof ProjectSchema>;
export type IntegrationResourceOptionsBody = z.infer<typeof IntegrationResourceOptionsBodySchema>;
export type IntegrationResourceOptionsDto = z.infer<typeof IntegrationResourceOptionsSchema>;

export const SlackProvisioningSchema = z
  .object({ configured: z.boolean(), status: z.string(), teamName: z.string().nullable() })
  .strict();
export const SlackProvisioningEnvelopeSchema = z
  .object({ data: SlackProvisioningSchema, meta: ProtocolMetadataSchema })
  .strict();
export const SlackProvisioningStartEnvelopeSchema = z
  .object({
    data: z.object({ attemptId: z.string(), command: z.string(), expiresAt: z.string() }),
    meta: ProtocolMetadataSchema,
  })
  .strict();
export const SlackProvisioningCompleteBodySchema = z
  .object({
    attemptId: z.string().uuid(),
    challenge: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();

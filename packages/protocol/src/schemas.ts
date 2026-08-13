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
export const BrainFolderReadModelNameSchema = z.literal("brain-folders-v1");
export const BrainDocumentReadModelNameSchema = z.literal("brain-documents-v1");
export const BrainTimelineReadModelNameSchema = z.literal("brain-timeline-v1");
export const BrainEdgeReadModelNameSchema = z.literal("brain-edges-v1");
export const BrainIngestJobReadModelNameSchema = z.literal("brain-ingest-jobs-v1");
export const BrainImportRunReadModelNameSchema = z.literal("brain-import-runs-v1");
export const WikiPageReadModelNameSchema = z.literal("wiki-pages-v1");
export const WikiTimelineReadModelNameSchema = z.literal("wiki-timeline-v1");
export const ReadModelSchema = z.enum([
  ...ChatReadModelSchema.options,
  TaskReadModelNameSchema.value,
  WorkflowReadModelNameSchema.value,
  WorkflowScheduleReadModelNameSchema.value,
  TaskScheduleReadModelNameSchema.value,
  BrainFolderReadModelNameSchema.value,
  BrainDocumentReadModelNameSchema.value,
  BrainTimelineReadModelNameSchema.value,
  BrainEdgeReadModelNameSchema.value,
  BrainIngestJobReadModelNameSchema.value,
  BrainImportRunReadModelNameSchema.value,
  WikiPageReadModelNameSchema.value,
  WikiTimelineReadModelNameSchema.value,
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

export const BrainTimelineEntrySchema = z
  .object({
    evidenceId: z.string().max(80),
    at: TimestampSchema,
    body: z.string(),
  })
  .strict()
  .openapi("BrainTimelineEntry");

export const BrainRelationSchema = z
  .object({ type: z.string().min(1).max(64), to: z.string().min(1).max(80) })
  .strict()
  .openapi("BrainRelation");

export const BrainSourceSchema = z
  .object({
    ref: z.string().min(1).max(256),
    capturedAt: TimestampSchema.optional(),
    title: z.string().max(512).optional(),
  })
  .strict()
  .openapi("BrainSource");

export const BrainFolderSchema = z
  .object({
    id: ResourceIdSchema,
    path: z.string().min(1).max(512),
    source: z.enum(["system", "custom"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainFolder");

export const BrainDocumentSchema = z
  .object({
    id: ResourceIdSchema,
    brainId: z.string().min(1).max(80),
    folderPath: z.string().min(1).max(512),
    path: z.string().min(1).max(640),
    title: z.string().max(160),
    description: z.string().max(1_024).optional(),
    content: z.string(),
    body: z.string(),
    timeline: z.array(BrainTimelineEntrySchema),
    format: z.enum([
      "markdown",
      "pdf",
      "docx",
      "xlsx",
      "srt",
      "csv",
      "tsv",
      "json",
      "text",
      "image",
    ]),
    mimeType: z.string().min(1).max(255),
    originalFileName: z.string().max(512).nullable(),
    assetSizeBytes: z.number().int().min(0).nullable(),
    relations: z.array(BrainRelationSchema),
    sources: z.array(BrainSourceSchema),
    kind: z.enum(["page", "evidence"]),
    type: z.enum([
      "person",
      "company",
      "project",
      "meeting",
      "concept",
      "source",
      "analysis",
      "note",
    ]),
    status: z.enum(["draft", "active", "archived", "merged"]),
    aliases: z.array(z.string().max(512)),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z.number().int().min(0),
    createdByActorId: ResourceIdSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainDocument");

export const BrainSnapshotSchema = z
  .object({ folders: z.array(BrainFolderSchema), documents: z.array(BrainDocumentSchema) })
  .strict()
  .openapi("BrainSnapshot");

export const BrainOverviewSchema = z
  .object({
    windowStartedAt: TimestampSchema,
    itemsAddedLast7Days: z.number().int().min(0),
    retrievalsLast7Days: z.number().int().min(0),
    activeSources: z.number().int().min(0),
  })
  .strict()
  .openapi("BrainOverview");

export const BrainFolderReadModelSchema = BrainFolderSchema.openapi("BrainFolderReadModelV1");
export const BrainDocumentReadModelSchema = BrainDocumentSchema.openapi("BrainDocumentReadModelV1");

export const BrainTimelineReadModelSchema = z
  .object({
    id: z.number().int().min(1),
    documentId: ResourceIdSchema,
    brainId: z.string().min(1).max(80),
    evidenceId: z.string().max(80),
    at: TimestampSchema,
    sourceRef: z.string().max(256),
    sourceTitle: z.string().max(512).nullable(),
    summary: z.string(),
    detail: z.string(),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainTimelineReadModelV1");

export const BrainEdgeReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    documentId: ResourceIdSchema,
    fromBrainId: z.string().min(1).max(80),
    toBrainId: z.string().min(1).max(80),
    relationType: z.string().min(1).max(64),
    sourceKind: z.enum(["relation", "wiki_link"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainEdgeReadModelV1");

export const BrainIngestJobResultPageSchema = z
  .object({
    brainId: z.string().min(1).max(80),
    folderPath: z.string().min(1).max(512),
    title: z.string().max(160),
    action: z.enum(["created", "updated", "conflict_created"]),
  })
  .strict()
  .openapi("BrainIngestJobResultPage");

export const BrainIngestJobResultSchema = z
  .object({
    summary: z.string().max(2_000).optional(),
    draftBrainId: z.string().min(1).max(80).optional(),
    meetingBrainId: z.string().min(1).max(80).optional(),
    pages: z.array(BrainIngestJobResultPageSchema).max(20).optional(),
    skipped: z.boolean().optional(),
    durationMs: z.number().finite().min(0).optional(),
    // The API normalizes this bounded diagnostic trace before it crosses the read-model boundary.
    trace: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi("BrainIngestJobResult");

export const BrainIngestJobReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    sourceItemId: ResourceIdSchema,
    sourceProvider: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
    planPaused: z.boolean(),
    attempts: z.number().int().min(0),
    lastError: z.string().max(2_000).nullable(),
    result: BrainIngestJobResultSchema,
    completedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainIngestJobReadModelV1");

export const BrainSourceItemSchema = z
  .object({
    id: ResourceIdSchema,
    sourceProvider: z.string().min(1).max(64),
    sourceType: z.string().min(1).max(64),
    externalId: z.string().max(4_096),
    title: z.string().max(512).nullable(),
    lastIngestError: z.string().max(2_000).nullable(),
    createdAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainSourceItem");

export const BrainSourceItemListEnvelopeSchema = z
  .object({ data: z.array(BrainSourceItemSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainSourceItemListEnvelope");

export const BrainSourceConfigProviderSchema = z.enum([
  "jamie",
  "gmail",
  "google_drive",
  "github",
  "slack",
  "linear",
  "slack_bot",
  "hubspot",
  "granola",
  "fathom",
  "attio",
]);
export const BrainSourceIntegrationStatusSchema = z.enum([
  "connected",
  "needs_reauth",
  "sync_failed",
  "disconnected",
]);
const BrainSourceProviderStatusSchema = z.enum([
  "connected",
  "needs_reauth",
  "sync_failed",
  "disconnected",
  "not_connected",
]);
const NullableLabelSchema = z.string().max(512).nullable();
const BrainSourceProviderBaseShape = {
  connected: z.boolean(),
  status: BrainSourceProviderStatusSchema,
  integrationId: ResourceIdSchema.nullable(),
  statusReason: z.string().max(2_000).nullable(),
};

export const BrainSourceViewSchema = z
  .object({
    sourceId: ResourceIdSchema,
    provider: BrainSourceConfigProviderSchema,
    integrationId: ResourceIdSchema,
    enabled: z.boolean(),
    connectedByName: z.string().max(512),
    ownerEmail: z.string().max(512).nullable(),
    ownerAvatarUrl: z.string().max(4_096).nullable(),
    accountEmail: z.string().max(512).nullable(),
    accountName: NullableLabelSchema,
    connectionLabel: NullableLabelSchema,
    ownerKind: z.enum(["workspace", "user"]),
    isOwn: z.boolean(),
    canConfigure: z.boolean(),
    canToggle: z.boolean(),
    canRemove: z.boolean(),
    integrationStatus: BrainSourceIntegrationStatusSchema,
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("BrainSourceView");

export const BrainSourceAccountSchema = z
  .object({
    integrationId: ResourceIdSchema,
    status: BrainSourceIntegrationStatusSchema,
    accountEmail: z.string().max(512).nullable(),
    accountName: NullableLabelSchema,
    connectionLabel: NullableLabelSchema,
  })
  .strict()
  .openapi("BrainSourceAccount");

const JamieSourceProviderStateSchema = z
  .object({
    provider: z.literal("jamie"),
    ...BrainSourceProviderBaseShape,
    accountName: NullableLabelSchema,
    webhookUrl: z.url().max(4_096).nullable(),
    apiKeyConfigured: z.boolean(),
  })
  .strict();
const SlackSourceProviderStateSchema = z
  .object({
    provider: z.literal("slack"),
    ...BrainSourceProviderBaseShape,
    accountName: NullableLabelSchema,
    teamName: NullableLabelSchema,
  })
  .strict();
const LinearSourceProviderStateSchema = z
  .object({
    provider: z.literal("linear"),
    ...BrainSourceProviderBaseShape,
    accountName: NullableLabelSchema,
    organizationName: NullableLabelSchema,
  })
  .strict();
const GitHubSourceProviderStateSchema = z
  .object({
    provider: z.literal("github"),
    ...BrainSourceProviderBaseShape,
    accountName: NullableLabelSchema,
  })
  .strict();
const GmailSourceProviderStateSchema = z
  .object({
    provider: z.literal("gmail"),
    ...BrainSourceProviderBaseShape,
    accountEmail: z.string().max(512).nullable(),
  })
  .strict();
const GoogleDriveSourceProviderStateSchema = z
  .object({
    provider: z.literal("google_drive"),
    ...BrainSourceProviderBaseShape,
    accountEmail: z.string().max(512).nullable(),
  })
  .strict();
const HubspotSourceProviderStateSchema = z
  .object({
    provider: z.literal("hubspot"),
    ...BrainSourceProviderBaseShape,
    accountEmail: z.string().max(512).nullable(),
    hubDomain: NullableLabelSchema,
  })
  .strict();
const GranolaSourceProviderStateSchema = z
  .object({
    provider: z.literal("granola"),
    ...BrainSourceProviderBaseShape,
    accountEmail: z.string().max(512).nullable(),
    accountName: NullableLabelSchema,
  })
  .strict();
const FathomSourceProviderStateSchema = z
  .object({
    provider: z.literal("fathom"),
    ...BrainSourceProviderBaseShape,
    accountEmail: z.string().max(512).nullable(),
    accountName: NullableLabelSchema,
  })
  .strict();
const AttioSourceProviderStateSchema = z
  .object({
    provider: z.literal("attio"),
    ...BrainSourceProviderBaseShape,
    workspaceName: NullableLabelSchema,
  })
  .strict();

export const BrainSourceDetailsSchema = z
  .object({
    viewer: z.object({ actorId: ResourceIdSchema, isAdmin: z.boolean() }).strict(),
    sources: z.array(BrainSourceViewSchema),
    ownAccounts: z
      .object({
        slack: z.array(BrainSourceAccountSchema),
        linear: z.array(BrainSourceAccountSchema),
        gmail: z.array(BrainSourceAccountSchema),
        google_drive: z.array(BrainSourceAccountSchema),
        hubspot: z.array(BrainSourceAccountSchema),
        granola: z.array(BrainSourceAccountSchema),
        fathom: z.array(BrainSourceAccountSchema),
        attio: z.array(BrainSourceAccountSchema),
      })
      .strict(),
    jamie: z
      .object({
        integration: JamieSourceProviderStateSchema,
        legacyDefaultDelivery: z.boolean(),
        isDefaultBrain: z.boolean(),
      })
      .strict(),
    slack: z.object({ integration: SlackSourceProviderStateSchema }).strict(),
    linear: z.object({ integration: LinearSourceProviderStateSchema }).strict(),
    github: z.object({ integration: GitHubSourceProviderStateSchema }).strict(),
    gmail: z.object({ integration: GmailSourceProviderStateSchema }).strict(),
    googleDrive: z.object({ integration: GoogleDriveSourceProviderStateSchema }).strict(),
    hubspot: z.object({ integration: HubspotSourceProviderStateSchema }).strict(),
    granola: z.object({ integration: GranolaSourceProviderStateSchema }).strict(),
    fathom: z.object({ integration: FathomSourceProviderStateSchema }).strict(),
    attio: z.object({ integration: AttioSourceProviderStateSchema }).strict(),
  })
  .strict()
  .openapi("BrainSourceDetails");

export const BrainSourceDetailsEnvelopeSchema = z
  .object({ data: BrainSourceDetailsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainSourceDetailsEnvelope");

const NamedSourceRefSchema = z
  .object({ id: z.string().min(1).max(512), name: z.string().min(1).max(512) })
  .strict();
const LinearTeamRefSchema = NamedSourceRefSchema.extend({
  key: z.string().max(128).optional(),
}).strict();
const GmailEventRefSchema = z.object({ id: z.enum(["email_received", "email_sent"]) }).strict();
const LinearEventRefSchema = z
  .object({
    id: z.enum([
      "issue_created",
      "issue_updated",
      "issue_status_changed",
      "issue_removed",
      "comment_created",
      "comment_updated",
      "comment_removed",
    ]),
  })
  .strict();
const HubspotObjectTypeRefSchema = z
  .object({ id: z.enum(["contact", "company", "deal"]) })
  .strict();
const HubspotEventRefSchema = z
  .object({ id: z.enum(["object_created", "object_updated", "object_stage_changed"]) })
  .strict();
const AttioObjectTypeRefSchema = z.object({ id: z.enum(["person", "company", "deal"]) }).strict();
const AttioEventRefSchema = z
  .object({ id: z.enum(["object_created", "object_updated", "note_added"]) })
  .strict();
const GitHubActivityEventSchema = z.enum([
  "pull_request_opened",
  "pull_request_merged",
  "pull_request_commented",
  "issue_opened",
  "issue_commented",
]);
const GitHubRepositoryRefSchema = z
  .object({ id: z.string().min(1).max(512), fullName: z.string().min(1).max(512) })
  .strict();

export const SetBrainSourceBodySchema = z
  .union([
    z
      .object({
        operation: z.literal("set_enabled"),
        provider: BrainSourceConfigProviderSchema,
        enabled: z.boolean(),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("slack"),
        enabled: z.boolean(),
        channels: z.array(NamedSourceRefSchema).max(500),
        dms: z.array(NamedSourceRefSchema).max(500),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("linear"),
        enabled: z.boolean(),
        teams: z.array(LinearTeamRefSchema).max(500),
        events: z.array(LinearEventRefSchema).max(50),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("hubspot"),
        enabled: z.boolean(),
        objectTypes: z.array(HubspotObjectTypeRefSchema).max(50),
        events: z.array(HubspotEventRefSchema).max(50),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("attio"),
        enabled: z.boolean(),
        objectTypes: z.array(AttioObjectTypeRefSchema).max(50),
        events: z.array(AttioEventRefSchema).max(50),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("github"),
        enabled: z.boolean(),
        repos: z.array(GitHubRepositoryRefSchema).max(500),
        events: z.array(GitHubActivityEventSchema).max(50),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("gmail"),
        enabled: z.boolean(),
        events: z.array(GmailEventRefSchema).max(50),
        instructions: z.string().max(2_000),
      })
      .strict(),
    z
      .object({
        operation: z.literal("configure"),
        provider: z.literal("google_drive"),
        enabled: z.boolean(),
        allFiles: z.boolean().optional(),
        resourceIds: z.array(z.string().min(1).max(512)).max(100),
      })
      .strict(),
  ])
  .openapi("SetBrainSourceBody");

export const BrainSourceMutationEnvelopeSchema = z
  .object({
    data: z
      .object({
        brainId: ResourceIdSchema,
        integrationId: ResourceIdSchema,
        provider: BrainSourceConfigProviderSchema,
        enabled: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainSourceMutationEnvelope");

export const BrainSourceDeleteEnvelopeSchema = z
  .object({
    data: z
      .object({
        brainId: ResourceIdSchema,
        integrationId: ResourceIdSchema,
        deleted: z.literal(true),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainSourceDeleteEnvelope");

export const BrainSourceOptionsBodySchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("slack") }).strict(),
  z.object({ provider: z.literal("linear") }).strict(),
  z.object({ provider: z.literal("github") }).strict(),
  z
    .object({
      provider: z.literal("google_drive"),
      parentId: z.string().min(1).max(512).optional(),
      query: z.string().min(1).max(200).optional(),
      pageToken: z.string().min(1).max(4_096).optional(),
    })
    .strict(),
]);

const SlackChannelOptionSchema = NamedSourceRefSchema.extend({
  isPrivate: z.boolean(),
  isSlackConnect: z.boolean(),
}).strict();
const SlackDmOptionSchema = NamedSourceRefSchema.extend({ isSlackConnect: z.boolean() }).strict();
const GoogleDriveOptionSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(512),
    kind: z.enum(["file", "folder"]),
    mimeType: z.string().min(1).max(512),
    driveId: z.string().max(512).nullable(),
    webViewLink: z.url().max(4_096).nullable(),
  })
  .strict();

export const BrainSourceOptionsSchema = z
  .discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("slack"),
        channels: z.array(SlackChannelOptionSchema),
        dms: z.array(SlackDmOptionSchema),
        partial: z.boolean(),
      })
      .strict(),
    z
      .object({
        provider: z.literal("linear"),
        teams: z.array(LinearTeamRefSchema),
        partial: z.boolean(),
      })
      .strict(),
    z
      .object({
        provider: z.literal("github"),
        repos: z.array(GitHubRepositoryRefSchema.extend({ private: z.boolean() }).strict()),
      })
      .strict(),
    z
      .object({
        provider: z.literal("google_drive"),
        files: z.array(GoogleDriveOptionSchema),
        nextPageToken: z.string().max(4_096).nullable(),
      })
      .strict(),
  ])
  .openapi("BrainSourceOptions");

export const BrainSourceOptionsEnvelopeSchema = z
  .object({ data: BrainSourceOptionsSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainSourceOptionsEnvelope");

export const BrainImportProviderSchema = z.enum([
  "public_web",
  "github",
  "jamie",
  "granola",
  "fathom",
  "gmail",
  "slack",
  "linear",
]);

export const BrainImportRunStatusSchema = z.enum([
  "discovering",
  "awaiting_confirmation",
  "ingesting",
  "finalizing",
  "succeeded",
  "partial",
  "failed",
  "canceled",
]);

// GitHub is the only provider whose import scope may be chosen at start time before a
// configured Brain source exists. Every other provider reuses its stored source configuration.
const BrainImportGitHubRepositoryRefSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    fullName: z.string().min(1).max(200).optional(),
  })
  .strict();

const BrainImportSourceSelectionEntrySchema = z
  .object({
    enabled: z.boolean(),
    integrationId: ResourceIdSchema.optional(),
    config: z
      .object({ repos: z.array(BrainImportGitHubRepositoryRefSchema).max(20).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const StartBrainImportBodySchema = z
  .object({
    companyUrl: z.string().min(1).max(2_048),
    focus: z.string().max(2_000).optional(),
    sourceSelection: z.record(z.string().max(32), BrainImportSourceSelectionEntrySchema),
  })
  .strict()
  .openapi("StartBrainImportBody");

export const ConfirmBrainImportBodySchema = z
  .object({ enabledProviders: z.array(BrainImportProviderSchema).max(8) })
  .strict()
  .openapi("ConfirmBrainImportBody");

export const BrainImportRunCommandEnvelopeSchema = z
  .object({
    data: z
      .object({
        importRunId: ResourceIdSchema,
        status: BrainImportRunStatusSchema,
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainImportRunCommandEnvelope");

export const BrainImportProviderSummarySchema = z
  .object({
    status: z.enum(["pending", "ready", "failed", "unavailable"]),
    discoveredEntries: z.number().int().min(0),
    eligibleEntries: z.number().int().min(0),
    alreadyKnownEntries: z.number().int().min(0),
    selectedEntries: z.number().int().min(0),
    plannedRuns: z.number().int().min(0),
    error: z.string().max(2_000).optional(),
  })
  .strict()
  .openapi("BrainImportProviderSummaryV1");

export const BrainImportRunReadModelSchema = z
  .object({
    id: ResourceIdSchema,
    status: BrainImportRunStatusSchema,
    companyUrl: z.string().max(2_048),
    companyName: z.string().max(512).nullable(),
    focus: z.string().max(2_000).nullable(),
    sourceSelection: z.record(z.string().max(32), z.object({ enabled: z.boolean() }).strict()),
    discoverySummary: z.record(z.string().max(32), BrainImportProviderSummarySchema),
    lastError: z.string().max(2_000).nullable(),
    confirmedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("BrainImportRunReadModelV1");

export const WikiKindSchema = z.enum([
  "person",
  "company",
  "project",
  "research",
  "meeting",
  "other",
]);

export const WikiPageSchema = z
  .object({
    id: ResourceIdSchema,
    slug: z.string().min(1).max(80),
    path: z.string().min(1).max(512),
    title: z.string().max(160),
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

export const WikiPageReadModelSchema = WikiPageSchema.openapi("WikiPageReadModelV1");
export const WikiTimelineReadModelSchema =
  WikiTimelineEntrySchema.openapi("WikiTimelineReadModelV1");

export const SkillSourceSchema = z
  .object({
    type: z.enum(["github", "skills.sh"]),
    url: z.url(),
    ref: z.string(),
    path: z.string(),
    resolvedCommit: z.string(),
  })
  .strict()
  .openapi("SkillSource");

export const SkillSchema = z
  .object({
    id: ResourceIdSchema,
    slug: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
    instructions: z.string().max(256 * 1_024),
    status: z.enum(["draft", "active"]),
    source: SkillSourceSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .openapi("Skill");

export const SkillListItemSchema = SkillSchema.omit({
  instructions: true,
  createdAt: true,
}).openapi("SkillListItem");
export const SkillCatalogItemSchema = z
  .object({
    id: z.string().min(1).max(64),
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

export const SkillImportPreviewSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("resolved"),
        proposedSlug: z.string().min(1).max(64),
        name: z.string().min(1).max(64),
        description: z.string().max(1_024),
        instructions: z.string().max(256 * 1_024),
        extraFiles: z.array(z.string().max(512)).max(31),
        resolvedCommit: z.string().regex(/^[0-9a-f]{40}$/iu),
        integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
      })
      .strict(),
    z
      .object({
        status: z.literal("ambiguous"),
        candidates: z.array(SkillImportCandidateSchema).min(1).max(25),
      })
      .strict(),
  ])
  .openapi("SkillImportPreview");

export const BrainSnapshotEnvelopeSchema = z
  .object({ data: BrainSnapshotSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainSnapshotEnvelope");
export const BrainOverviewEnvelopeSchema = z
  .object({ data: BrainOverviewSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainOverviewEnvelope");
export const BrainDocumentEnvelopeSchema = z
  .object({ data: BrainDocumentSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainDocumentEnvelope");
export const BrainAssetMutationEnvelopeSchema = z
  .object({
    data: z
      .object({
        document: BrainDocumentSchema,
        quotaPaused: z.boolean(),
        replayed: z.boolean(),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainAssetMutationEnvelope");
export const BrainFolderEnvelopeSchema = z
  .object({ data: BrainFolderSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainFolderEnvelope");

export const CreateBrainDocumentBodySchema = z
  .object({
    folderPath: z.string().min(1).max(512),
    fileName: z.string().min(1).max(160),
  })
  .strict()
  .openapi("CreateBrainDocumentBody");
export const BrainAssetUploadBodySchema = z
  .object({
    folderPath: z.string().min(1).max(512),
    file: z
      .file()
      .max(20 * 1024 * 1024)
      .openapi({ type: "string", format: "binary" }),
  })
  .strict()
  .openapi("BrainAssetUploadBody");
export const BrainAssetReplaceBodySchema = z
  .object({
    file: z
      .file()
      .max(20 * 1024 * 1024)
      .openapi({ type: "string", format: "binary" }),
  })
  .strict()
  .openapi("BrainAssetReplaceBody");
export const UpdateBrainDocumentBodySchema = z
  .object({
    body: z.string().max(1_000_000),
    expectedContentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict()
  .openapi("UpdateBrainDocumentBody");
export const RenameBrainDocumentBodySchema = z
  .object({ title: z.string().min(1).max(160) })
  .strict()
  .openapi("RenameBrainDocumentBody");
export const CreateBrainFolderBodySchema = z
  .object({ path: z.string().min(1).max(512) })
  .strict()
  .openapi("CreateBrainFolderBody");
export const RenameBrainFolderBodySchema = z
  .object({ fromPath: z.string().min(1).max(512), toPath: z.string().min(1).max(512) })
  .strict()
  .openapi("RenameBrainFolderBody");
export const DeleteBrainFolderBodySchema = z
  .object({ path: z.string().min(1).max(512) })
  .strict()
  .openapi("DeleteBrainFolderBody");
export const BrainDocumentDeleteEnvelopeSchema = z
  .object({
    data: z.object({ documentId: ResourceIdSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainDocumentDeleteEnvelope");
export const BrainFolderPathEnvelopeSchema = z
  .object({
    data: z.object({ path: z.string().min(1).max(512) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainFolderPathEnvelope");

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
export const CreateWikiPageBodySchema = z
  .object({
    clientPageId: ResourceIdSchema.optional(),
    parentPath: z.string().min(1).max(512).nullable(),
    title: z.string().max(160),
    slug: z.string().min(1).max(80).optional(),
  })
  .strict()
  .openapi("CreateWikiPageBody");
export const UpdateWikiPageBodySchema = z
  .object({
    body: z.string().max(1_000_000),
    kind: WikiKindSchema.optional(),
    title: z.string().max(160).optional(),
  })
  .strict()
  .openapi("UpdateWikiPageBody");
export const DeleteWikiPageBodySchema = z
  .object({ recursive: z.boolean().optional() })
  .strict()
  .openapi("DeleteWikiPageBody");
export const AddWikiTimelineEntryBodySchema = z
  .object({
    clientEntryId: ResourceIdSchema.optional(),
    text: z.string().min(1).max(20_000),
    at: TimestampSchema.optional(),
  })
  .strict()
  .openapi("AddWikiTimelineEntryBody");

export const SkillListEnvelopeSchema = z
  .object({ data: z.array(SkillListItemSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillListEnvelope");
export const SkillCatalogEnvelopeSchema = z
  .object({ data: z.array(SkillCatalogItemSchema), meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillCatalogEnvelope");
export const SkillEnvelopeSchema = z
  .object({ data: SkillSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("SkillEnvelope");
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
  expectedResolvedCommit: z.string().regex(/^[0-9a-f]{40}$/iu),
  expectedIntegrity: z.string().regex(/^sha256:[0-9a-f]{64}$/iu),
})
  .strict()
  .openapi("ImportSkillBody");
export const SkillImportEnvelopeSchema = z
  .object({
    data: z.object({ skill: SkillSchema, replayed: z.boolean() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("SkillImportEnvelope");
export const CreateSkillBodySchema = z
  .object({ name: z.string().min(1).max(64), description: z.string().max(1_024).optional() })
  .strict()
  .openapi("CreateSkillBody");
export const UpdateSkillBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(1_024),
    instructions: z.string().max(256 * 1_024),
    status: z.enum(["draft", "active"]),
  })
  .strict()
  .openapi("UpdateSkillBody");
export const SkillArchiveEnvelopeSchema = z
  .object({
    data: z.object({ slug: z.string().min(1).max(64) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("SkillArchiveEnvelope");

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

// Brain admin/switch control plane (#1203 5a4c). The active-Brain cookie is
// intentionally absent: the web adapter owns that browser preference.
export const BrainVisibilitySchema = z.enum(["workspace", "restricted"]);
export const BrainIntelligenceSchema = z.enum(["basic", "frontier"]);

export const CreateBrainBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    visibility: BrainVisibilitySchema,
    description: z.string().trim().max(1_024).optional(),
  })
  .strict()
  .openapi("CreateBrainBody");

export const BrainControlMutationEnvelopeSchema = z
  .object({
    data: z.object({ brainId: ResourceIdSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainControlMutationEnvelope");

export const WorkspaceMemberSchema = z
  .object({
    id: ResourceIdSchema,
    email: z.email().max(320),
    name: z.string().min(1).max(512),
    avatarUrl: z.string().max(4_096).nullable(),
    role: z.enum(["admin", "member"]),
  })
  .strict()
  .openapi("WorkspaceMember");

export const BrainAccessSchema = z
  .object({
    visibility: BrainVisibilitySchema,
    memberIds: z.array(ResourceIdSchema).max(1_000),
    workspaceMembers: z.array(WorkspaceMemberSchema).max(1_000),
  })
  .strict()
  .openapi("BrainAccess");

export const BrainAccessEnvelopeSchema = z
  .object({ data: BrainAccessSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("BrainAccessEnvelope");

export const SetBrainAccessBodySchema = z
  .object({
    visibility: BrainVisibilitySchema,
    memberIds: z.array(ResourceIdSchema).max(1_000),
  })
  .strict()
  .openapi("SetBrainAccessBody");

export const BrainAccessMutationEnvelopeSchema = z
  .object({
    data: z.object({ updated: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainAccessMutationEnvelope");

export const BrainEnrichmentEnvelopeSchema = z
  .object({
    data: z.object({ enabled: z.boolean() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainEnrichmentEnvelope");

export const SetBrainEnrichmentBodySchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi("SetBrainEnrichmentBody");

export const BrainIntelligenceEnvelopeSchema = z
  .object({
    data: z.object({ intelligence: BrainIntelligenceSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("BrainIntelligenceEnvelope");

export const SetBrainIntelligenceBodySchema = z
  .object({ intelligence: BrainIntelligenceSchema })
  .strict()
  .openapi("SetBrainIntelligenceBody");

// Active workspace administration and WorkOS-backed provisioning (#1203
// 5a4d-5a4e). AuthKit session activation remains a web responsibility.
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

export const WorkspaceCommandEnvelopeSchema = z
  .object({
    data: z.object({ completed: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("WorkspaceCommandEnvelope");

export const CreateWorkspaceBodySchema = z
  .object({
    workspaceId: ResourceIdSchema.refine((value: string) => value.startsWith("goat_ws_"), {
      message: "workspaceId must be a Goat workspace id.",
    }),
    name: z.string().trim().min(1).max(80),
  })
  .strict()
  .openapi("CreateWorkspaceBody");

export const WorkspaceActivationSchema = z
  .object({
    workspaceId: ResourceIdSchema,
    organizationId: ResourceIdSchema,
    brainId: ResourceIdSchema.nullable(),
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
    activeBrainId: ResourceIdSchema.nullable(),
  })
  .strict()
  .openapi("OnboardingState");

export const OnboardingStateEnvelopeSchema = z
  .object({ data: OnboardingStateSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("OnboardingStateEnvelope");

export const CheckOnboardingWorkspaceSlugBodySchema = z
  .object({ slug: z.string().max(256) })
  .strict()
  .openapi("CheckOnboardingWorkspaceSlugBody");

export const OnboardingWorkspaceSlugEnvelopeSchema = z
  .object({
    data: z.object({ slug: z.string().max(40), available: z.boolean() }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("OnboardingWorkspaceSlugEnvelope");

export const SaveOnboardingProfileBodySchema = z
  .object({ role: OnboardingRoleSchema, companyUrl: z.url().max(2_048) })
  .strict()
  .openapi("SaveOnboardingProfileBody");

export const SaveOnboardingWorkspaceBodySchema = z
  .object({
    workspaceId: ResourceIdSchema.refine((value: string) => value.startsWith("goat_ws_"), {
      message: "workspaceId must be a Goat workspace id.",
    }),
    name: z.string().trim().min(1).max(80),
    slug: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  })
  .strict()
  .openapi("SaveOnboardingWorkspaceBody");

export const OnboardingWorkspaceEnvelopeSchema = z
  .object({
    data: z
      .object({
        workspaceId: ResourceIdSchema,
        organizationId: ResourceIdSchema,
        brainId: ResourceIdSchema,
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
export const McpClientSchema = z.enum(["claude", "chatgpt", "cursor"]);

export const UserPreferencesSchema = z
  .object({
    timezone: z.string().min(1).max(100),
    taskSpawningEnabled: z.boolean(),
    wikiEnabled: z.boolean(),
    taskViewMode: TaskViewModeSchema,
    imessageEnabled: z.boolean(),
    autoModelRoutingEnabled: z.boolean(),
  })
  .strict()
  .openapi("UserPreferences");

export const UpdateUserPreferencesBodySchema = z
  .object({
    timezone: z.string().min(1).max(100).optional(),
    taskSpawningEnabled: z.boolean().optional(),
    wikiEnabled: z.boolean().optional(),
    taskViewMode: TaskViewModeSchema.optional(),
    imessageEnabled: z.boolean().optional(),
    autoModelRoutingEnabled: z.boolean().optional(),
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

export const SubmitFeedbackBodySchema = z
  .object({
    kind: FeedbackKindSchema,
    message: z.string().trim().min(3).max(4_000),
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

export const IntegrationAccountUsageEnvelopeSchema = z
  .object({
    data: z
      .object({
        // brain_sources rows fed by this connection (across all brains).
        affectedBrainSourceCount: z.number().int().min(0),
      })
      .strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("IntegrationAccountUsageEnvelope");

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

// Provider API keys arrive in request bodies over TLS, exactly as the retired
// Server Actions received them. They never appear in any response.
export const IntegrationApiKeyBodySchema = z
  .object({ apiKey: z.string().min(1).max(4_000) })
  .strict()
  .openapi("IntegrationApiKeyBody");

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

export const ImessageAccountStateSchema = z
  .object({
    provider: z.literal("imessage"),
    connected: z.boolean(),
    status: IntegrationAccountStatusSchema,
    integrationId: IntegrationAccountIdSchema.nullable(),
    phoneE164: z.string().nullable(),
    statusReason: z.string().nullable(),
  })
  .strict()
  .openapi("ImessageAccountState");

export const ImessageAccountStateEnvelopeSchema = z
  .object({
    data: z.object({ state: ImessageAccountStateSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ImessageAccountStateEnvelope");

export const StartImessagePairingBodySchema = z
  .object({
    // E.164 normalization happens server-side so typos keep the retired
    // action's human-readable error copy.
    phone: z.string().min(1).max(64),
  })
  .strict()
  .openapi("StartImessagePairingBody");

export const ImessagePairingStartedEnvelopeSchema = z
  .object({
    data: z.object({ started: z.literal(true) }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("ImessagePairingStartedEnvelope");

export const ConfirmImessagePairingBodySchema = z
  .object({ code: z.string().min(1).max(16) })
  .strict()
  .openapi("ConfirmImessagePairingBody");

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

// The webhook URL and header name are connection instructions, not secrets;
// the Jamie-issued API key itself is write-only and never returned.
export const JamieWebhookSetupSchema = z
  .object({
    integrationId: IntegrationAccountIdSchema,
    webhookUrl: z.string().min(1),
    headerName: z.string().min(1),
    apiKeyConfigured: z.boolean(),
  })
  .strict()
  .openapi("JamieWebhookSetup");

export const JamieWebhookSetupEnvelopeSchema = z
  .object({
    data: z.object({ setup: JamieWebhookSetupSchema }).strict(),
    meta: ProtocolMetadataSchema,
  })
  .strict()
  .openapi("JamieWebhookSetupEnvelope");

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
  })
  .strict()
  .openapi("CodexAuthStatus");

export const CodexAuthStatusEnvelopeSchema = z
  .object({ data: CodexAuthStatusSchema, meta: ProtocolMetadataSchema })
  .strict()
  .openapi("CodexAuthStatusEnvelope");

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
export type BrainSnapshotDto = z.infer<typeof BrainSnapshotSchema>;
export type BrainOverviewDto = z.infer<typeof BrainOverviewSchema>;
export type BrainDocumentDto = z.infer<typeof BrainDocumentSchema>;
export type BrainFolderDto = z.infer<typeof BrainFolderSchema>;
export type BrainDocumentReadModel = z.infer<typeof BrainDocumentReadModelSchema>;
export type BrainFolderReadModel = z.infer<typeof BrainFolderReadModelSchema>;
export type BrainTimelineReadModel = z.infer<typeof BrainTimelineReadModelSchema>;
export type BrainEdgeReadModel = z.infer<typeof BrainEdgeReadModelSchema>;
export type BrainIngestJobReadModel = z.infer<typeof BrainIngestJobReadModelSchema>;
export type BrainSourceItemDto = z.infer<typeof BrainSourceItemSchema>;
export type BrainImportProvider = z.infer<typeof BrainImportProviderSchema>;
export type BrainImportRunStatus = z.infer<typeof BrainImportRunStatusSchema>;
export type StartBrainImportBody = z.infer<typeof StartBrainImportBodySchema>;
export type ConfirmBrainImportBody = z.infer<typeof ConfirmBrainImportBodySchema>;
export type BrainImportRunCommandDto = z.infer<typeof BrainImportRunCommandEnvelopeSchema>["data"];
export type BrainImportProviderSummary = z.infer<typeof BrainImportProviderSummarySchema>;
export type BrainImportRunReadModel = z.infer<typeof BrainImportRunReadModelSchema>;
export type BrainSourceDetailsDto = z.infer<typeof BrainSourceDetailsSchema>;
export type SetBrainSourceBody = z.infer<typeof SetBrainSourceBodySchema>;
export type BrainSourceOptionsBody = z.infer<typeof BrainSourceOptionsBodySchema>;
export type BrainSourceOptionsDto = z.infer<typeof BrainSourceOptionsSchema>;
export type CreateBrainDocumentBody = z.infer<typeof CreateBrainDocumentBodySchema>;
export type UpdateBrainDocumentBody = z.infer<typeof UpdateBrainDocumentBodySchema>;
export type RenameBrainDocumentBody = z.infer<typeof RenameBrainDocumentBodySchema>;
export type CreateBrainFolderBody = z.infer<typeof CreateBrainFolderBodySchema>;
export type RenameBrainFolderBody = z.infer<typeof RenameBrainFolderBodySchema>;
export type DeleteBrainFolderBody = z.infer<typeof DeleteBrainFolderBodySchema>;
export type WikiPageDto = z.infer<typeof WikiPageSchema>;
export type WikiPageReadModel = z.infer<typeof WikiPageReadModelSchema>;
export type WikiTimelineReadModel = z.infer<typeof WikiTimelineReadModelSchema>;
export type CreateWikiPageBody = z.infer<typeof CreateWikiPageBodySchema>;
export type UpdateWikiPageBody = z.infer<typeof UpdateWikiPageBodySchema>;
export type DeleteWikiPageBody = z.infer<typeof DeleteWikiPageBodySchema>;
export type AddWikiTimelineEntryBody = z.infer<typeof AddWikiTimelineEntryBodySchema>;
export type SkillDto = z.infer<typeof SkillSchema>;
export type SkillListItemDto = z.infer<typeof SkillListItemSchema>;
export type SkillCatalogItemDto = z.infer<typeof SkillCatalogItemSchema>;
export type CreateSkillBody = z.infer<typeof CreateSkillBodySchema>;
export type UpdateSkillBody = z.infer<typeof UpdateSkillBodySchema>;
export type SkillImportCandidateDto = z.infer<typeof SkillImportCandidateSchema>;
export type SkillImportPreviewDto = z.infer<typeof SkillImportPreviewSchema>;
export type SkillImportPreviewBody = z.infer<typeof SkillImportPreviewBodySchema>;
export type ImportSkillBody = z.infer<typeof ImportSkillBodySchema>;
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
export type BrowserProfileDto = z.infer<typeof BrowserProfileSchema>;
export type CreateBrowserProfileBody = z.infer<typeof CreateBrowserProfileBodySchema>;
export type BrowserProfileLoginSessionDto = z.infer<typeof BrowserProfileLoginSessionSchema>;
export type ManagedCapabilitySource = z.infer<typeof ManagedCapabilitySourceSchema>;
export type WorkspaceCapabilityDto = z.infer<typeof WorkspaceCapabilitySchema>;
export type WorkspaceCapabilitySettingsDto = z.infer<
  typeof WorkspaceCapabilitySettingsEnvelopeSchema
>["data"];
export type CapabilityApprovalDto = z.infer<typeof CapabilityApprovalSchema>;
export type BrainVisibility = z.infer<typeof BrainVisibilitySchema>;
export type BrainIntelligence = z.infer<typeof BrainIntelligenceSchema>;
export type WorkspaceMemberDto = z.infer<typeof WorkspaceMemberSchema>;
export type BrainAccessDto = z.infer<typeof BrainAccessSchema>;
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
export type UserPreferencesDto = z.infer<typeof UserPreferencesSchema>;
export type UpdateUserPreferencesBody = z.infer<typeof UpdateUserPreferencesBodySchema>;
export type McpSetupDto = z.infer<typeof McpSetupSchema>;
export type UpdateMcpSetupBody = z.infer<typeof UpdateMcpSetupBodySchema>;
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;
export type SubmitFeedbackBody = z.infer<typeof SubmitFeedbackBodySchema>;
export type WorkspaceRepositoryDto = z.infer<typeof WorkspaceRepositorySchema>;
export type RepoConfigDto = z.infer<typeof RepoConfigSchema>;
export type SetRepoConfigEnvBody = z.infer<typeof SetRepoConfigEnvBodySchema>;
export type SetRepoConfigSetupBody = z.infer<typeof SetRepoConfigSetupBodySchema>;
export type IntegrationAccountStatus = z.infer<typeof IntegrationAccountStatusSchema>;
export type AttioAccountStateDto = z.infer<typeof AttioAccountStateSchema>;
export type FathomAccountStateDto = z.infer<typeof FathomAccountStateSchema>;
export type GranolaAccountStateDto = z.infer<typeof GranolaAccountStateSchema>;
export type ImessageAccountStateDto = z.infer<typeof ImessageAccountStateSchema>;
export type StripeAccountStateDto = z.infer<typeof StripeAccountStateSchema>;
export type JamieWebhookSetupDto = z.infer<typeof JamieWebhookSetupSchema>;

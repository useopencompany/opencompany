import { createRoute, OpenAPIHono, type RouteHandler, z } from "@hono/zod-openapi";
import { RunStreamEventSchema } from "./events";
import {
  AddWikiTimelineEntryBodySchema,
  ArchiveVersionBodySchema,
  AttachmentUploadBodySchema,
  AttachmentUploadEnvelopeSchema,
  BrainDocumentDeleteEnvelopeSchema,
  BrainDocumentEnvelopeSchema,
  BrainFolderEnvelopeSchema,
  BrainFolderPathEnvelopeSchema,
  BrainOverviewEnvelopeSchema,
  BrainSnapshotEnvelopeSchema,
  CancelRunEnvelopeSchema,
  ConversationEnvelopeSchema,
  ConversationPageSchema,
  CreateBrainDocumentBodySchema,
  CreateBrainFolderBodySchema,
  CreateMessageBodySchema,
  CreateMessageEnvelopeSchema,
  CreateSkillBodySchema,
  CreateTaskBodySchema,
  CreateTaskEnvelopeSchema,
  CreateTaskScheduleBodySchema,
  CreateWikiPageBodySchema,
  CreateWorkflowBodySchema,
  CursorSchema,
  DeleteBrainFolderBodySchema,
  DeleteWikiPageBodySchema,
  ErrorEnvelopeSchema,
  InvokeWorkflowBodySchema,
  LegacyTaskHistoryEnvelopeSchema,
  LegacyTaskPageSchema,
  MessagePageSchema,
  PresentationCursorSchema,
  ReadModelSchema,
  RenameBrainDocumentBodySchema,
  RenameBrainFolderBodySchema,
  ResolveApprovalBodySchema,
  ResolveApprovalEnvelopeSchema,
  ResourceIdSchema,
  RunEnvelopeSchema,
  SkillArchiveEnvelopeSchema,
  SkillCatalogEnvelopeSchema,
  SkillEnvelopeSchema,
  SkillListEnvelopeSchema,
  TaskEnvelopeSchema,
  TaskPageSchema,
  TaskScheduleArchiveEnvelopeSchema,
  TaskScheduleEnvelopeSchema,
  TaskScheduleMutationEnvelopeSchema,
  TaskSchedulePageSchema,
  TaskScheduleUpdateEnvelopeSchema,
  TaskSummaryEnvelopeSchema,
  UpdateBrainDocumentBodySchema,
  UpdateConversationBodySchema,
  UpdateConversationEnvelopeSchema,
  UpdateSkillBodySchema,
  UpdateTaskBodySchema,
  UpdateTaskEnvelopeSchema,
  UpdateTaskScheduleCommandSchema,
  UpdateWikiPageBodySchema,
  UpdateWorkflowBodySchema,
  WikiPageDeleteEnvelopeSchema,
  WikiPageListEnvelopeSchema,
  WikiPageMutationEnvelopeSchema,
  WikiTimelineMutationEnvelopeSchema,
  WorkflowArchiveEnvelopeSchema,
  WorkflowEnvelopeSchema,
  WorkflowMutationEnvelopeSchema,
  WorkflowPageSchema,
  WorkflowUpdateEnvelopeSchema,
} from "./schemas";
import { OPENAPI_DOCUMENT_VERSION, PROTOCOL_VERSION } from "./version";

const actorSecurity = [{ bearerAuth: [] }, { sessionCookie: [] }];
const errorResponse = {
  description: "A structured protocol error.",
  content: { "application/json": { schema: ErrorEnvelopeSchema } },
} as const;

export const listTasksRoute = createRoute({
  method: "get",
  path: "/v1/tasks",
  tags: ["Tasks"],
  security: actorSecurity,
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      archived: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Actor-visible Tasks.",
      content: { "application/json": { schema: TaskPageSchema } },
    },
    default: errorResponse,
  },
});

export const createTaskRoute = createRoute({
  method: "post",
  path: "/v1/tasks",
  tags: ["Tasks"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: CreateTaskBodySchema } } },
  },
  responses: {
    202: {
      description: "Task accepted with its initial Message and queued Run.",
      content: { "application/json": { schema: CreateTaskEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getTaskRoute = createRoute({
  method: "get",
  path: "/v1/tasks/{taskId}",
  tags: ["Tasks"],
  security: actorSecurity,
  request: { params: z.object({ taskId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "A Task and its canonical Conversation link.",
      content: { "application/json": { schema: TaskEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateTaskRoute = createRoute({
  method: "patch",
  path: "/v1/tasks/{taskId}",
  tags: ["Tasks"],
  security: actorSecurity,
  request: {
    params: z.object({ taskId: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: UpdateTaskBodySchema } } },
  },
  responses: {
    200: {
      description: "Updated Task and Electric transaction boundary.",
      content: { "application/json": { schema: UpdateTaskEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getTaskSummaryRoute = createRoute({
  method: "get",
  path: "/v1/tasks/{taskId}/summary",
  tags: ["Tasks"],
  security: actorSecurity,
  request: { params: z.object({ taskId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Usage cost and terminal duration for an actor-visible Task.",
      content: { "application/json": { schema: TaskSummaryEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listLegacyTasksRoute = createRoute({
  method: "get",
  path: "/v1/compatibility/tasks",
  tags: ["Task compatibility"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Read-only metadata for sessionless pre-cutover Tasks.",
      content: { "application/json": { schema: LegacyTaskPageSchema } },
    },
    default: errorResponse,
  },
});

export const getLegacyTaskHistoryRoute = createRoute({
  method: "get",
  path: "/v1/compatibility/tasks/{taskId}/history",
  tags: ["Task compatibility"],
  security: actorSecurity,
  request: { params: z.object({ taskId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Read-only transcript and events for a sessionless pre-cutover Task.",
      content: { "application/json": { schema: LegacyTaskHistoryEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listWorkflowsRoute = createRoute({
  method: "get",
  path: "/v1/workflows",
  tags: ["Workflows"],
  security: actorSecurity,
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Actor-visible Workflow definitions.",
      content: { "application/json": { schema: WorkflowPageSchema } },
    },
    default: errorResponse,
  },
});

export const createWorkflowRoute = createRoute({
  method: "post",
  path: "/v1/workflows",
  tags: ["Workflows"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: CreateWorkflowBodySchema } } },
  },
  responses: {
    201: {
      description: "Workflow definition created.",
      content: { "application/json": { schema: WorkflowMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getWorkflowRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{workflowId}",
  tags: ["Workflows"],
  security: actorSecurity,
  request: { params: z.object({ workflowId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "A Workflow definition and trigger.",
      content: { "application/json": { schema: WorkflowEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateWorkflowRoute = createRoute({
  method: "patch",
  path: "/v1/workflows/{workflowId}",
  tags: ["Workflows"],
  security: actorSecurity,
  request: {
    params: z.object({ workflowId: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: UpdateWorkflowBodySchema } } },
  },
  responses: {
    200: {
      description: "Workflow updated after an optimistic version check.",
      content: { "application/json": { schema: WorkflowUpdateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const archiveWorkflowRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{workflowId}/archive",
  tags: ["Workflows"],
  security: actorSecurity,
  request: {
    params: z.object({ workflowId: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: ArchiveVersionBodySchema } } },
  },
  responses: {
    200: {
      description: "Workflow archived after an optimistic version check.",
      content: { "application/json": { schema: WorkflowArchiveEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const invokeWorkflowRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{workflowId}/invoke",
  tags: ["Workflows"],
  security: actorSecurity,
  request: {
    params: z.object({ workflowId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: InvokeWorkflowBodySchema } } },
  },
  responses: {
    202: {
      description: "Workflow invocation accepted as a canonical Task and Run.",
      content: { "application/json": { schema: CreateTaskEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const runWorkflowNowRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{workflowId}/run-now",
  tags: ["Workflows"],
  security: actorSecurity,
  request: {
    params: z.object({ workflowId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
  },
  responses: {
    202: {
      description: "Scheduled Workflow run-now accepted as a canonical Task and Run.",
      content: { "application/json": { schema: CreateTaskEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listTaskSchedulesRoute = createRoute({
  method: "get",
  path: "/v1/schedules",
  tags: ["Schedules"],
  security: actorSecurity,
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Actor-owned Recurring Task schedules.",
      content: { "application/json": { schema: TaskSchedulePageSchema } },
    },
    default: errorResponse,
  },
});

export const createTaskScheduleRoute = createRoute({
  method: "post",
  path: "/v1/schedules",
  tags: ["Schedules"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateTaskScheduleBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Recurring Task schedule created.",
      content: { "application/json": { schema: TaskScheduleMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getTaskScheduleRoute = createRoute({
  method: "get",
  path: "/v1/schedules/{scheduleId}",
  tags: ["Schedules"],
  security: actorSecurity,
  request: { params: z.object({ scheduleId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "An actor-owned Recurring Task schedule.",
      content: { "application/json": { schema: TaskScheduleEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateTaskScheduleRoute = createRoute({
  method: "patch",
  path: "/v1/schedules/{scheduleId}",
  tags: ["Schedules"],
  security: actorSecurity,
  request: {
    params: z.object({ scheduleId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateTaskScheduleCommandSchema } },
    },
  },
  responses: {
    200: {
      description: "Recurring Task schedule updated or paused after an optimistic version check.",
      content: { "application/json": { schema: TaskScheduleUpdateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const archiveTaskScheduleRoute = createRoute({
  method: "post",
  path: "/v1/schedules/{scheduleId}/archive",
  tags: ["Schedules"],
  security: actorSecurity,
  request: {
    params: z.object({ scheduleId: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: ArchiveVersionBodySchema } } },
  },
  responses: {
    200: {
      description: "Recurring Task schedule archived after an optimistic version check.",
      content: { "application/json": { schema: TaskScheduleArchiveEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const runTaskScheduleNowRoute = createRoute({
  method: "post",
  path: "/v1/schedules/{scheduleId}/run-now",
  tags: ["Schedules"],
  security: actorSecurity,
  request: {
    params: z.object({ scheduleId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
  },
  responses: {
    202: {
      description: "Recurring Task run-now accepted as a canonical Task and Run.",
      content: { "application/json": { schema: CreateTaskEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBrainSnapshotRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}",
  tags: ["Brain"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "An authorized Brain document and folder snapshot.",
      content: { "application/json": { schema: BrainSnapshotEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBrainOverviewRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/overview",
  tags: ["Brain"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Aggregate activity for an authorized Brain.",
      content: { "application/json": { schema: BrainOverviewEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBrainDocumentRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/documents",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateBrainDocumentBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Brain document created or replayed.",
      content: { "application/json": { schema: BrainDocumentEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateBrainDocumentRoute = createRoute({
  method: "patch",
  path: "/v1/brains/{brainId}/documents/{documentId}",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, documentId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateBrainDocumentBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Brain document body updated with optional hash concurrency.",
      content: { "application/json": { schema: BrainDocumentEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const renameBrainDocumentRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/documents/{documentId}/rename",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, documentId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: RenameBrainDocumentBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Brain document title updated.",
      content: { "application/json": { schema: BrainDocumentEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteBrainDocumentRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/documents/{documentId}/delete",
  tags: ["Brain"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema, documentId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Brain document deleted.",
      content: { "application/json": { schema: BrainDocumentDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBrainFolderRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/folders",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateBrainFolderBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Brain folder created.",
      content: { "application/json": { schema: BrainFolderEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const renameBrainFolderRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/folders/rename",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: RenameBrainFolderBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Brain folder and descendants renamed.",
      content: { "application/json": { schema: BrainFolderPathEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteBrainFolderRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/folders/delete",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: DeleteBrainFolderBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Empty custom Brain folder deleted.",
      content: { "application/json": { schema: BrainFolderPathEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listWikiPagesRoute = createRoute({
  method: "get",
  path: "/v1/wiki/pages",
  tags: ["Wiki"],
  security: actorSecurity,
  responses: {
    200: {
      description: "All pages in the active workspace Wiki.",
      content: { "application/json": { schema: WikiPageListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createWikiPageRoute = createRoute({
  method: "post",
  path: "/v1/wiki/pages",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: CreateWikiPageBodySchema } } },
  },
  responses: {
    201: {
      description: "Wiki page created or replayed.",
      content: { "application/json": { schema: WikiPageMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateWikiPageRoute = createRoute({
  method: "patch",
  path: "/v1/wiki/pages/{slug}",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: UpdateWikiPageBodySchema } } },
  },
  responses: {
    200: {
      description: "Wiki page body and metadata updated.",
      content: { "application/json": { schema: WikiPageMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteWikiPageRoute = createRoute({
  method: "post",
  path: "/v1/wiki/pages/{slug}/delete",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: DeleteWikiPageBodySchema } } },
  },
  responses: {
    200: {
      description: "Wiki page or subtree deleted.",
      content: { "application/json": { schema: WikiPageDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const addWikiTimelineEntryRoute = createRoute({
  method: "post",
  path: "/v1/wiki/pages/{slug}/timeline",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "application/json": { schema: AddWikiTimelineEntryBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Wiki timeline entry added or replayed.",
      content: { "application/json": { schema: WikiTimelineMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listSkillsRoute = createRoute({
  method: "get",
  path: "/v1/skills",
  tags: ["Skills"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Workspace skill settings list.",
      content: { "application/json": { schema: SkillListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: CreateSkillBodySchema } } },
  },
  responses: {
    201: {
      description: "Skill draft created or replayed.",
      content: { "application/json": { schema: SkillEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listSkillCatalogRoute = createRoute({
  method: "get",
  path: "/v1/skills/catalog",
  tags: ["Skills"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Active skills available for mentions.",
      content: { "application/json": { schema: SkillCatalogEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getSkillRoute = createRoute({
  method: "get",
  path: "/v1/skills/{slug}",
  tags: ["Skills"],
  security: actorSecurity,
  request: { params: z.object({ slug: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Skill detail.",
      content: { "application/json": { schema: SkillEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateSkillRoute = createRoute({
  method: "patch",
  path: "/v1/skills/{slug}",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: UpdateSkillBodySchema } } },
  },
  responses: {
    200: {
      description: "Hand-authored skill updated.",
      content: { "application/json": { schema: SkillEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const archiveSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills/{slug}/archive",
  tags: ["Skills"],
  security: actorSecurity,
  request: { params: z.object({ slug: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Skill archived.",
      content: { "application/json": { schema: SkillArchiveEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listConversationsRoute = createRoute({
  method: "get",
  path: "/v1/conversations",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Actor-visible conversations.",
      content: { "application/json": { schema: ConversationPageSchema } },
    },
    default: errorResponse,
  },
});

export const getConversationRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{conversationId}",
  tags: ["Chat"],
  security: actorSecurity,
  request: { params: z.object({ conversationId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "A conversation.",
      content: { "application/json": { schema: ConversationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateConversationRoute = createRoute({
  method: "patch",
  path: "/v1/conversations/{conversationId}",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    params: z.object({ conversationId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateConversationBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated conversation and Electric transaction boundary.",
      content: { "application/json": { schema: UpdateConversationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listMessagesRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{conversationId}/messages",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    params: z.object({ conversationId: ResourceIdSchema }),
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Messages in a conversation.",
      content: { "application/json": { schema: MessagePageSchema } },
    },
    default: errorResponse,
  },
});

export const createMessageRoute = createRoute({
  method: "post",
  path: "/v1/messages",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: CreateMessageBodySchema } } },
  },
  responses: {
    202: {
      description: "Message accepted and durable Run queued.",
      content: { "application/json": { schema: CreateMessageEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const uploadAttachmentRoute = createRoute({
  method: "post",
  path: "/v1/attachments",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "multipart/form-data": { schema: AttachmentUploadBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Actor-scoped attachment uploaded and ready for one Message command.",
      content: { "application/json": { schema: AttachmentUploadEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getRunRoute = createRoute({
  method: "get",
  path: "/v1/runs/{runId}",
  tags: ["Runs"],
  security: actorSecurity,
  request: { params: z.object({ runId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "A durable Run.",
      content: { "application/json": { schema: RunEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const streamRunEventsRoute = createRoute({
  method: "get",
  path: "/v1/runs/{runId}/events",
  tags: ["Runs"],
  security: actorSecurity,
  request: {
    params: z.object({ runId: ResourceIdSchema }),
    headers: z.object({ "last-event-id": CursorSchema.optional() }),
    query: z.object({
      cursor: CursorSchema.optional(),
      presentationCursor: PresentationCursorSchema.optional(),
    }),
  },
  responses: {
    200: {
      description:
        "Typed durable Run Events plus optional transient presentation deltas. Only durable events carry SSE IDs.",
      content: {
        "text/event-stream": {
          schema: RunStreamEventSchema,
        },
      },
    },
    default: errorResponse,
  },
});

export const cancelRunRoute = createRoute({
  method: "post",
  path: "/v1/runs/{runId}/cancel",
  tags: ["Runs"],
  security: actorSecurity,
  request: { params: z.object({ runId: ResourceIdSchema }) },
  responses: {
    202: {
      description: "Cancellation requested or completed.",
      content: { "application/json": { schema: CancelRunEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const resolveApprovalRoute = createRoute({
  method: "post",
  path: "/v1/runs/{runId}/approvals/{approvalId}",
  tags: ["Approvals"],
  security: actorSecurity,
  request: {
    params: z.object({ runId: ResourceIdSchema, approvalId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: ResolveApprovalBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Approval resolved.",
      content: { "application/json": { schema: ResolveApprovalEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const streamReadModelRoute = createRoute({
  method: "get",
  path: "/v1/read-models/{readModel}",
  tags: ["Read models"],
  security: actorSecurity,
  request: {
    params: z.object({ readModel: ReadModelSchema }),
    query: z.object({
      conversationId: ResourceIdSchema.optional(),
      brainId: ResourceIdSchema.optional(),
      offset: z.string().optional(),
      handle: z.string().optional(),
      live: z.string().optional(),
      cursor: z.string().optional(),
      log: z.string().optional(),
      expired_handle: z.string().optional(),
      "cache-buster": z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Authorized, versioned Electric read-model stream.",
      content: { "application/json": { schema: z.unknown() } },
    },
    default: errorResponse,
  },
});

export type V1RouteHandlers = {
  listTasks: RouteHandler<typeof listTasksRoute>;
  createTask: RouteHandler<typeof createTaskRoute>;
  getTask: RouteHandler<typeof getTaskRoute>;
  updateTask: RouteHandler<typeof updateTaskRoute>;
  getTaskSummary: RouteHandler<typeof getTaskSummaryRoute>;
  listLegacyTasks: RouteHandler<typeof listLegacyTasksRoute>;
  getLegacyTaskHistory: RouteHandler<typeof getLegacyTaskHistoryRoute>;
  listWorkflows: RouteHandler<typeof listWorkflowsRoute>;
  createWorkflow: RouteHandler<typeof createWorkflowRoute>;
  getWorkflow: RouteHandler<typeof getWorkflowRoute>;
  updateWorkflow: RouteHandler<typeof updateWorkflowRoute>;
  archiveWorkflow: RouteHandler<typeof archiveWorkflowRoute>;
  invokeWorkflow: RouteHandler<typeof invokeWorkflowRoute>;
  runWorkflowNow: RouteHandler<typeof runWorkflowNowRoute>;
  listTaskSchedules: RouteHandler<typeof listTaskSchedulesRoute>;
  createTaskSchedule: RouteHandler<typeof createTaskScheduleRoute>;
  getTaskSchedule: RouteHandler<typeof getTaskScheduleRoute>;
  updateTaskSchedule: RouteHandler<typeof updateTaskScheduleRoute>;
  archiveTaskSchedule: RouteHandler<typeof archiveTaskScheduleRoute>;
  runTaskScheduleNow: RouteHandler<typeof runTaskScheduleNowRoute>;
  getBrainSnapshot: RouteHandler<typeof getBrainSnapshotRoute>;
  getBrainOverview: RouteHandler<typeof getBrainOverviewRoute>;
  createBrainDocument: RouteHandler<typeof createBrainDocumentRoute>;
  updateBrainDocument: RouteHandler<typeof updateBrainDocumentRoute>;
  renameBrainDocument: RouteHandler<typeof renameBrainDocumentRoute>;
  deleteBrainDocument: RouteHandler<typeof deleteBrainDocumentRoute>;
  createBrainFolder: RouteHandler<typeof createBrainFolderRoute>;
  renameBrainFolder: RouteHandler<typeof renameBrainFolderRoute>;
  deleteBrainFolder: RouteHandler<typeof deleteBrainFolderRoute>;
  listWikiPages: RouteHandler<typeof listWikiPagesRoute>;
  createWikiPage: RouteHandler<typeof createWikiPageRoute>;
  updateWikiPage: RouteHandler<typeof updateWikiPageRoute>;
  deleteWikiPage: RouteHandler<typeof deleteWikiPageRoute>;
  addWikiTimelineEntry: RouteHandler<typeof addWikiTimelineEntryRoute>;
  listSkills: RouteHandler<typeof listSkillsRoute>;
  createSkill: RouteHandler<typeof createSkillRoute>;
  listSkillCatalog: RouteHandler<typeof listSkillCatalogRoute>;
  getSkill: RouteHandler<typeof getSkillRoute>;
  updateSkill: RouteHandler<typeof updateSkillRoute>;
  archiveSkill: RouteHandler<typeof archiveSkillRoute>;
  listConversations: RouteHandler<typeof listConversationsRoute>;
  getConversation: RouteHandler<typeof getConversationRoute>;
  updateConversation: RouteHandler<typeof updateConversationRoute>;
  listMessages: RouteHandler<typeof listMessagesRoute>;
  createMessage: RouteHandler<typeof createMessageRoute>;
  uploadAttachment: RouteHandler<typeof uploadAttachmentRoute>;
  getRun: RouteHandler<typeof getRunRoute>;
  streamRunEvents: RouteHandler<typeof streamRunEventsRoute>;
  cancelRun: RouteHandler<typeof cancelRunRoute>;
  resolveApproval: RouteHandler<typeof resolveApprovalRoute>;
  streamReadModel: RouteHandler<typeof streamReadModelRoute>;
};

export function createV1Router(
  handlers: V1RouteHandlers,
  options: {
    beforeRoutes?: (app: OpenAPIHono) => void;
    defaultHook?: NonNullable<ConstructorParameters<typeof OpenAPIHono>[0]>["defaultHook"];
  } = {},
) {
  const app = new OpenAPIHono(options.defaultHook ? { defaultHook: options.defaultHook } : {});
  options.beforeRoutes?.(app);
  return app
    .openapi(listTasksRoute, handlers.listTasks)
    .openapi(createTaskRoute, handlers.createTask)
    .openapi(getTaskRoute, handlers.getTask)
    .openapi(updateTaskRoute, handlers.updateTask)
    .openapi(getTaskSummaryRoute, handlers.getTaskSummary)
    .openapi(listLegacyTasksRoute, handlers.listLegacyTasks)
    .openapi(getLegacyTaskHistoryRoute, handlers.getLegacyTaskHistory)
    .openapi(listWorkflowsRoute, handlers.listWorkflows)
    .openapi(createWorkflowRoute, handlers.createWorkflow)
    .openapi(getWorkflowRoute, handlers.getWorkflow)
    .openapi(updateWorkflowRoute, handlers.updateWorkflow)
    .openapi(archiveWorkflowRoute, handlers.archiveWorkflow)
    .openapi(invokeWorkflowRoute, handlers.invokeWorkflow)
    .openapi(runWorkflowNowRoute, handlers.runWorkflowNow)
    .openapi(listTaskSchedulesRoute, handlers.listTaskSchedules)
    .openapi(createTaskScheduleRoute, handlers.createTaskSchedule)
    .openapi(getTaskScheduleRoute, handlers.getTaskSchedule)
    .openapi(updateTaskScheduleRoute, handlers.updateTaskSchedule)
    .openapi(archiveTaskScheduleRoute, handlers.archiveTaskSchedule)
    .openapi(runTaskScheduleNowRoute, handlers.runTaskScheduleNow)
    .openapi(getBrainSnapshotRoute, handlers.getBrainSnapshot)
    .openapi(getBrainOverviewRoute, handlers.getBrainOverview)
    .openapi(createBrainDocumentRoute, handlers.createBrainDocument)
    .openapi(updateBrainDocumentRoute, handlers.updateBrainDocument)
    .openapi(renameBrainDocumentRoute, handlers.renameBrainDocument)
    .openapi(deleteBrainDocumentRoute, handlers.deleteBrainDocument)
    .openapi(createBrainFolderRoute, handlers.createBrainFolder)
    .openapi(renameBrainFolderRoute, handlers.renameBrainFolder)
    .openapi(deleteBrainFolderRoute, handlers.deleteBrainFolder)
    .openapi(listWikiPagesRoute, handlers.listWikiPages)
    .openapi(createWikiPageRoute, handlers.createWikiPage)
    .openapi(updateWikiPageRoute, handlers.updateWikiPage)
    .openapi(deleteWikiPageRoute, handlers.deleteWikiPage)
    .openapi(addWikiTimelineEntryRoute, handlers.addWikiTimelineEntry)
    .openapi(listSkillsRoute, handlers.listSkills)
    .openapi(createSkillRoute, handlers.createSkill)
    .openapi(listSkillCatalogRoute, handlers.listSkillCatalog)
    .openapi(getSkillRoute, handlers.getSkill)
    .openapi(updateSkillRoute, handlers.updateSkill)
    .openapi(archiveSkillRoute, handlers.archiveSkill)
    .openapi(listConversationsRoute, handlers.listConversations)
    .openapi(getConversationRoute, handlers.getConversation)
    .openapi(updateConversationRoute, handlers.updateConversation)
    .openapi(listMessagesRoute, handlers.listMessages)
    .openapi(createMessageRoute, handlers.createMessage)
    .openapi(uploadAttachmentRoute, handlers.uploadAttachment)
    .openapi(getRunRoute, handlers.getRun)
    .openapi(streamRunEventsRoute, handlers.streamRunEvents)
    .openapi(cancelRunRoute, handlers.cancelRun)
    .openapi(resolveApprovalRoute, handlers.resolveApproval)
    .openapi(streamReadModelRoute, handlers.streamReadModel);
}

export type V1AppType = ReturnType<typeof createV1Router>;

export function createOpenApiDocument() {
  const app = createV1Router(contractDocumentHandlers);
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "wos-session",
  });
  return app.getOpenAPIDocument({
    openapi: OPENAPI_DOCUMENT_VERSION,
    info: { title: "OpenCompany Headless API", version: PROTOCOL_VERSION },
    servers: [{ url: "/", description: "Current origin" }],
  });
}

const meta = { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION } as const;
const placeholderTime = "2026-01-01T00:00:00.000Z";
const placeholderConversation = {
  id: "conversation_contract",
  title: "Contract placeholder",
  engine: "opencompany" as const,
  model: "provider/model",
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderTask = {
  id: "task_contract",
  displayId: "TASK-1",
  name: "Contract placeholder",
  goal: "Complete the contract placeholder.",
  conversationId: "conversation_task_contract",
  status: "queued" as const,
  source: "manual" as const,
  engine: "opencompany" as const,
  model: "provider/model",
  workflowId: null,
  scheduleId: null,
  scheduledFor: null,
  outcome: { result: null, error: null, reportedStatus: null, comment: null },
  archivedAt: null,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderLegacyTask = {
  id: placeholderTask.id,
  displayId: placeholderTask.displayId,
  name: placeholderTask.name,
  goal: placeholderTask.goal,
  status: placeholderTask.status,
  source: placeholderTask.source,
  engine: placeholderTask.engine,
  model: placeholderTask.model,
  workflowId: placeholderTask.workflowId,
  scheduleId: placeholderTask.scheduleId,
  scheduledFor: placeholderTask.scheduledFor,
  outcome: placeholderTask.outcome,
  archivedAt: placeholderTask.archivedAt,
  createdAt: placeholderTask.createdAt,
  updatedAt: placeholderTask.updatedAt,
};
const placeholderWorkflow = {
  id: "workflow_contract",
  slug: "contract-workflow",
  name: "Contract Workflow",
  description: "A contract placeholder.",
  steps: [
    {
      id: "step_contract",
      title: "Execute",
      model: "kimi-k2.6",
      instructions: "Complete the contract placeholder.",
    },
  ],
  status: "active" as const,
  trigger: { type: "manual" as const },
  version: 1,
  archivedAt: null,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderTaskSchedule = {
  id: "schedule_contract",
  name: "Contract schedule",
  sourceDescription: "daily",
  cron: "0 9 * * *",
  timezone: "UTC",
  prompt: "Complete the contract placeholder.",
  enabled: true,
  lastRunAt: null,
  nextRunAt: placeholderTime,
  version: 1,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderBrainFolder = {
  id: "brain_folder_contract",
  path: "inbox",
  source: "system" as const,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderBrainDocument = {
  id: "brain_document_contract",
  brainId: "contract-note",
  folderPath: "inbox",
  path: "inbox/contract-note.md",
  title: "Contract note",
  content: "# Contract note",
  body: "Contract note",
  timeline: [],
  format: "markdown" as const,
  mimeType: "text/markdown",
  originalFileName: null,
  assetSizeBytes: null,
  relations: [],
  sources: [],
  kind: "page" as const,
  type: "note" as const,
  status: "draft" as const,
  aliases: [],
  contentHash: "0".repeat(64),
  sizeBytes: 15,
  createdByActorId: "actor_contract",
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderWikiPage = {
  id: "wiki_page_contract",
  slug: "contract-page",
  path: "contract-page",
  title: "Contract page",
  kind: "other" as const,
  body: "",
  contentHash: "0".repeat(64),
  sizeBytes: 0,
  format: "markdown",
  mimeType: null,
  originalFileName: null,
  assetSizeBytes: null,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};
const placeholderSkill = {
  id: "skill_contract",
  slug: "contract-skill",
  name: "Contract skill",
  description: "A contract placeholder.",
  instructions: "Complete the contract placeholder.",
  status: "active" as const,
  source: null,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
};

function placeholderAutomationTaskEnvelope() {
  return {
    data: {
      task: placeholderTask,
      messageId: "message_task_contract",
      assistantMessageId: "message_task_assistant_contract",
      runId: "run_task_contract",
      transactionId: "1",
      replayed: false,
    },
    meta,
  };
}

const contractDocumentHandlers: V1RouteHandlers = {
  listTasks: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  createTask: (c) =>
    c.json(
      {
        data: {
          task: placeholderTask,
          messageId: "message_task_contract",
          assistantMessageId: "message_task_assistant_contract",
          runId: "run_task_contract",
          transactionId: "1",
          replayed: false,
        },
        meta,
      },
      202,
    ),
  getTask: (c) => c.json({ data: placeholderTask, meta }, 200),
  updateTask: (c) => c.json({ data: { task: placeholderTask, transactionId: "1" }, meta }, 200),
  getTaskSummary: (c) =>
    c.json(
      {
        data: {
          cost: { hasRecordedCosts: false, totalCostUsdMicros: 0 },
          durationMs: null,
        },
        meta,
      },
      200,
    ),
  listLegacyTasks: (c) => c.json({ data: [], meta }, 200),
  getLegacyTaskHistory: (c) =>
    c.json(
      {
        data: {
          task: placeholderLegacyTask,
          messages: [],
          events: [],
        },
        meta,
      },
      200,
    ),
  listWorkflows: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  createWorkflow: (c) =>
    c.json(
      {
        data: { workflow: placeholderWorkflow, transactionId: "1", replayed: false },
        meta,
      },
      201,
    ),
  getWorkflow: (c) => c.json({ data: placeholderWorkflow, meta }, 200),
  updateWorkflow: (c) =>
    c.json({ data: { workflow: placeholderWorkflow, transactionId: "1" }, meta }, 200),
  archiveWorkflow: (c) =>
    c.json(
      { data: { workflowId: placeholderWorkflow.id, version: 2, transactionId: "1" }, meta },
      200,
    ),
  invokeWorkflow: (c) => c.json(placeholderAutomationTaskEnvelope(), 202),
  runWorkflowNow: (c) => c.json(placeholderAutomationTaskEnvelope(), 202),
  listTaskSchedules: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  createTaskSchedule: (c) =>
    c.json(
      {
        data: { schedule: placeholderTaskSchedule, transactionId: "1", replayed: false },
        meta,
      },
      201,
    ),
  getTaskSchedule: (c) => c.json({ data: placeholderTaskSchedule, meta }, 200),
  updateTaskSchedule: (c) =>
    c.json({ data: { schedule: placeholderTaskSchedule, transactionId: "1" }, meta }, 200),
  archiveTaskSchedule: (c) =>
    c.json(
      {
        data: { scheduleId: placeholderTaskSchedule.id, version: 2, transactionId: "1" },
        meta,
      },
      200,
    ),
  runTaskScheduleNow: (c) => c.json(placeholderAutomationTaskEnvelope(), 202),
  getBrainSnapshot: (c) =>
    c.json(
      { data: { folders: [placeholderBrainFolder], documents: [placeholderBrainDocument] }, meta },
      200,
    ),
  getBrainOverview: (c) =>
    c.json(
      {
        data: {
          windowStartedAt: placeholderTime,
          itemsAddedLast7Days: 0,
          retrievalsLast7Days: 0,
          activeSources: 0,
        },
        meta,
      },
      200,
    ),
  createBrainDocument: (c) => c.json({ data: placeholderBrainDocument, meta }, 201),
  updateBrainDocument: (c) => c.json({ data: placeholderBrainDocument, meta }, 200),
  renameBrainDocument: (c) => c.json({ data: placeholderBrainDocument, meta }, 200),
  deleteBrainDocument: (c) =>
    c.json({ data: { documentId: placeholderBrainDocument.id }, meta }, 200),
  createBrainFolder: (c) => c.json({ data: placeholderBrainFolder, meta }, 201),
  renameBrainFolder: (c) => c.json({ data: { path: placeholderBrainFolder.path }, meta }, 200),
  deleteBrainFolder: (c) => c.json({ data: { path: placeholderBrainFolder.path }, meta }, 200),
  listWikiPages: (c) => c.json({ data: [placeholderWikiPage], meta }, 200),
  createWikiPage: (c) =>
    c.json({ data: { page: placeholderWikiPage, transactionIds: [1] }, meta }, 201),
  updateWikiPage: (c) =>
    c.json({ data: { page: placeholderWikiPage, transactionIds: [1] }, meta }, 200),
  deleteWikiPage: (c) =>
    c.json({ data: { deletedPaths: [placeholderWikiPage.path], transactionIds: [1] }, meta }, 200),
  addWikiTimelineEntry: (c) =>
    c.json(
      {
        data: {
          entry: {
            id: "wiki_timeline_contract",
            pageId: placeholderWikiPage.id,
            at: placeholderTime,
            text: "Contract entry",
            createdAt: placeholderTime,
          },
          transactionId: 1,
        },
        meta,
      },
      201,
    ),
  listSkills: (c) =>
    c.json(
      {
        data: [
          {
            id: placeholderSkill.id,
            slug: placeholderSkill.slug,
            name: placeholderSkill.name,
            description: placeholderSkill.description,
            status: placeholderSkill.status,
            source: placeholderSkill.source,
            updatedAt: placeholderSkill.updatedAt,
          },
        ],
        meta,
      },
      200,
    ),
  createSkill: (c) => c.json({ data: placeholderSkill, meta }, 201),
  listSkillCatalog: (c) =>
    c.json(
      {
        data: [
          {
            id: placeholderSkill.slug,
            name: placeholderSkill.name,
            description: placeholderSkill.description,
          },
        ],
        meta,
      },
      200,
    ),
  getSkill: (c) => c.json({ data: placeholderSkill, meta }, 200),
  updateSkill: (c) => c.json({ data: placeholderSkill, meta }, 200),
  archiveSkill: (c) => c.json({ data: { slug: placeholderSkill.slug }, meta }, 200),
  listConversations: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  getConversation: (c) => c.json({ data: placeholderConversation, meta }, 200),
  updateConversation: (c) =>
    c.json({ data: { conversationId: "conversation_contract", transactionId: "1" }, meta }, 200),
  listMessages: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  createMessage: (c) =>
    c.json(
      {
        data: {
          conversationId: "conversation_contract",
          messageId: "message_contract",
          assistantMessageId: "message_assistant_contract",
          runId: "run_contract",
          transactionId: "1",
          replayed: false,
        },
        meta,
      },
      202,
    ),
  uploadAttachment: (c) =>
    c.json(
      {
        data: {
          attachment: {
            id: "attachment_contract",
            filename: "brief.pdf",
            mediaType: "application/pdf",
            sizeBytes: 1024,
            kind: "document",
          },
          expiresAt: placeholderTime,
        },
        meta,
      },
      201,
    ),
  getRun: (c) =>
    c.json(
      {
        data: {
          id: "run_contract",
          conversationId: "conversation_contract",
          triggerMessageId: "message_contract",
          status: "queued" as const,
          engine: "opencompany" as const,
          model: "provider/model",
          attemptCount: 0,
          createdAt: placeholderTime,
          updatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  streamRunEvents: (c) => c.body("", 200, { "Content-Type": "text/event-stream" }),
  cancelRun: (c) =>
    c.json({ data: { runId: "run_contract", status: "canceled", replayed: false }, meta }, 202),
  resolveApproval: (c) =>
    c.json(
      {
        data: {
          approvalId: "approval_contract",
          runId: "run_contract",
          resolution: "approved",
          replayed: false,
        },
        meta,
      },
      200,
    ),
  streamReadModel: (c) => c.json([], 200),
};

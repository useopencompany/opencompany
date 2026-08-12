import { createRoute, OpenAPIHono, type RouteHandler, z } from "@hono/zod-openapi";
import { RunStreamEventSchema } from "./events";
import {
  ArchiveVersionBodySchema,
  AttachmentUploadBodySchema,
  AttachmentUploadEnvelopeSchema,
  CancelRunEnvelopeSchema,
  ConversationEnvelopeSchema,
  ConversationPageSchema,
  CreateMessageBodySchema,
  CreateMessageEnvelopeSchema,
  CreateTaskBodySchema,
  CreateTaskEnvelopeSchema,
  CreateTaskScheduleBodySchema,
  CreateWorkflowBodySchema,
  CursorSchema,
  ErrorEnvelopeSchema,
  InvokeWorkflowBodySchema,
  LegacyTaskHistoryEnvelopeSchema,
  LegacyTaskPageSchema,
  MessagePageSchema,
  PresentationCursorSchema,
  ReadModelSchema,
  ResolveApprovalBodySchema,
  ResolveApprovalEnvelopeSchema,
  ResourceIdSchema,
  RunEnvelopeSchema,
  TaskEnvelopeSchema,
  TaskPageSchema,
  TaskScheduleArchiveEnvelopeSchema,
  TaskScheduleEnvelopeSchema,
  TaskScheduleMutationEnvelopeSchema,
  TaskSchedulePageSchema,
  TaskScheduleUpdateEnvelopeSchema,
  TaskSummaryEnvelopeSchema,
  UpdateConversationBodySchema,
  UpdateConversationEnvelopeSchema,
  UpdateTaskBodySchema,
  UpdateTaskEnvelopeSchema,
  UpdateTaskScheduleCommandSchema,
  UpdateWorkflowBodySchema,
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

import { createRoute, OpenAPIHono, type RouteHandler, z } from "@hono/zod-openapi";
import { RunStreamEventSchema } from "./events";
import {
  ActionPermissionEnvelopeSchema,
  AddWikiTimelineEntryBodySchema,
  ApprovePluginMcpBodySchema,
  ArchiveVersionBodySchema,
  AttachmentUploadBodySchema,
  AttachmentUploadEnvelopeSchema,
  AttioAccountStateEnvelopeSchema,
  BillingAutoRefillEnvelopeSchema,
  BillingBalanceEnvelopeSchema,
  BillingOverviewEnvelopeSchema,
  BillingRedirectEnvelopeSchema,
  BillingUsageEnvelopeSchema,
  BrainAccessEnvelopeSchema,
  BrainAccessMutationEnvelopeSchema,
  BrainAssetMutationEnvelopeSchema,
  BrainAssetReplaceBodySchema,
  BrainAssetUploadBodySchema,
  BrainControlMutationEnvelopeSchema,
  BrainDocumentDeleteEnvelopeSchema,
  BrainDocumentEnvelopeSchema,
  BrainEnrichmentEnvelopeSchema,
  BrainFolderEnvelopeSchema,
  BrainFolderPathEnvelopeSchema,
  BrainImportRunCommandEnvelopeSchema,
  BrainIntelligenceEnvelopeSchema,
  BrainOverviewEnvelopeSchema,
  BrainSnapshotEnvelopeSchema,
  BrainSourceDeleteEnvelopeSchema,
  BrainSourceDetailsEnvelopeSchema,
  BrainSourceItemListEnvelopeSchema,
  BrainSourceMutationEnvelopeSchema,
  BrainSourceOptionsBodySchema,
  BrainSourceOptionsEnvelopeSchema,
  BrowserProfileDeleteEnvelopeSchema,
  BrowserProfileEnvelopeSchema,
  BrowserProfileListEnvelopeSchema,
  BrowserProfileLiveViewEnvelopeSchema,
  BrowserProfileLoginCompleteEnvelopeSchema,
  BrowserProfileLoginSessionEnvelopeSchema,
  CancelRunEnvelopeSchema,
  CapabilityApprovalEnvelopeSchema,
  CapabilitySessionBudgetEnvelopeSchema,
  ChatArtifactDeleteEnvelopeSchema,
  ChatShareIdSchema,
  CheckOnboardingWorkspaceSlugBodySchema,
  ClaudeCodeAuthStatusEnvelopeSchema,
  CodexAuthStatusEnvelopeSchema,
  CodexDeviceAuthFlowEnvelopeSchema,
  CompleteInfisicalAuthBodySchema,
  ConfirmBrainImportBodySchema,
  ConfirmImessagePairingBodySchema,
  ConversationEnvelopeSchema,
  ConversationPageSchema,
  ConversationShareEnvelopeSchema,
  CreateBillingTopUpBodySchema,
  CreateBrainBodySchema,
  CreateBrainDocumentBodySchema,
  CreateBrainFolderBodySchema,
  CreateBrowserProfileBodySchema,
  CreateMessageBodySchema,
  CreateMessageEnvelopeSchema,
  CreateTaskBodySchema,
  CreateTaskEnvelopeSchema,
  CreateTaskScheduleBodySchema,
  CreateWikiPageBodySchema,
  CreateWorkflowBodySchema,
  CreateWorkspaceBodySchema,
  CreateWorkspaceSkillBodySchema,
  CursorSchema,
  DeleteBrainFolderBodySchema,
  DeleteWikiPageBodySchema,
  EngineAuthDisconnectEnvelopeSchema,
  EngineAuthFlowIdSchema,
  EngineRuntimeAccessEnvelopeSchema,
  EngineRuntimeStatusEnvelopeSchema,
  ErrorEnvelopeSchema,
  FathomAccountStateEnvelopeSchema,
  FeedbackSubmissionEnvelopeSchema,
  FinishOnboardingBodySchema,
  GenerateConversationTitleBodySchema,
  GenerateConversationTitleEnvelopeSchema,
  GranolaAccountStateEnvelopeSchema,
  IdentityEnvelopeSchema,
  ImessageAccountStateEnvelopeSchema,
  ImessagePairingStartedEnvelopeSchema,
  ImportSkillBodySchema,
  InfisicalAuthFlowEnvelopeSchema,
  InfisicalAuthStatusEnvelopeSchema,
  InstallPluginBodySchema,
  IntegrationAccountDeleteEnvelopeSchema,
  IntegrationAccountIdSchema,
  IntegrationAccountListEnvelopeSchema,
  IntegrationAccountUsageEnvelopeSchema,
  IntegrationApiKeyBodySchema,
  IntegrationCapabilityModeEnvelopeSchema,
  InviteWorkspaceMemberBodySchema,
  InvokeWorkflowBodySchema,
  JamieWebhookSetupEnvelopeSchema,
  LegacyTaskHistoryEnvelopeSchema,
  LegacyTaskPageSchema,
  ManagedCapabilitySourceSchema,
  McpSetupEnvelopeSchema,
  MessagePageSchema,
  OnboardingCommandEnvelopeSchema,
  OnboardingStateEnvelopeSchema,
  OnboardingWorkspaceEnvelopeSchema,
  OnboardingWorkspaceSlugEnvelopeSchema,
  PluginArchiveEnvelopeSchema,
  PluginDataDeleteEnvelopeSchema,
  PluginImportEnvelopeSchema,
  PluginImportPreviewBodySchema,
  PluginImportPreviewEnvelopeSchema,
  PluginInstallationEnvelopeSchema,
  PluginListEnvelopeSchema,
  PresentationCursorSchema,
  PublicChatShareEnvelopeSchema,
  PublicChatShareMetadataEnvelopeSchema,
  ReadModelSchema,
  RenameBrainDocumentBodySchema,
  RenameBrainFolderBodySchema,
  RenameWorkspaceBodySchema,
  RepoConfigDeleteEnvelopeSchema,
  RepoConfigListEnvelopeSchema,
  RepoConfigMutationEnvelopeSchema,
  RepositoryExternalIdSchema,
  ResolveApprovalBodySchema,
  ResolveApprovalEnvelopeSchema,
  ResourceIdSchema,
  RunEnvelopeSchema,
  SaveClaudeCodeTokenBodySchema,
  SaveOnboardingProfileBodySchema,
  SaveOnboardingWorkspaceBodySchema,
  SetBrainAccessBodySchema,
  SetBrainEnrichmentBodySchema,
  SetBrainIntelligenceBodySchema,
  SetBrainSourceBodySchema,
  SetCapabilitySessionBudgetBodySchema,
  SetIntegrationCapabilityModeBodySchema,
  SetRepoConfigEnvBodySchema,
  SetRepoConfigSetupBodySchema,
  SetSlackBotDestinationBodySchema,
  SetWikiSourceEnabledBodySchema,
  SetWorkspaceCapabilityBodySchema,
  SkillArchiveEnvelopeSchema,
  SkillCatalogEnvelopeSchema,
  SkillFileChunkEnvelopeSchema,
  SkillImportEnvelopeSchema,
  SkillImportPreviewBodySchema,
  SkillImportPreviewEnvelopeSchema,
  SkillInstallationEnvelopeSchema,
  SkillListEnvelopeSchema,
  SlackBotChannelListEnvelopeSchema,
  SlackBotDestinationEnvelopeSchema,
  SlackBotMutationEnvelopeSchema,
  SlackBotWorkspaceSettingsEnvelopeSchema,
  StartBrainImportBodySchema,
  StartImessagePairingBodySchema,
  StartInfisicalAuthBodySchema,
  StripeAccountDeleteEnvelopeSchema,
  StripeAccountStateEnvelopeSchema,
  SubmitFeedbackBodySchema,
  TaskEnvelopeSchema,
  TaskPageSchema,
  TaskScheduleArchiveEnvelopeSchema,
  TaskScheduleEnvelopeSchema,
  TaskScheduleMutationEnvelopeSchema,
  TaskSchedulePageSchema,
  TaskScheduleUpdateEnvelopeSchema,
  TaskSummaryEnvelopeSchema,
  UpdateBillingAutoRefillBodySchema,
  UpdateBrainDocumentBodySchema,
  UpdateConversationBodySchema,
  UpdateConversationEnvelopeSchema,
  UpdateMcpSetupBodySchema,
  UpdateTaskBodySchema,
  UpdateTaskEnvelopeSchema,
  UpdateTaskScheduleCommandSchema,
  UpdateUserPreferencesBodySchema,
  UpdateWikiPageBodySchema,
  UpdateWorkflowBodySchema,
  UpdateWorkspaceSkillBodySchema,
  UpsertWikiSourceBodySchema,
  UserPreferencesEnvelopeSchema,
  WikiIngestActivityListEnvelopeSchema,
  WikiPageDeleteEnvelopeSchema,
  WikiPageListEnvelopeSchema,
  WikiPageMutationEnvelopeSchema,
  WikiSourceDeleteEnvelopeSchema,
  WikiSourceListEnvelopeSchema,
  WikiSourceMutationEnvelopeSchema,
  WikiTimelineMutationEnvelopeSchema,
  WorkflowArchiveEnvelopeSchema,
  WorkflowEnvelopeSchema,
  WorkflowMutationEnvelopeSchema,
  WorkflowPageSchema,
  WorkflowUpdateEnvelopeSchema,
  WorkspaceActivationEnvelopeSchema,
  WorkspaceCapabilityMutationEnvelopeSchema,
  WorkspaceCapabilitySettingsEnvelopeSchema,
  WorkspaceCommandEnvelopeSchema,
  WorkspaceRenameEnvelopeSchema,
  WorkspaceSettingsEnvelopeSchema,
  WorkspaceSkillNameSchema,
} from "./schemas";
import { OPENAPI_DOCUMENT_VERSION, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "./version";

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

export const listBrainSourceItemsRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/source-items",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    query: z.object({
      ids: z
        .string()
        .min(1)
        .max(25_699)
        .transform((value: string) =>
          Array.from(
            new Set(
              value
                .split(",")
                .map((item: string) => item.trim())
                .filter(Boolean),
            ),
          ),
        )
        .pipe(z.array(ResourceIdSchema).min(1).max(100)),
    }),
  },
  responses: {
    200: {
      description: "Bounded public metadata for source items referenced by an authorized Brain.",
      content: { "application/json": { schema: BrainSourceItemListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listBrainSourcesRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/sources",
  tags: ["Brain"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Source configuration and connection state for an authorized Brain.",
      content: { "application/json": { schema: BrainSourceDetailsEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setBrainSourceRoute = createRoute({
  method: "put",
  path: "/v1/brains/{brainId}/sources/{integrationId}",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, integrationId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetBrainSourceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Brain source configured or enabled state updated.",
      content: { "application/json": { schema: BrainSourceMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteBrainSourceRoute = createRoute({
  method: "delete",
  path: "/v1/brains/{brainId}/sources/{integrationId}",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, integrationId: ResourceIdSchema }),
  },
  responses: {
    200: {
      description: "Brain source removed, including an idempotent replay.",
      content: { "application/json": { schema: BrainSourceDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listBrainSourceOptionsRoute = createRoute({
  method: "post",
  path: "/v1/integrations/{integrationId}/brain-source-options",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ integrationId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: BrainSourceOptionsBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Provider resources the acting user may select for a Brain source.",
      content: { "application/json": { schema: BrainSourceOptionsEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const startBrainImportRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/imports",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "application/json": { schema: StartBrainImportBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Company-context import discovery started or replayed.",
      content: { "application/json": { schema: BrainImportRunCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const confirmBrainImportRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/imports/{importRunId}/confirm",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, importRunId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: ConfirmBrainImportBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Discovered import confirmed; ingestion begins for the enabled providers.",
      content: { "application/json": { schema: BrainImportRunCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const cancelBrainImportRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/imports/{importRunId}/cancel",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, importRunId: ResourceIdSchema }),
  },
  responses: {
    200: {
      description: "Active import canceled; queued ingestion jobs are skipped.",
      content: { "application/json": { schema: BrainImportRunCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const retryBrainImportRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/imports/{importRunId}/retry",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, importRunId: ResourceIdSchema }),
  },
  responses: {
    200: {
      description: "Failed pre-confirmation discovery reset and started again.",
      content: { "application/json": { schema: BrainImportRunCommandEnvelopeSchema } },
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

export const uploadBrainAssetRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/assets",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "multipart/form-data": { schema: BrainAssetUploadBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Private Brain asset uploaded and registered, or replayed.",
      content: { "application/json": { schema: BrainAssetMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const replaceBrainAssetRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/assets/{documentId}/replace",
  tags: ["Brain"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema, documentId: ResourceIdSchema }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "multipart/form-data": { schema: BrainAssetReplaceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Private Brain asset bytes replaced, or replayed.",
      content: { "application/json": { schema: BrainAssetMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const downloadBrainAssetRoute = createRoute({
  method: "get",
  path: "/v1/brain-assets/{documentId}",
  tags: ["Brain"],
  security: actorSecurity,
  request: { params: z.object({ documentId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Authorized private Brain asset bytes.",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
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
  path: "/v1/wiki/pages/{id}",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ id: ResourceIdSchema }),
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
  path: "/v1/wiki/pages/{id}/delete",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ id: ResourceIdSchema }),
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
  path: "/v1/wiki/pages/{id}/timeline",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ id: ResourceIdSchema }),
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

export const listWikiSourcesRoute = createRoute({
  method: "get",
  path: "/v1/wiki/sources",
  tags: ["Wiki"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Source configuration and connection state for the active workspace Wiki.",
      content: { "application/json": { schema: WikiSourceListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listWikiIngestActivityRoute = createRoute({
  method: "get",
  path: "/v1/wiki/sources/activity",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(1_024).optional(),
    }),
  },
  responses: {
    200: {
      description: "Recent ingestion outcomes for the active workspace Wiki.",
      content: { "application/json": { schema: WikiIngestActivityListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const upsertWikiSourceRoute = createRoute({
  method: "put",
  path: "/v1/wiki/sources",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpsertWikiSourceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "A Wiki source configured or updated for the active workspace.",
      content: { "application/json": { schema: WikiSourceMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setWikiSourceEnabledRoute = createRoute({
  method: "patch",
  path: "/v1/wiki/sources/{sourceId}",
  tags: ["Wiki"],
  security: actorSecurity,
  request: {
    params: z.object({ sourceId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetWikiSourceEnabledBodySchema } },
    },
  },
  responses: {
    200: {
      description: "A Wiki source enabled state updated for the active workspace.",
      content: { "application/json": { schema: WikiSourceMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteWikiSourceRoute = createRoute({
  method: "delete",
  path: "/v1/wiki/sources/{sourceId}",
  tags: ["Wiki"],
  security: actorSecurity,
  request: { params: z.object({ sourceId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "A Wiki source removed from the active workspace.",
      content: { "application/json": { schema: WikiSourceDeleteEnvelopeSchema } },
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

export const createWorkspaceSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkspaceSkillBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Workspace-authored Skill installed as an immutable standard bundle.",
      content: { "application/json": { schema: SkillImportEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const previewSkillImportRoute = createRoute({
  method: "post",
  path: "/v1/skills/imports/preview",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SkillImportPreviewBodySchema } },
    },
  },
  responses: {
    200: {
      description: "External Skill metadata and file sizes resolved for confirmation.",
      content: { "application/json": { schema: SkillImportPreviewEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const importSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills/imports",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: ImportSkillBodySchema } } },
  },
  responses: {
    201: {
      description: "Immutable Skill bundle installed or replayed after confirmation.",
      content: { "application/json": { schema: SkillImportEnvelopeSchema } },
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
      content: { "application/json": { schema: SkillInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateWorkspaceSkillRoute = createRoute({
  method: "patch",
  path: "/v1/skills/{slug}",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: WorkspaceSkillNameSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateWorkspaceSkillBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Workspace-authored Skill moved to a new immutable bundle version.",
      content: { "application/json": { schema: SkillInstallationEnvelopeSchema } },
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

export const enableSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills/{slug}/enable",
  tags: ["Skills"],
  security: actorSecurity,
  request: { params: z.object({ slug: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Skill installation enabled.",
      content: { "application/json": { schema: SkillInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const disableSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills/{slug}/disable",
  tags: ["Skills"],
  security: actorSecurity,
  request: { params: z.object({ slug: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Skill installation disabled.",
      content: { "application/json": { schema: SkillInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const replaceSkillRoute = createRoute({
  method: "post",
  path: "/v1/skills/{slug}/replace",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: ImportSkillBodySchema } } },
  },
  responses: {
    200: {
      description: "Skill installation moved to a newly verified immutable bundle.",
      content: { "application/json": { schema: SkillInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const readSkillFileRoute = createRoute({
  method: "get",
  path: "/v1/skills/{slug}/files/read",
  tags: ["Skills"],
  security: actorSecurity,
  request: {
    params: z.object({ slug: ResourceIdSchema }),
    query: z.object({
      path: z.string().min(1).max(1_024),
      offset: z.coerce.number().int().min(0).optional(),
      maxBytes: z.coerce
        .number()
        .int()
        .min(4)
        .max(64 * 1_024)
        .optional(),
    }),
  },
  responses: {
    200: {
      description: "One bounded chunk of an authorized Skill bundle file.",
      content: { "application/json": { schema: SkillFileChunkEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listPluginsRoute = createRoute({
  method: "get",
  path: "/v1/plugins",
  tags: ["Plugins"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Live immutable Plugin packages in the active workspace.",
      content: { "application/json": { schema: PluginListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const previewPluginImportRoute = createRoute({
  method: "post",
  path: "/v1/plugins/imports/preview",
  tags: ["Plugins"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PluginImportPreviewBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Plugin metadata, components, validation report, and file sizes.",
      content: { "application/json": { schema: PluginImportPreviewEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const importPluginRoute = createRoute({
  method: "post",
  path: "/v1/plugins/imports",
  tags: ["Plugins"],
  security: actorSecurity,
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
    body: { required: true, content: { "application/json": { schema: InstallPluginBodySchema } } },
  },
  responses: {
    201: {
      description: "Immutable Plugin package installed or replayed after confirmation.",
      content: { "application/json": { schema: PluginImportEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getPluginRoute = createRoute({
  method: "get",
  path: "/v1/plugins/{name}",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Plugin package detail with passive Skills and executable MCP declarations.",
      content: { "application/json": { schema: PluginInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const archivePluginRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/archive",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Plugin archived without deleting its immutable package.",
      content: { "application/json": { schema: PluginArchiveEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const enablePluginRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/enable",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Plugin enabled for Skill resolution.",
      content: { "application/json": { schema: PluginInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const disablePluginRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/disable",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Plugin disabled for Skill resolution.",
      content: { "application/json": { schema: PluginInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const approvePluginMcpRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/mcp/approve",
  tags: ["Plugins"],
  security: actorSecurity,
  request: {
    params: z.object({ name: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: ApprovePluginMcpBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Plugin MCP approved for the exact installed package integrity.",
      content: { "application/json": { schema: PluginInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const revokePluginMcpRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/mcp/revoke",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Plugin MCP approval revoked.",
      content: { "application/json": { schema: PluginInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const refreshPluginMcpRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/mcp/refresh",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Plugin remote MCP discovery snapshot refreshed from the connected provider.",
      content: { "application/json": { schema: PluginInstallationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deletePluginDataRoute = createRoute({
  method: "post",
  path: "/v1/plugins/{name}/data/delete",
  tags: ["Plugins"],
  security: actorSecurity,
  request: { params: z.object({ name: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Persistent data metadata deleted as an explicit destructive action.",
      content: { "application/json": { schema: PluginDataDeleteEnvelopeSchema } },
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

export const getConversationShareRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{conversationId}/share",
  tags: ["Chat"],
  security: actorSecurity,
  request: { params: z.object({ conversationId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Current public share capability for an authorized Conversation.",
      content: { "application/json": { schema: ConversationShareEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createConversationShareRoute = createRoute({
  method: "put",
  path: "/v1/conversations/{conversationId}/share",
  tags: ["Chat"],
  security: actorSecurity,
  request: { params: z.object({ conversationId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Idempotently create or return a Conversation public share capability.",
      content: { "application/json": { schema: ConversationShareEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteConversationShareRoute = createRoute({
  method: "delete",
  path: "/v1/conversations/{conversationId}/share",
  tags: ["Chat"],
  security: actorSecurity,
  request: { params: z.object({ conversationId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Idempotently revoke a Conversation public share capability.",
      content: { "application/json": { schema: ConversationShareEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const generateConversationTitleRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{conversationId}/title",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    params: z.object({ conversationId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: GenerateConversationTitleBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Generate a title when the Message is the Conversation's first user Message.",
      content: { "application/json": { schema: GenerateConversationTitleEnvelopeSchema } },
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
    headers: z.object({
      "idempotency-key": z.string().min(1).max(200),
      [PROTOCOL_VERSION_HEADER]: z.literal(PROTOCOL_VERSION),
    }),
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

const binaryResponse = {
  description: "Authorized private bytes.",
  content: {
    "application/octet-stream": {
      schema: z.string().openapi({ type: "string", format: "binary" }),
    },
  },
} as const;

export const deleteChatArtifactRoute = createRoute({
  method: "delete",
  path: "/v1/chat-artifacts/{artifactId}",
  tags: ["Chat"],
  security: actorSecurity,
  request: { params: z.object({ artifactId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Generated Chat artifact tombstoned and its private blobs removed.",
      content: { "application/json": { schema: ChatArtifactDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const downloadChatArtifactRoute = createRoute({
  method: "get",
  path: "/v1/chat-artifacts/{artifactId}/versions/{versionId}",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    params: z.object({ artifactId: ResourceIdSchema, versionId: ResourceIdSchema }),
    query: z.object({ download: z.enum(["0", "1"]).optional() }),
  },
  responses: { 200: binaryResponse, default: errorResponse },
});

export const downloadChatAttachmentRoute = createRoute({
  method: "get",
  path: "/v1/chat-attachments/{messageId}/{attachmentId}",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    params: z.object({ messageId: ResourceIdSchema, attachmentId: ResourceIdSchema }),
  },
  responses: { 200: binaryResponse, default: errorResponse },
});

export const downloadChatScreenshotRoute = createRoute({
  method: "get",
  path: "/v1/chat-screenshots/{conversationId}/{filename}",
  tags: ["Chat"],
  security: actorSecurity,
  request: {
    params: z.object({
      conversationId: ResourceIdSchema,
      filename: z.string().min(1).max(512),
    }),
  },
  responses: { 200: binaryResponse, default: errorResponse },
});

export const getPublicChatShareRoute = createRoute({
  method: "get",
  path: "/public/chat-shares/{shareId}",
  tags: ["Public Chat shares"],
  request: { params: z.object({ shareId: ChatShareIdSchema }) },
  responses: {
    200: {
      description:
        "Read-only public presentation transcript addressed by an unguessable share capability.",
      content: { "application/json": { schema: PublicChatShareEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getPublicChatShareMetadataRoute = createRoute({
  method: "get",
  path: "/public/chat-shares/{shareId}/metadata",
  tags: ["Public Chat shares"],
  request: { params: z.object({ shareId: ChatShareIdSchema }) },
  responses: {
    200: {
      description: "Public metadata for share page and Open Graph presentation.",
      content: { "application/json": { schema: PublicChatShareMetadataEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const downloadPublicChatAttachmentRoute = createRoute({
  method: "get",
  path: "/public/chat-shares/{shareId}/attachments/{messageId}/{attachmentId}",
  tags: ["Public Chat shares"],
  request: {
    params: z.object({
      shareId: ChatShareIdSchema,
      messageId: ResourceIdSchema,
      attachmentId: ResourceIdSchema,
    }),
  },
  responses: { 200: binaryResponse, default: errorResponse },
});

export const downloadPublicChatArtifactRoute = createRoute({
  method: "get",
  path: "/public/chat-shares/{shareId}/artifacts/{artifactId}/versions/{versionId}",
  tags: ["Public Chat shares"],
  request: {
    params: z.object({
      shareId: ChatShareIdSchema,
      artifactId: ResourceIdSchema,
      versionId: ResourceIdSchema,
    }),
    query: z.object({ download: z.enum(["0", "1"]).optional() }),
  },
  responses: { 200: binaryResponse, default: errorResponse },
});

export const getEngineRuntimeStatusRoute = createRoute({
  method: "get",
  path: "/v1/conversations/{conversationId}/engine-session/runtime",
  tags: ["Engine sessions"],
  security: actorSecurity,
  request: { params: z.object({ conversationId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Qualified runtime status for a coding-engine Conversation.",
      content: { "application/json": { schema: EngineRuntimeStatusEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createEngineRuntimeAccessRoute = createRoute({
  method: "post",
  path: "/v1/conversations/{conversationId}/engine-session/runtime-access",
  tags: ["Engine sessions"],
  security: actorSecurity,
  request: { params: z.object({ conversationId: ResourceIdSchema }) },
  responses: {
    201: {
      description: "Short-lived access to the Conversation's coding workspace runtime.",
      content: { "application/json": { schema: EngineRuntimeAccessEnvelopeSchema } },
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

export const listBrowserProfilesRoute = createRoute({
  method: "get",
  path: "/v1/browser-profiles",
  tags: ["BrowserProfiles"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Browser profiles owned by the acting user.",
      content: { "application/json": { schema: BrowserProfileListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBrowserProfileRoute = createRoute({
  method: "post",
  path: "/v1/browser-profiles",
  tags: ["BrowserProfiles"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateBrowserProfileBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Browser profile created for the acting user.",
      content: { "application/json": { schema: BrowserProfileEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteBrowserProfileRoute = createRoute({
  method: "delete",
  path: "/v1/browser-profiles/{profileId}",
  tags: ["BrowserProfiles"],
  security: actorSecurity,
  request: { params: z.object({ profileId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Browser profile and its remote browser context deleted.",
      content: { "application/json": { schema: BrowserProfileDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBrowserProfileLoginSessionRoute = createRoute({
  method: "post",
  path: "/v1/browser-profiles/{profileId}/login-sessions",
  tags: ["BrowserProfiles"],
  security: actorSecurity,
  request: { params: z.object({ profileId: ResourceIdSchema }) },
  responses: {
    201: {
      description: "Interactive login session started for an owned browser profile.",
      content: { "application/json": { schema: BrowserProfileLoginSessionEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const completeBrowserProfileLoginRoute = createRoute({
  method: "post",
  path: "/v1/browser-profiles/{profileId}/login-sessions/{sessionId}/complete",
  tags: ["BrowserProfiles"],
  security: actorSecurity,
  request: {
    params: z.object({
      profileId: ResourceIdSchema,
      sessionId: z.string().min(1).max(256),
    }),
  },
  responses: {
    200: {
      description: "Login session completed; the browser profile is connected.",
      content: { "application/json": { schema: BrowserProfileLoginCompleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBrowserProfileLiveViewRoute = createRoute({
  method: "get",
  path: "/v1/browser-profiles/{profileId}/live-view",
  tags: ["BrowserProfiles"],
  security: actorSecurity,
  request: {
    params: z.object({ profileId: ResourceIdSchema }),
    query: z.object({ sessionId: z.string().min(1).max(256) }),
  },
  responses: {
    200: {
      description: "Live-view URL for an active session of an owned browser profile.",
      content: { "application/json": { schema: BrowserProfileLiveViewEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getWorkspaceCapabilitiesRoute = createRoute({
  method: "get",
  path: "/v1/capabilities",
  tags: ["Capabilities"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Workspace managed-capability settings and the per-chat spending budget.",
      content: { "application/json": { schema: WorkspaceCapabilitySettingsEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setCapabilitySessionBudgetRoute = createRoute({
  method: "put",
  path: "/v1/capabilities/session-budget",
  tags: ["Capabilities"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SetCapabilitySessionBudgetBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Workspace per-chat capability spending budget updated. Admin only.",
      content: { "application/json": { schema: CapabilitySessionBudgetEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setWorkspaceCapabilityRoute = createRoute({
  method: "put",
  path: "/v1/capabilities/{source}",
  tags: ["Capabilities"],
  security: actorSecurity,
  request: {
    params: z.object({ source: ManagedCapabilitySourceSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetWorkspaceCapabilityBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Workspace managed capability updated. Admin only.",
      content: { "application/json": { schema: WorkspaceCapabilityMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getCapabilityApprovalByToolCallRoute = createRoute({
  method: "get",
  path: "/v1/capability-approvals/by-tool-call/{toolCallId}",
  tags: ["Capabilities"],
  security: actorSecurity,
  request: { params: z.object({ toolCallId: ResourceIdSchema }) },
  responses: {
    200: {
      description:
        "Latest approval visible to the actor for a tool call, including session budget.",
      content: { "application/json": { schema: CapabilityApprovalEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getCapabilityApprovalRoute = createRoute({
  method: "get",
  path: "/v1/capability-approvals/{runId}",
  tags: ["Capabilities"],
  security: actorSecurity,
  request: { params: z.object({ runId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Capability approval visible to the acting user in the active workspace.",
      content: { "application/json": { schema: CapabilityApprovalEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBrainRoute = createRoute({
  method: "post",
  path: "/v1/brains",
  tags: ["Brains"],
  security: actorSecurity,
  request: {
    body: { required: true, content: { "application/json": { schema: CreateBrainBodySchema } } },
  },
  responses: {
    201: {
      description: "Brain created in the active workspace. Admin only.",
      content: { "application/json": { schema: BrainControlMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const switchBrainRoute = createRoute({
  method: "post",
  path: "/v1/brains/{brainId}/switch",
  tags: ["Brains"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Brain access authorized for the active workspace; clients may activate it.",
      content: { "application/json": { schema: BrainControlMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBrainAccessRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/access",
  tags: ["Brains"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Brain visibility, selected members, and workspace member choices. Admin only.",
      content: { "application/json": { schema: BrainAccessEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setBrainAccessRoute = createRoute({
  method: "put",
  path: "/v1/brains/{brainId}/access",
  tags: ["Brains"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: { required: true, content: { "application/json": { schema: SetBrainAccessBodySchema } } },
  },
  responses: {
    200: {
      description: "Brain visibility and restricted member set updated. Admin only.",
      content: { "application/json": { schema: BrainAccessMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBrainEnrichmentRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/enrichment",
  tags: ["Brains"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Brain enrichment setting. Admin only.",
      content: { "application/json": { schema: BrainEnrichmentEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setBrainEnrichmentRoute = createRoute({
  method: "put",
  path: "/v1/brains/{brainId}/enrichment",
  tags: ["Brains"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetBrainEnrichmentBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Brain enrichment setting updated. Admin only.",
      content: { "application/json": { schema: BrainEnrichmentEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBrainIntelligenceRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/intelligence",
  tags: ["Brains"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Brain intelligence tier. Admin only.",
      content: { "application/json": { schema: BrainIntelligenceEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setBrainIntelligenceRoute = createRoute({
  method: "put",
  path: "/v1/brains/{brainId}/intelligence",
  tags: ["Brains"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetBrainIntelligenceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Brain intelligence tier updated. Admin only.",
      content: { "application/json": { schema: BrainIntelligenceEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getIdentityRoute = createRoute({
  method: "get",
  path: "/v1/identity",
  tags: ["Identity"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Authenticated identity, accessible workspaces, and the selected workspace Brain list.",
      content: { "application/json": { schema: IdentityEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const syncIdentityRoute = createRoute({
  method: "post",
  path: "/v1/identity/sync",
  tags: ["Identity"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Authenticated identity profile and accepted organization memberships synchronized, then resolved.",
      content: { "application/json": { schema: IdentityEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getWorkspaceSettingsRoute = createRoute({
  method: "get",
  path: "/v1/workspace",
  tags: ["Workspaces"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Active workspace settings, members, plan, and pending invitations.",
      content: { "application/json": { schema: WorkspaceSettingsEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const renameWorkspaceRoute = createRoute({
  method: "patch",
  path: "/v1/workspace",
  tags: ["Workspaces"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RenameWorkspaceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Active workspace and its identity organization renamed. Admin only.",
      content: { "application/json": { schema: WorkspaceRenameEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const inviteWorkspaceMemberRoute = createRoute({
  method: "post",
  path: "/v1/workspace/invitations",
  tags: ["Workspaces"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: InviteWorkspaceMemberBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Invitation sent within the active workspace member cap. Admin only.",
      content: { "application/json": { schema: WorkspaceCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const revokeWorkspaceInvitationRoute = createRoute({
  method: "delete",
  path: "/v1/workspace/invitations/{invitationId}",
  tags: ["Workspaces"],
  security: actorSecurity,
  request: { params: z.object({ invitationId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Pending invitation in the active identity organization revoked. Admin only.",
      content: { "application/json": { schema: WorkspaceCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const removeWorkspaceMemberRoute = createRoute({
  method: "delete",
  path: "/v1/workspace/members/{userId}",
  tags: ["Workspaces"],
  security: actorSecurity,
  request: { params: z.object({ userId: ResourceIdSchema }) },
  responses: {
    200: {
      description:
        "Member removed from the active workspace and identity organization. Admin only.",
      content: { "application/json": { schema: WorkspaceCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/v1/workspaces",
  tags: ["Workspaces"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkspaceBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Workspace provisioned idempotently by workspace id.",
      content: { "application/json": { schema: WorkspaceActivationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const switchWorkspaceRoute = createRoute({
  method: "post",
  path: "/v1/workspaces/{workspaceId}/switch",
  tags: ["Workspaces"],
  security: actorSecurity,
  request: { params: z.object({ workspaceId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Workspace membership authorized and browser activation resources returned.",
      content: { "application/json": { schema: WorkspaceActivationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getOnboardingStateRoute = createRoute({
  method: "get",
  path: "/v1/onboarding",
  tags: ["Onboarding"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Authenticated onboarding state without requiring onboarding completion.",
      content: { "application/json": { schema: OnboardingStateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const checkOnboardingWorkspaceSlugRoute = createRoute({
  method: "post",
  path: "/v1/onboarding/workspace-slug/check",
  tags: ["Onboarding"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CheckOnboardingWorkspaceSlugBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Normalized workspace slug availability for the authenticated identity.",
      content: { "application/json": { schema: OnboardingWorkspaceSlugEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const saveOnboardingProfileRoute = createRoute({
  method: "put",
  path: "/v1/onboarding/profile",
  tags: ["Onboarding"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SaveOnboardingProfileBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Authenticated identity onboarding profile saved.",
      content: { "application/json": { schema: OnboardingCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const saveOnboardingWorkspaceRoute = createRoute({
  method: "put",
  path: "/v1/onboarding/workspace",
  tags: ["Onboarding"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SaveOnboardingWorkspaceBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Onboarding workspace saved or provisioned for the authenticated identity.",
      content: { "application/json": { schema: OnboardingWorkspaceEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const finishOnboardingRoute = createRoute({
  method: "post",
  path: "/v1/onboarding/complete",
  tags: ["Onboarding"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: FinishOnboardingBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Onboarding completed for an identity with an accessible workspace.",
      content: { "application/json": { schema: OnboardingCommandEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateUserPreferencesRoute = createRoute({
  method: "patch",
  path: "/v1/me/preferences",
  tags: ["Settings"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpdateUserPreferencesBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The acting user's preference set after applying the partial update.",
      content: { "application/json": { schema: UserPreferencesEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getMcpSetupRoute = createRoute({
  method: "get",
  path: "/v1/me/mcp-setup",
  tags: ["Settings"],
  security: actorSecurity,
  responses: {
    200: {
      description: "The acting user's MCP client preference and setup completion state.",
      content: { "application/json": { schema: McpSetupEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateMcpSetupRoute = createRoute({
  method: "patch",
  path: "/v1/me/mcp-setup",
  tags: ["Settings"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpdateMcpSetupBodySchema } },
    },
  },
  responses: {
    200: {
      description: "MCP client preference saved.",
      content: { "application/json": { schema: McpSetupEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const submitFeedbackRoute = createRoute({
  method: "post",
  path: "/v1/feedback",
  tags: ["Feedback"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SubmitFeedbackBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Feedback delivered to the product team.",
      content: { "application/json": { schema: FeedbackSubmissionEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listRepoConfigsRoute = createRoute({
  method: "get",
  path: "/v1/repo-configs",
  tags: ["Settings"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Workspace GitHub repositories and their saved configurations. Env values are never returned; only key names.",
      content: { "application/json": { schema: RepoConfigListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setRepoConfigEnvRoute = createRoute({
  method: "put",
  path: "/v1/repo-configs/{repositoryExternalId}/env",
  tags: ["Settings"],
  security: actorSecurity,
  request: {
    params: z.object({ repositoryExternalId: RepositoryExternalIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetRepoConfigEnvBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Repository env file replaced or cleared. Admin only.",
      content: { "application/json": { schema: RepoConfigMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setRepoConfigSetupRoute = createRoute({
  method: "put",
  path: "/v1/repo-configs/{repositoryExternalId}/setup",
  tags: ["Settings"],
  security: actorSecurity,
  request: {
    params: z.object({ repositoryExternalId: RepositoryExternalIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetRepoConfigSetupBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Repository setup instructions saved. Admin only.",
      content: { "application/json": { schema: RepoConfigMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteRepoConfigRoute = createRoute({
  method: "delete",
  path: "/v1/repo-configs/{repositoryExternalId}",
  tags: ["Settings"],
  security: actorSecurity,
  request: { params: z.object({ repositoryExternalId: RepositoryExternalIdSchema }) },
  responses: {
    200: {
      description: "Repository configuration removed. Admin only.",
      content: { "application/json": { schema: RepoConfigDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

// Provider account commands (#1203 5a2). Static provider paths are registered
// before the generic {integrationId} routes so they always win route matching.

export const connectAttioAccountRoute = createRoute({
  method: "put",
  path: "/v1/integration-accounts/attio",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: IntegrationApiKeyBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Attio connected (or reconnected) for the acting user, including the Attio-side webhook registration. The key never appears in the response.",
      content: { "application/json": { schema: AttioAccountStateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const disconnectAttioAccountRoute = createRoute({
  method: "delete",
  path: "/v1/integration-accounts/attio/{integrationId}",
  tags: ["Integrations"],
  security: actorSecurity,
  request: { params: z.object({ integrationId: IntegrationAccountIdSchema }) },
  responses: {
    200: {
      description:
        "Attio connection removed. The Attio-side webhook is deleted best-effort before the account disconnect.",
      content: { "application/json": { schema: IntegrationAccountDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const connectFathomAccountRoute = createRoute({
  method: "put",
  path: "/v1/integration-accounts/fathom",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: IntegrationApiKeyBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Fathom connected for the acting user.",
      content: { "application/json": { schema: FathomAccountStateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const connectGranolaAccountRoute = createRoute({
  method: "put",
  path: "/v1/integration-accounts/granola",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: IntegrationApiKeyBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Granola connected for the acting user.",
      content: { "application/json": { schema: GranolaAccountStateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const startImessagePairingRoute = createRoute({
  method: "post",
  path: "/v1/integration-accounts/imessage/pairing",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: StartImessagePairingBodySchema } },
    },
  },
  responses: {
    200: {
      description: "A verification code was sent to the provided phone number.",
      content: { "application/json": { schema: ImessagePairingStartedEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const confirmImessagePairingRoute = createRoute({
  method: "post",
  path: "/v1/integration-accounts/imessage/pairing/confirm",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ConfirmImessagePairingBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Pairing confirmed; the iMessage connection is active.",
      content: { "application/json": { schema: ImessageAccountStateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const connectStripeAccountRoute = createRoute({
  method: "put",
  path: "/v1/integration-accounts/stripe",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: IntegrationApiKeyBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Workspace Stripe connection saved from a restricted key. Admin only; the key never appears in the response.",
      content: { "application/json": { schema: StripeAccountStateEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const disconnectStripeAccountRoute = createRoute({
  method: "delete",
  path: "/v1/integration-accounts/stripe",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Workspace Stripe connection removed. Admin only.",
      content: { "application/json": { schema: StripeAccountDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createJamieWebhookEndpointRoute = createRoute({
  method: "post",
  path: "/v1/integration-accounts/jamie/webhook-endpoint",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Jamie webhook endpoint created or reset for the workspace. Admin only. Any previously saved API key binding is cleared.",
      content: { "application/json": { schema: JamieWebhookSetupEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const saveJamieApiKeyRoute = createRoute({
  method: "put",
  path: "/v1/integration-accounts/jamie/api-key",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: IntegrationApiKeyBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Jamie webhook API key bound to the workspace endpoint. Admin only; only a hash is stored and the key never appears in the response.",
      content: { "application/json": { schema: JamieWebhookSetupEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getIntegrationAccountUsageRoute = createRoute({
  method: "get",
  path: "/v1/integration-accounts/{integrationId}/usage",
  tags: ["Integrations"],
  security: actorSecurity,
  request: { params: z.object({ integrationId: IntegrationAccountIdSchema }) },
  responses: {
    200: {
      description:
        "Pre-disconnect usage so the UI can warn before removing an account that still feeds brains. Owner only.",
      content: { "application/json": { schema: IntegrationAccountUsageEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listIntegrationAccountsRoute = createRoute({
  method: "get",
  path: "/v1/integration-accounts",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Credential-free personal integration accounts owned by the authenticated user.",
      content: { "application/json": { schema: IntegrationAccountListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getSlackBotWorkspaceSettingsRoute = createRoute({
  method: "get",
  path: "/v1/workspace/slack-bot",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Credential-free Slack answer-bot status for the active workspace.",
      content: { "application/json": { schema: SlackBotWorkspaceSettingsEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const disconnectSlackBotRoute = createRoute({
  method: "delete",
  path: "/v1/workspace/slack-bot",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Workspace Slack answer-bot disconnected by an administrator.",
      content: { "application/json": { schema: SlackBotMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getSlackBotDestinationRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/slack-bot",
  tags: ["Integrations"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Authorized Slack answer-bot destination settings for one Brain.",
      content: { "application/json": { schema: SlackBotDestinationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setSlackBotDestinationRoute = createRoute({
  method: "put",
  path: "/v1/brains/{brainId}/slack-bot",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    params: z.object({ brainId: ResourceIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: SetSlackBotDestinationBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Slack answer-bot channel scope saved by a workspace administrator.",
      content: { "application/json": { schema: SlackBotMutationEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const listSlackBotChannelsRoute = createRoute({
  method: "get",
  path: "/v1/brains/{brainId}/slack-bot/channels",
  tags: ["Integrations"],
  security: actorSecurity,
  request: { params: z.object({ brainId: ResourceIdSchema }) },
  responses: {
    200: {
      description: "Channels visible to the workspace Slack bot; administrator only.",
      content: { "application/json": { schema: SlackBotChannelListEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const setIntegrationCapabilityModeRoute = createRoute({
  method: "put",
  path: "/v1/integration-accounts/{integrationId}/capability-modes/{capabilityId}",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    params: z.object({
      integrationId: IntegrationAccountIdSchema,
      capabilityId: z.string().min(1).max(64),
    }),
    body: {
      required: true,
      content: { "application/json": { schema: SetIntegrationCapabilityModeBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Capability mode override saved for the connection. Owner only.",
      content: { "application/json": { schema: IntegrationCapabilityModeEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const alwaysAllowActionRoute = createRoute({
  method: "post",
  path: "/v1/actions/{actionId}/permissions/always-allow",
  tags: ["Approvals"],
  security: actorSecurity,
  request: { params: z.object({ actionId: z.string().min(1).max(255) }) },
  responses: {
    200: {
      description:
        "Persist the standing permission represented by an action approval. The action catalog is re-resolved for the authenticated actor and workspace.",
      content: { "application/json": { schema: ActionPermissionEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteIntegrationAccountRoute = createRoute({
  method: "delete",
  path: "/v1/integration-accounts/{integrationId}",
  tags: ["Integrations"],
  security: actorSecurity,
  request: { params: z.object({ integrationId: IntegrationAccountIdSchema }) },
  responses: {
    200: {
      description:
        "Personal integration account hard-deleted. Owner only. Credentials, synced resources, brain sources, and buffered events cascade away; already-ingested brain content stays.",
      content: { "application/json": { schema: IntegrationAccountDeleteEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

// Engine + secrets-manager auth commands (#1203 5a3). Static paths only, apart
// from the flow-id continuation routes, which register after their static
// siblings so e.g. POST /codex/device never captures "device" as a flow id.

export const getClaudeCodeAuthRoute = createRoute({
  method: "get",
  path: "/v1/engine-auth/claude-code",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Claude Code token connection status for the acting user. Never includes the stored token.",
      content: { "application/json": { schema: ClaudeCodeAuthStatusEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const saveClaudeCodeTokenRoute = createRoute({
  method: "put",
  path: "/v1/engine-auth/claude-code",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SaveClaudeCodeTokenBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Claude Code setup token validated and stored encrypted for the acting user. The token never appears in the response.",
      content: { "application/json": { schema: ClaudeCodeAuthStatusEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteClaudeCodeAuthRoute = createRoute({
  method: "delete",
  path: "/v1/engine-auth/claude-code",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Claude Code token connection removed for the acting user.",
      content: { "application/json": { schema: EngineAuthDisconnectEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getCodexAuthRoute = createRoute({
  method: "get",
  path: "/v1/engine-auth/codex",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Codex connection status for the acting user. Never includes stored credentials.",
      content: { "application/json": { schema: CodexAuthStatusEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const startCodexDeviceAuthRoute = createRoute({
  method: "post",
  path: "/v1/engine-auth/codex/device",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    201: {
      description:
        "Codex device authorization flow started via the runner control plane; returns the user code and verification link.",
      content: { "application/json": { schema: CodexDeviceAuthFlowEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const pollCodexDeviceAuthRoute = createRoute({
  method: "post",
  path: "/v1/engine-auth/codex/device/{flowId}/poll",
  tags: ["Integrations"],
  security: actorSecurity,
  request: { params: z.object({ flowId: EngineAuthFlowIdSchema }) },
  responses: {
    200: {
      description: "Current state of a Codex device authorization flow.",
      content: { "application/json": { schema: CodexDeviceAuthFlowEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteCodexAuthRoute = createRoute({
  method: "delete",
  path: "/v1/engine-auth/codex",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Codex connection removed for the acting user.",
      content: { "application/json": { schema: EngineAuthDisconnectEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getInfisicalAuthRoute = createRoute({
  method: "get",
  path: "/v1/engine-auth/infisical",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description:
        "Workspace Infisical connection status. Member-visible; never includes the stored auth bundle.",
      content: { "application/json": { schema: InfisicalAuthStatusEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const startInfisicalAuthRoute = createRoute({
  method: "post",
  path: "/v1/engine-auth/infisical/start",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: StartInfisicalAuthBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Infisical browser-login flow started via the runner control plane. Admin only.",
      content: { "application/json": { schema: InfisicalAuthFlowEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const completeInfisicalAuthRoute = createRoute({
  method: "post",
  path: "/v1/engine-auth/infisical/{flowId}/complete",
  tags: ["Integrations"],
  security: actorSecurity,
  request: {
    params: z.object({ flowId: EngineAuthFlowIdSchema }),
    body: {
      required: true,
      content: { "application/json": { schema: CompleteInfisicalAuthBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Infisical browser token submitted to the runner to finish the flow. Admin only; the token never appears in the response.",
      content: { "application/json": { schema: InfisicalAuthFlowEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const deleteInfisicalAuthRoute = createRoute({
  method: "delete",
  path: "/v1/engine-auth/infisical",
  tags: ["Integrations"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Workspace Infisical connection disconnected. Admin only.",
      content: { "application/json": { schema: EngineAuthDisconnectEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBillingOverviewRoute = createRoute({
  method: "get",
  path: "/v1/billing",
  tags: ["Billing"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Authorized workspace billing overview.",
      content: { "application/json": { schema: BillingOverviewEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBillingUsageRoute = createRoute({
  method: "get",
  path: "/v1/billing/usage",
  tags: ["Billing"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Authorized workspace usage read model.",
      content: { "application/json": { schema: BillingUsageEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const getBillingBalanceRoute = createRoute({
  method: "get",
  path: "/v1/billing/balance",
  tags: ["Billing"],
  security: actorSecurity,
  responses: {
    200: {
      description: "Authorized workspace credit balance.",
      content: { "application/json": { schema: BillingBalanceEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

const billingCommandHeaders = z.object({ "idempotency-key": z.string().min(1).max(200) });

export const createBillingTopUpRoute = createRoute({
  method: "post",
  path: "/v1/billing/top-ups",
  tags: ["Billing"],
  security: actorSecurity,
  request: {
    headers: billingCommandHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: CreateBillingTopUpBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Idempotent Stripe credit top-up Checkout session created.",
      content: { "application/json": { schema: BillingRedirectEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBillingSubscriptionCheckoutRoute = createRoute({
  method: "post",
  path: "/v1/billing/subscription-checkouts",
  tags: ["Billing"],
  security: actorSecurity,
  request: { headers: billingCommandHeaders },
  responses: {
    201: {
      description: "Idempotent Stripe Pro subscription Checkout session created.",
      content: { "application/json": { schema: BillingRedirectEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const createBillingPortalSessionRoute = createRoute({
  method: "post",
  path: "/v1/billing/portal-sessions",
  tags: ["Billing"],
  security: actorSecurity,
  request: { headers: billingCommandHeaders },
  responses: {
    201: {
      description: "Idempotent Stripe billing portal session created.",
      content: { "application/json": { schema: BillingRedirectEnvelopeSchema } },
    },
    default: errorResponse,
  },
});

export const updateBillingAutoRefillRoute = createRoute({
  method: "put",
  path: "/v1/billing/auto-refill",
  tags: ["Billing"],
  security: actorSecurity,
  request: {
    headers: billingCommandHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateBillingAutoRefillBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Workspace auto-refill configuration updated idempotently.",
      content: { "application/json": { schema: BillingAutoRefillEnvelopeSchema } },
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
  listBrainSourceItems: RouteHandler<typeof listBrainSourceItemsRoute>;
  listBrainSources: RouteHandler<typeof listBrainSourcesRoute>;
  setBrainSource: RouteHandler<typeof setBrainSourceRoute>;
  deleteBrainSource: RouteHandler<typeof deleteBrainSourceRoute>;
  listBrowserProfiles: RouteHandler<typeof listBrowserProfilesRoute>;
  createBrowserProfile: RouteHandler<typeof createBrowserProfileRoute>;
  deleteBrowserProfile: RouteHandler<typeof deleteBrowserProfileRoute>;
  createBrowserProfileLoginSession: RouteHandler<typeof createBrowserProfileLoginSessionRoute>;
  completeBrowserProfileLogin: RouteHandler<typeof completeBrowserProfileLoginRoute>;
  getBrowserProfileLiveView: RouteHandler<typeof getBrowserProfileLiveViewRoute>;
  getWorkspaceCapabilities: RouteHandler<typeof getWorkspaceCapabilitiesRoute>;
  setCapabilitySessionBudget: RouteHandler<typeof setCapabilitySessionBudgetRoute>;
  setWorkspaceCapability: RouteHandler<typeof setWorkspaceCapabilityRoute>;
  getCapabilityApprovalByToolCall: RouteHandler<typeof getCapabilityApprovalByToolCallRoute>;
  getCapabilityApproval: RouteHandler<typeof getCapabilityApprovalRoute>;
  createBrain: RouteHandler<typeof createBrainRoute>;
  switchBrain: RouteHandler<typeof switchBrainRoute>;
  getBrainAccess: RouteHandler<typeof getBrainAccessRoute>;
  setBrainAccess: RouteHandler<typeof setBrainAccessRoute>;
  getBrainEnrichment: RouteHandler<typeof getBrainEnrichmentRoute>;
  setBrainEnrichment: RouteHandler<typeof setBrainEnrichmentRoute>;
  getBrainIntelligence: RouteHandler<typeof getBrainIntelligenceRoute>;
  setBrainIntelligence: RouteHandler<typeof setBrainIntelligenceRoute>;
  getIdentity: RouteHandler<typeof getIdentityRoute>;
  syncIdentity: RouteHandler<typeof syncIdentityRoute>;
  getWorkspaceSettings: RouteHandler<typeof getWorkspaceSettingsRoute>;
  renameWorkspace: RouteHandler<typeof renameWorkspaceRoute>;
  inviteWorkspaceMember: RouteHandler<typeof inviteWorkspaceMemberRoute>;
  revokeWorkspaceInvitation: RouteHandler<typeof revokeWorkspaceInvitationRoute>;
  removeWorkspaceMember: RouteHandler<typeof removeWorkspaceMemberRoute>;
  createWorkspace: RouteHandler<typeof createWorkspaceRoute>;
  switchWorkspace: RouteHandler<typeof switchWorkspaceRoute>;
  getOnboardingState: RouteHandler<typeof getOnboardingStateRoute>;
  checkOnboardingWorkspaceSlug: RouteHandler<typeof checkOnboardingWorkspaceSlugRoute>;
  saveOnboardingProfile: RouteHandler<typeof saveOnboardingProfileRoute>;
  saveOnboardingWorkspace: RouteHandler<typeof saveOnboardingWorkspaceRoute>;
  finishOnboarding: RouteHandler<typeof finishOnboardingRoute>;
  listBrainSourceOptions: RouteHandler<typeof listBrainSourceOptionsRoute>;
  startBrainImport: RouteHandler<typeof startBrainImportRoute>;
  confirmBrainImport: RouteHandler<typeof confirmBrainImportRoute>;
  cancelBrainImport: RouteHandler<typeof cancelBrainImportRoute>;
  retryBrainImport: RouteHandler<typeof retryBrainImportRoute>;
  createBrainDocument: RouteHandler<typeof createBrainDocumentRoute>;
  uploadBrainAsset: RouteHandler<typeof uploadBrainAssetRoute>;
  replaceBrainAsset: RouteHandler<typeof replaceBrainAssetRoute>;
  downloadBrainAsset: RouteHandler<typeof downloadBrainAssetRoute>;
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
  listWikiSources: RouteHandler<typeof listWikiSourcesRoute>;
  listWikiIngestActivity: RouteHandler<typeof listWikiIngestActivityRoute>;
  upsertWikiSource: RouteHandler<typeof upsertWikiSourceRoute>;
  setWikiSourceEnabled: RouteHandler<typeof setWikiSourceEnabledRoute>;
  deleteWikiSource: RouteHandler<typeof deleteWikiSourceRoute>;
  listSkills: RouteHandler<typeof listSkillsRoute>;
  createWorkspaceSkill: RouteHandler<typeof createWorkspaceSkillRoute>;
  previewSkillImport: RouteHandler<typeof previewSkillImportRoute>;
  importSkill: RouteHandler<typeof importSkillRoute>;
  listSkillCatalog: RouteHandler<typeof listSkillCatalogRoute>;
  getSkill: RouteHandler<typeof getSkillRoute>;
  updateWorkspaceSkill: RouteHandler<typeof updateWorkspaceSkillRoute>;
  archiveSkill: RouteHandler<typeof archiveSkillRoute>;
  enableSkill: RouteHandler<typeof enableSkillRoute>;
  disableSkill: RouteHandler<typeof disableSkillRoute>;
  replaceSkill: RouteHandler<typeof replaceSkillRoute>;
  readSkillFile: RouteHandler<typeof readSkillFileRoute>;
  listPlugins: RouteHandler<typeof listPluginsRoute>;
  previewPluginImport: RouteHandler<typeof previewPluginImportRoute>;
  importPlugin: RouteHandler<typeof importPluginRoute>;
  getPlugin: RouteHandler<typeof getPluginRoute>;
  archivePlugin: RouteHandler<typeof archivePluginRoute>;
  enablePlugin: RouteHandler<typeof enablePluginRoute>;
  disablePlugin: RouteHandler<typeof disablePluginRoute>;
  approvePluginMcp: RouteHandler<typeof approvePluginMcpRoute>;
  revokePluginMcp: RouteHandler<typeof revokePluginMcpRoute>;
  refreshPluginMcp: RouteHandler<typeof refreshPluginMcpRoute>;
  deletePluginData: RouteHandler<typeof deletePluginDataRoute>;
  listConversations: RouteHandler<typeof listConversationsRoute>;
  getConversation: RouteHandler<typeof getConversationRoute>;
  updateConversation: RouteHandler<typeof updateConversationRoute>;
  getConversationShare: RouteHandler<typeof getConversationShareRoute>;
  createConversationShare: RouteHandler<typeof createConversationShareRoute>;
  deleteConversationShare: RouteHandler<typeof deleteConversationShareRoute>;
  generateConversationTitle: RouteHandler<typeof generateConversationTitleRoute>;
  listMessages: RouteHandler<typeof listMessagesRoute>;
  createMessage: RouteHandler<typeof createMessageRoute>;
  uploadAttachment: RouteHandler<typeof uploadAttachmentRoute>;
  deleteChatArtifact: RouteHandler<typeof deleteChatArtifactRoute>;
  downloadChatArtifact: RouteHandler<typeof downloadChatArtifactRoute>;
  downloadChatAttachment: RouteHandler<typeof downloadChatAttachmentRoute>;
  downloadChatScreenshot: RouteHandler<typeof downloadChatScreenshotRoute>;
  getPublicChatShare: RouteHandler<typeof getPublicChatShareRoute>;
  getPublicChatShareMetadata: RouteHandler<typeof getPublicChatShareMetadataRoute>;
  downloadPublicChatAttachment: RouteHandler<typeof downloadPublicChatAttachmentRoute>;
  downloadPublicChatArtifact: RouteHandler<typeof downloadPublicChatArtifactRoute>;
  getEngineRuntimeStatus: RouteHandler<typeof getEngineRuntimeStatusRoute>;
  createEngineRuntimeAccess: RouteHandler<typeof createEngineRuntimeAccessRoute>;
  getRun: RouteHandler<typeof getRunRoute>;
  streamRunEvents: RouteHandler<typeof streamRunEventsRoute>;
  cancelRun: RouteHandler<typeof cancelRunRoute>;
  resolveApproval: RouteHandler<typeof resolveApprovalRoute>;
  streamReadModel: RouteHandler<typeof streamReadModelRoute>;
  updateUserPreferences: RouteHandler<typeof updateUserPreferencesRoute>;
  getMcpSetup: RouteHandler<typeof getMcpSetupRoute>;
  updateMcpSetup: RouteHandler<typeof updateMcpSetupRoute>;
  submitFeedback: RouteHandler<typeof submitFeedbackRoute>;
  listRepoConfigs: RouteHandler<typeof listRepoConfigsRoute>;
  setRepoConfigEnv: RouteHandler<typeof setRepoConfigEnvRoute>;
  setRepoConfigSetup: RouteHandler<typeof setRepoConfigSetupRoute>;
  deleteRepoConfig: RouteHandler<typeof deleteRepoConfigRoute>;
  connectAttioAccount: RouteHandler<typeof connectAttioAccountRoute>;
  disconnectAttioAccount: RouteHandler<typeof disconnectAttioAccountRoute>;
  connectFathomAccount: RouteHandler<typeof connectFathomAccountRoute>;
  connectGranolaAccount: RouteHandler<typeof connectGranolaAccountRoute>;
  startImessagePairing: RouteHandler<typeof startImessagePairingRoute>;
  confirmImessagePairing: RouteHandler<typeof confirmImessagePairingRoute>;
  connectStripeAccount: RouteHandler<typeof connectStripeAccountRoute>;
  disconnectStripeAccount: RouteHandler<typeof disconnectStripeAccountRoute>;
  createJamieWebhookEndpoint: RouteHandler<typeof createJamieWebhookEndpointRoute>;
  saveJamieApiKey: RouteHandler<typeof saveJamieApiKeyRoute>;
  listIntegrationAccounts: RouteHandler<typeof listIntegrationAccountsRoute>;
  getSlackBotWorkspaceSettings: RouteHandler<typeof getSlackBotWorkspaceSettingsRoute>;
  disconnectSlackBot: RouteHandler<typeof disconnectSlackBotRoute>;
  getSlackBotDestination: RouteHandler<typeof getSlackBotDestinationRoute>;
  setSlackBotDestination: RouteHandler<typeof setSlackBotDestinationRoute>;
  listSlackBotChannels: RouteHandler<typeof listSlackBotChannelsRoute>;
  getIntegrationAccountUsage: RouteHandler<typeof getIntegrationAccountUsageRoute>;
  setIntegrationCapabilityMode: RouteHandler<typeof setIntegrationCapabilityModeRoute>;
  alwaysAllowAction: RouteHandler<typeof alwaysAllowActionRoute>;
  deleteIntegrationAccount: RouteHandler<typeof deleteIntegrationAccountRoute>;
  getClaudeCodeAuth: RouteHandler<typeof getClaudeCodeAuthRoute>;
  saveClaudeCodeToken: RouteHandler<typeof saveClaudeCodeTokenRoute>;
  deleteClaudeCodeAuth: RouteHandler<typeof deleteClaudeCodeAuthRoute>;
  getCodexAuth: RouteHandler<typeof getCodexAuthRoute>;
  startCodexDeviceAuth: RouteHandler<typeof startCodexDeviceAuthRoute>;
  pollCodexDeviceAuth: RouteHandler<typeof pollCodexDeviceAuthRoute>;
  deleteCodexAuth: RouteHandler<typeof deleteCodexAuthRoute>;
  getInfisicalAuth: RouteHandler<typeof getInfisicalAuthRoute>;
  startInfisicalAuth: RouteHandler<typeof startInfisicalAuthRoute>;
  completeInfisicalAuth: RouteHandler<typeof completeInfisicalAuthRoute>;
  deleteInfisicalAuth: RouteHandler<typeof deleteInfisicalAuthRoute>;
  getBillingOverview: RouteHandler<typeof getBillingOverviewRoute>;
  getBillingUsage: RouteHandler<typeof getBillingUsageRoute>;
  getBillingBalance: RouteHandler<typeof getBillingBalanceRoute>;
  createBillingTopUp: RouteHandler<typeof createBillingTopUpRoute>;
  createBillingSubscriptionCheckout: RouteHandler<typeof createBillingSubscriptionCheckoutRoute>;
  createBillingPortalSession: RouteHandler<typeof createBillingPortalSessionRoute>;
  updateBillingAutoRefill: RouteHandler<typeof updateBillingAutoRefillRoute>;
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
  return (
    app
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
      .openapi(listBrainSourceItemsRoute, handlers.listBrainSourceItems)
      .openapi(listBrainSourcesRoute, handlers.listBrainSources)
      .openapi(setBrainSourceRoute, handlers.setBrainSource)
      .openapi(deleteBrainSourceRoute, handlers.deleteBrainSource)
      .openapi(listBrowserProfilesRoute, handlers.listBrowserProfiles)
      .openapi(createBrowserProfileRoute, handlers.createBrowserProfile)
      .openapi(deleteBrowserProfileRoute, handlers.deleteBrowserProfile)
      .openapi(createBrowserProfileLoginSessionRoute, handlers.createBrowserProfileLoginSession)
      .openapi(completeBrowserProfileLoginRoute, handlers.completeBrowserProfileLogin)
      .openapi(getBrowserProfileLiveViewRoute, handlers.getBrowserProfileLiveView)
      .openapi(getWorkspaceCapabilitiesRoute, handlers.getWorkspaceCapabilities)
      // Static segments register before the generic capability-source and
      // approval-id paths so route matching cannot capture them as ids.
      .openapi(setCapabilitySessionBudgetRoute, handlers.setCapabilitySessionBudget)
      .openapi(setWorkspaceCapabilityRoute, handlers.setWorkspaceCapability)
      .openapi(getCapabilityApprovalByToolCallRoute, handlers.getCapabilityApprovalByToolCall)
      .openapi(getCapabilityApprovalRoute, handlers.getCapabilityApproval)
      .openapi(createBrainRoute, handlers.createBrain)
      .openapi(switchBrainRoute, handlers.switchBrain)
      .openapi(getBrainAccessRoute, handlers.getBrainAccess)
      .openapi(setBrainAccessRoute, handlers.setBrainAccess)
      .openapi(getBrainEnrichmentRoute, handlers.getBrainEnrichment)
      .openapi(setBrainEnrichmentRoute, handlers.setBrainEnrichment)
      .openapi(getBrainIntelligenceRoute, handlers.getBrainIntelligence)
      .openapi(setBrainIntelligenceRoute, handlers.setBrainIntelligence)
      .openapi(getIdentityRoute, handlers.getIdentity)
      .openapi(syncIdentityRoute, handlers.syncIdentity)
      .openapi(getWorkspaceSettingsRoute, handlers.getWorkspaceSettings)
      .openapi(renameWorkspaceRoute, handlers.renameWorkspace)
      .openapi(inviteWorkspaceMemberRoute, handlers.inviteWorkspaceMember)
      .openapi(revokeWorkspaceInvitationRoute, handlers.revokeWorkspaceInvitation)
      .openapi(removeWorkspaceMemberRoute, handlers.removeWorkspaceMember)
      .openapi(createWorkspaceRoute, handlers.createWorkspace)
      .openapi(switchWorkspaceRoute, handlers.switchWorkspace)
      .openapi(getOnboardingStateRoute, handlers.getOnboardingState)
      .openapi(checkOnboardingWorkspaceSlugRoute, handlers.checkOnboardingWorkspaceSlug)
      .openapi(saveOnboardingProfileRoute, handlers.saveOnboardingProfile)
      .openapi(saveOnboardingWorkspaceRoute, handlers.saveOnboardingWorkspace)
      .openapi(finishOnboardingRoute, handlers.finishOnboarding)
      .openapi(listBrainSourceOptionsRoute, handlers.listBrainSourceOptions)
      .openapi(startBrainImportRoute, handlers.startBrainImport)
      .openapi(confirmBrainImportRoute, handlers.confirmBrainImport)
      .openapi(cancelBrainImportRoute, handlers.cancelBrainImport)
      .openapi(retryBrainImportRoute, handlers.retryBrainImport)
      .openapi(createBrainDocumentRoute, handlers.createBrainDocument)
      .openapi(uploadBrainAssetRoute, handlers.uploadBrainAsset)
      .openapi(replaceBrainAssetRoute, handlers.replaceBrainAsset)
      .openapi(downloadBrainAssetRoute, handlers.downloadBrainAsset)
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
      .openapi(listWikiSourcesRoute, handlers.listWikiSources)
      .openapi(listWikiIngestActivityRoute, handlers.listWikiIngestActivity)
      .openapi(upsertWikiSourceRoute, handlers.upsertWikiSource)
      .openapi(setWikiSourceEnabledRoute, handlers.setWikiSourceEnabled)
      .openapi(deleteWikiSourceRoute, handlers.deleteWikiSource)
      .openapi(listSkillsRoute, handlers.listSkills)
      .openapi(createWorkspaceSkillRoute, handlers.createWorkspaceSkill)
      .openapi(previewSkillImportRoute, handlers.previewSkillImport)
      .openapi(importSkillRoute, handlers.importSkill)
      .openapi(listSkillCatalogRoute, handlers.listSkillCatalog)
      .openapi(getSkillRoute, handlers.getSkill)
      .openapi(updateWorkspaceSkillRoute, handlers.updateWorkspaceSkill)
      .openapi(archiveSkillRoute, handlers.archiveSkill)
      .openapi(enableSkillRoute, handlers.enableSkill)
      .openapi(disableSkillRoute, handlers.disableSkill)
      .openapi(replaceSkillRoute, handlers.replaceSkill)
      .openapi(readSkillFileRoute, handlers.readSkillFile)
      .openapi(listConversationsRoute, handlers.listConversations)
      .openapi(getConversationRoute, handlers.getConversation)
      .openapi(updateConversationRoute, handlers.updateConversation)
      .openapi(getConversationShareRoute, handlers.getConversationShare)
      .openapi(createConversationShareRoute, handlers.createConversationShare)
      .openapi(deleteConversationShareRoute, handlers.deleteConversationShare)
      .openapi(generateConversationTitleRoute, handlers.generateConversationTitle)
      .openapi(listMessagesRoute, handlers.listMessages)
      .openapi(createMessageRoute, handlers.createMessage)
      .openapi(uploadAttachmentRoute, handlers.uploadAttachment)
      .openapi(deleteChatArtifactRoute, handlers.deleteChatArtifact)
      .openapi(downloadChatArtifactRoute, handlers.downloadChatArtifact)
      .openapi(downloadChatAttachmentRoute, handlers.downloadChatAttachment)
      .openapi(downloadChatScreenshotRoute, handlers.downloadChatScreenshot)
      .openapi(getPublicChatShareRoute, handlers.getPublicChatShare)
      .openapi(getPublicChatShareMetadataRoute, handlers.getPublicChatShareMetadata)
      .openapi(downloadPublicChatAttachmentRoute, handlers.downloadPublicChatAttachment)
      .openapi(downloadPublicChatArtifactRoute, handlers.downloadPublicChatArtifact)
      .openapi(getEngineRuntimeStatusRoute, handlers.getEngineRuntimeStatus)
      .openapi(createEngineRuntimeAccessRoute, handlers.createEngineRuntimeAccess)
      .openapi(getRunRoute, handlers.getRun)
      .openapi(streamRunEventsRoute, handlers.streamRunEvents)
      .openapi(cancelRunRoute, handlers.cancelRun)
      .openapi(resolveApprovalRoute, handlers.resolveApproval)
      .openapi(streamReadModelRoute, handlers.streamReadModel)
      .openapi(updateUserPreferencesRoute, handlers.updateUserPreferences)
      .openapi(getMcpSetupRoute, handlers.getMcpSetup)
      .openapi(updateMcpSetupRoute, handlers.updateMcpSetup)
      .openapi(submitFeedbackRoute, handlers.submitFeedback)
      .openapi(listRepoConfigsRoute, handlers.listRepoConfigs)
      .openapi(setRepoConfigEnvRoute, handlers.setRepoConfigEnv)
      .openapi(setRepoConfigSetupRoute, handlers.setRepoConfigSetup)
      .openapi(deleteRepoConfigRoute, handlers.deleteRepoConfig)
      // Static provider paths must register before the generic {integrationId}
      // routes so e.g. DELETE /v1/integration-accounts/stripe never captures
      // "stripe" as an integration id.
      .openapi(connectAttioAccountRoute, handlers.connectAttioAccount)
      .openapi(disconnectAttioAccountRoute, handlers.disconnectAttioAccount)
      .openapi(connectFathomAccountRoute, handlers.connectFathomAccount)
      .openapi(connectGranolaAccountRoute, handlers.connectGranolaAccount)
      .openapi(startImessagePairingRoute, handlers.startImessagePairing)
      .openapi(confirmImessagePairingRoute, handlers.confirmImessagePairing)
      .openapi(connectStripeAccountRoute, handlers.connectStripeAccount)
      .openapi(disconnectStripeAccountRoute, handlers.disconnectStripeAccount)
      .openapi(createJamieWebhookEndpointRoute, handlers.createJamieWebhookEndpoint)
      .openapi(saveJamieApiKeyRoute, handlers.saveJamieApiKey)
      .openapi(listIntegrationAccountsRoute, handlers.listIntegrationAccounts)
      .openapi(getSlackBotWorkspaceSettingsRoute, handlers.getSlackBotWorkspaceSettings)
      .openapi(disconnectSlackBotRoute, handlers.disconnectSlackBot)
      .openapi(getSlackBotDestinationRoute, handlers.getSlackBotDestination)
      .openapi(setSlackBotDestinationRoute, handlers.setSlackBotDestination)
      .openapi(listSlackBotChannelsRoute, handlers.listSlackBotChannels)
      .openapi(getIntegrationAccountUsageRoute, handlers.getIntegrationAccountUsage)
      .openapi(setIntegrationCapabilityModeRoute, handlers.setIntegrationCapabilityMode)
      .openapi(alwaysAllowActionRoute, handlers.alwaysAllowAction)
      .openapi(deleteIntegrationAccountRoute, handlers.deleteIntegrationAccount)
      .openapi(getClaudeCodeAuthRoute, handlers.getClaudeCodeAuth)
      .openapi(saveClaudeCodeTokenRoute, handlers.saveClaudeCodeToken)
      .openapi(deleteClaudeCodeAuthRoute, handlers.deleteClaudeCodeAuth)
      .openapi(getCodexAuthRoute, handlers.getCodexAuth)
      // POST /codex/device registers before the {flowId} poll route so the
      // static segment always wins route matching.
      .openapi(startCodexDeviceAuthRoute, handlers.startCodexDeviceAuth)
      .openapi(pollCodexDeviceAuthRoute, handlers.pollCodexDeviceAuth)
      .openapi(deleteCodexAuthRoute, handlers.deleteCodexAuth)
      .openapi(getInfisicalAuthRoute, handlers.getInfisicalAuth)
      .openapi(startInfisicalAuthRoute, handlers.startInfisicalAuth)
      .openapi(completeInfisicalAuthRoute, handlers.completeInfisicalAuth)
      .openapi(deleteInfisicalAuthRoute, handlers.deleteInfisicalAuth)
      .openapi(getBillingOverviewRoute, handlers.getBillingOverview)
      .openapi(getBillingUsageRoute, handlers.getBillingUsage)
      .openapi(getBillingBalanceRoute, handlers.getBillingBalance)
      .openapi(createBillingTopUpRoute, handlers.createBillingTopUp)
      .openapi(createBillingSubscriptionCheckoutRoute, handlers.createBillingSubscriptionCheckout)
      .openapi(createBillingPortalSessionRoute, handlers.createBillingPortalSession)
      .openapi(updateBillingAutoRefillRoute, handlers.updateBillingAutoRefill)
      .openapi(listPluginsRoute, handlers.listPlugins)
      .openapi(previewPluginImportRoute, handlers.previewPluginImport)
      .openapi(importPluginRoute, handlers.importPlugin)
      .openapi(getPluginRoute, handlers.getPlugin)
      .openapi(archivePluginRoute, handlers.archivePlugin)
      .openapi(enablePluginRoute, handlers.enablePlugin)
      .openapi(disablePluginRoute, handlers.disablePlugin)
      .openapi(approvePluginMcpRoute, handlers.approvePluginMcp)
      .openapi(revokePluginMcpRoute, handlers.revokePluginMcp)
      .openapi(refreshPluginMcpRoute, handlers.refreshPluginMcp)
      .openapi(deletePluginDataRoute, handlers.deletePluginData)
  );
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
    info: { title: "opencompany Headless API", version: PROTOCOL_VERSION },
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
const placeholderBrowserProfile = {
  id: "profile_contract",
  name: "Contract profile",
  siteHost: "example.com",
  allowedHosts: ["example.com"],
  status: "pending_login" as const,
  active: false,
  lastUsedAt: null,
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
const placeholderWikiSource = {
  id: "gwscfg_contract",
  provider: "gmail" as const,
  integrationId: "integration_contract",
  enabled: true,
  config: {},
  integrationStatus: "connected" as const,
  accountName: "Contract account",
  accountEmail: "contract@example.com",
  connectionLabel: null,
  ownerName: "Contract owner",
  ownerEmail: "contract@example.com",
  ownerAvatarUrl: null,
  ownerKind: "user" as const,
  isOwn: true,
  canConfigure: true,
  canToggle: true,
  canDelete: true,
};
const placeholderSkillSource = {
  type: "github" as const,
  url: "https://github.com/example/skills",
  ref: "main",
  path: "contract-skill",
  resolvedCommit: "a".repeat(40),
};
const placeholderSkillBundle = {
  id: "skill_bundle_contract",
  integrity: `sha256:${"b".repeat(64)}`,
  name: "contract-skill",
  description: "A contract placeholder.",
  license: null,
  compatibility: null,
  metadata: null,
  allowedTools: null,
  body: "Complete the contract placeholder.",
  source: placeholderSkillSource,
  files: [{ path: "SKILL.md", executable: false, sizeBytes: 128 }],
  createdAt: placeholderTime,
};
const placeholderSkillInstallation = {
  id: "skill_installation_contract",
  name: "contract-skill",
  enabled: true,
  archivedAt: null,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
  bundle: placeholderSkillBundle,
};
const placeholderPlugin = {
  id: "plugin_contract",
  name: "contract-plugin",
  status: "enabled" as const,
  manifest: {
    name: "contract-plugin",
    version: "1.0.0",
    description: "A contract Plugin.",
  },
  source: { ...placeholderSkillSource, path: "contract-plugin" },
  integrity: `sha256:${"c".repeat(64)}`,
  files: [{ path: "plugin.json", executable: false, sizeBytes: 128 }],
  skills: [
    {
      name: placeholderSkillBundle.name,
      path: "skills/contract-skill",
      bundleId: placeholderSkillBundle.id,
      integrity: placeholderSkillBundle.integrity,
      description: placeholderSkillBundle.description,
    },
  ],
  stdioServers: [
    {
      name: "contract-server",
      type: "stdio" as const,
      command: "./server",
      args: [],
      envKeys: ["CONTRACT_TOKEN"],
    },
  ],
  installReport: {
    ignoredManifestFields: [],
    skills: [
      {
        path: "skills/contract-skill",
        name: "contract-skill",
        status: "valid" as const,
        integrity: placeholderSkillBundle.integrity,
      },
    ],
    mcp: {
      present: true as const,
      status: "parsed" as const,
      reports: [
        {
          name: "contract-server",
          status: "selected" as const,
          transport: "stdio" as const,
        },
      ],
    },
    collisions: [],
  },
  mcpApprovedIntegrity: null,
  createdAt: placeholderTime,
  updatedAt: placeholderTime,
  archivedAt: null,
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
  listBrainSourceItems: (c) => c.json({ data: [], meta }, 200),
  listBrainSources: (c) =>
    c.json(
      {
        data: {
          viewer: { actorId: "user_contract", isAdmin: true },
          sources: [],
          ownAccounts: {
            slack: [],
            linear: [],
            gmail: [],
            google_drive: [],
            hubspot: [],
            granola: [],
            fathom: [],
            attio: [],
          },
          jamie: {
            integration: {
              provider: "jamie",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountName: null,
              statusReason: null,
              webhookUrl: null,
              apiKeyConfigured: false,
            },
            legacyDefaultDelivery: false,
            isDefaultBrain: false,
          },
          slack: {
            integration: {
              provider: "slack",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountName: null,
              teamName: null,
              statusReason: null,
            },
          },
          linear: {
            integration: {
              provider: "linear",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountName: null,
              organizationName: null,
              statusReason: null,
            },
          },
          github: {
            integration: {
              provider: "github",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountName: null,
              statusReason: null,
            },
          },
          gmail: {
            integration: {
              provider: "gmail",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountEmail: null,
              statusReason: null,
            },
          },
          googleDrive: {
            integration: {
              provider: "google_drive",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountEmail: null,
              statusReason: null,
            },
          },
          hubspot: {
            integration: {
              provider: "hubspot",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountEmail: null,
              hubDomain: null,
              statusReason: null,
            },
          },
          granola: {
            integration: {
              provider: "granola",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountEmail: null,
              accountName: null,
              statusReason: null,
            },
          },
          fathom: {
            integration: {
              provider: "fathom",
              connected: false,
              status: "not_connected",
              integrationId: null,
              accountEmail: null,
              accountName: null,
              statusReason: null,
            },
          },
          attio: {
            integration: {
              provider: "attio",
              connected: false,
              status: "not_connected",
              integrationId: null,
              workspaceName: null,
              statusReason: null,
            },
          },
        },
        meta,
      },
      200,
    ),
  setBrainSource: (c) =>
    c.json(
      {
        data: {
          brainId: "brain_contract",
          integrationId: "integration_contract",
          provider: "slack",
          enabled: true,
        },
        meta,
      },
      200,
    ),
  deleteBrainSource: (c) =>
    c.json(
      {
        data: {
          brainId: "brain_contract",
          integrationId: "integration_contract",
          deleted: true as const,
        },
        meta,
      },
      200,
    ),
  listBrainSourceOptions: (c) => c.json({ data: { provider: "github", repos: [] }, meta }, 200),
  listBrowserProfiles: (c) => c.json({ data: [], meta }, 200),
  createBrowserProfile: (c) => c.json({ data: placeholderBrowserProfile, meta }, 201),
  deleteBrowserProfile: (c) =>
    c.json({ data: { profileId: "profile_contract", deleted: true as const }, meta }, 200),
  createBrowserProfileLoginSession: (c) =>
    c.json(
      {
        data: {
          profileId: "profile_contract",
          sessionId: "session_contract",
          liveViewUrl: "https://live.example.com/session",
        },
        meta,
      },
      201,
    ),
  completeBrowserProfileLogin: (c) =>
    c.json(
      {
        data: {
          profileId: "profile_contract",
          sessionId: "session_contract",
          completed: true as const,
        },
        meta,
      },
      200,
    ),
  getBrowserProfileLiveView: (c) =>
    c.json({ data: { url: "https://live.example.com/session" }, meta }, 200),
  getWorkspaceCapabilities: (c) =>
    c.json(
      {
        data: {
          capabilities: [{ source: "x" as const, enabled: true }],
          sessionBudgetUsdMicros: 5_000_000,
        },
        meta,
      },
      200,
    ),
  setCapabilitySessionBudget: (c) =>
    c.json({ data: { sessionBudgetUsdMicros: 5_000_000 }, meta }, 200),
  setWorkspaceCapability: (c) =>
    c.json({ data: { source: "x" as const, enabled: true }, meta }, 200),
  getCapabilityApprovalByToolCall: (c) =>
    c.json(
      {
        data: {
          runId: "gcr_contract",
          source: "x" as const,
          action: "search",
          status: "awaiting_approval" as const,
          maxCostUsdMicros: 10_000,
          expiresAt: placeholderTime,
          settledCostUsdMicros: null,
          sessionBudgetUsdMicros: 5_000_000,
        },
        meta,
      },
      200,
    ),
  getCapabilityApproval: (c) =>
    c.json(
      {
        data: {
          runId: "gcr_contract",
          source: "x" as const,
          action: "search",
          status: "awaiting_approval" as const,
          maxCostUsdMicros: 10_000,
          expiresAt: placeholderTime,
          settledCostUsdMicros: null,
        },
        meta,
      },
      200,
    ),
  createBrain: (c) => c.json({ data: { brainId: "brain_contract" }, meta }, 201),
  switchBrain: (c) => c.json({ data: { brainId: "brain_contract" }, meta }, 200),
  getBrainAccess: (c) =>
    c.json(
      {
        data: {
          visibility: "workspace" as const,
          memberIds: [],
          workspaceMembers: [],
        },
        meta,
      },
      200,
    ),
  setBrainAccess: (c) => c.json({ data: { updated: true as const }, meta }, 200),
  getBrainEnrichment: (c) => c.json({ data: { enabled: true }, meta }, 200),
  setBrainEnrichment: (c) => c.json({ data: { enabled: true }, meta }, 200),
  getBrainIntelligence: (c) => c.json({ data: { intelligence: "basic" as const }, meta }, 200),
  setBrainIntelligence: (c) => c.json({ data: { intelligence: "basic" as const }, meta }, 200),
  getIdentity: (c) => c.json({ data: contractIdentity(), meta }, 200),
  syncIdentity: (c) => c.json({ data: contractIdentity(), meta }, 200),
  getWorkspaceSettings: (c) =>
    c.json(
      {
        data: {
          workspace: { id: "goat_ws_contract", name: "Contract Workspace" },
          role: "admin" as const,
          plan: "hobby" as const,
          memberCap: 1,
          members: [],
          invitations: [],
        },
        meta,
      },
      200,
    ),
  renameWorkspace: (c) =>
    c.json({ data: { id: "goat_ws_contract", name: "Contract Workspace" }, meta }, 200),
  inviteWorkspaceMember: (c) => c.json({ data: { completed: true as const }, meta }, 201),
  revokeWorkspaceInvitation: (c) => c.json({ data: { completed: true as const }, meta }, 200),
  removeWorkspaceMember: (c) => c.json({ data: { completed: true as const }, meta }, 200),
  createWorkspace: (c) =>
    c.json(
      {
        data: {
          workspaceId: "goat_ws_contract",
          organizationId: "org_contract",
          brainId: "brain_contract",
        },
        meta,
      },
      201,
    ),
  switchWorkspace: (c) =>
    c.json(
      {
        data: {
          workspaceId: "goat_ws_contract",
          organizationId: "org_contract",
          brainId: "brain_contract",
        },
        meta,
      },
      200,
    ),
  getOnboardingState: (c) =>
    c.json(
      {
        data: {
          onboarding: null,
          workspace: null,
          activeBrainId: null,
        },
        meta,
      },
      200,
    ),
  checkOnboardingWorkspaceSlug: (c) =>
    c.json({ data: { slug: "contract-workspace", available: true }, meta }, 200),
  saveOnboardingProfile: (c) => c.json({ data: { completed: true as const }, meta }, 200),
  saveOnboardingWorkspace: (c) =>
    c.json(
      {
        data: {
          workspaceId: "goat_ws_contract",
          organizationId: "org_contract",
          brainId: "brain_contract",
          createdByCaller: true,
        },
        meta,
      },
      200,
    ),
  finishOnboarding: (c) => c.json({ data: { completed: true as const }, meta }, 200),
  startBrainImport: (c) =>
    c.json(
      {
        data: {
          importRunId: "gbimp_contract",
          status: "discovering" as const,
          replayed: false,
        },
        meta,
      },
      201,
    ),
  confirmBrainImport: (c) =>
    c.json(
      {
        data: { importRunId: "gbimp_contract", status: "ingesting" as const, replayed: false },
        meta,
      },
      200,
    ),
  cancelBrainImport: (c) =>
    c.json(
      {
        data: { importRunId: "gbimp_contract", status: "canceled" as const, replayed: false },
        meta,
      },
      200,
    ),
  retryBrainImport: (c) =>
    c.json(
      {
        data: { importRunId: "gbimp_contract", status: "discovering" as const, replayed: false },
        meta,
      },
      200,
    ),
  createBrainDocument: (c) => c.json({ data: placeholderBrainDocument, meta }, 201),
  uploadBrainAsset: (c) =>
    c.json(
      {
        data: { document: placeholderBrainDocument, quotaPaused: false, replayed: false },
        meta,
      },
      201,
    ),
  replaceBrainAsset: (c) =>
    c.json(
      {
        data: { document: placeholderBrainDocument, quotaPaused: false, replayed: false },
        meta,
      },
      200,
    ),
  downloadBrainAsset: (c) =>
    c.body("contract", 200, { "Content-Type": "application/octet-stream" }),
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
  listWikiSources: (c) => c.json({ data: [placeholderWikiSource], meta }, 200),
  listWikiIngestActivity: (c) => c.json({ data: { items: [], nextCursor: null }, meta }, 200),
  upsertWikiSource: (c) => c.json({ data: placeholderWikiSource, meta }, 200),
  setWikiSourceEnabled: (c) => c.json({ data: placeholderWikiSource, meta }, 200),
  deleteWikiSource: (c) =>
    c.json({ data: { sourceId: placeholderWikiSource.id, deleted: true as const }, meta }, 200),
  listSkills: (c) =>
    c.json(
      {
        data: [
          {
            ...placeholderSkillInstallation,
            bundle: {
              ...placeholderSkillBundle,
              body: undefined,
              files: undefined,
            },
          },
        ],
        meta,
      },
      200,
    ),
  createWorkspaceSkill: (c) =>
    c.json({ data: { installation: placeholderSkillInstallation, replayed: false }, meta }, 201),
  previewSkillImport: (c) =>
    c.json(
      {
        data: {
          status: "resolved",
          name: placeholderSkillBundle.name,
          description: placeholderSkillBundle.description,
          source: placeholderSkillSource,
          integrity: placeholderSkillBundle.integrity,
          files: placeholderSkillBundle.files,
          fileCount: 1,
          totalBytes: 128,
        },
        meta,
      },
      200,
    ),
  importSkill: (c) =>
    c.json({ data: { installation: placeholderSkillInstallation, replayed: false }, meta }, 201),
  listSkillCatalog: (c) =>
    c.json(
      {
        data: [
          {
            id: placeholderSkillInstallation.name,
            name: placeholderSkillBundle.name,
            description: placeholderSkillBundle.description,
          },
        ],
        meta,
      },
      200,
    ),
  getSkill: (c) => c.json({ data: placeholderSkillInstallation, meta }, 200),
  updateWorkspaceSkill: (c) => c.json({ data: placeholderSkillInstallation, meta }, 200),
  archiveSkill: (c) => c.json({ data: { name: placeholderSkillInstallation.name }, meta }, 200),
  enableSkill: (c) => c.json({ data: placeholderSkillInstallation, meta }, 200),
  disableSkill: (c) =>
    c.json({ data: { ...placeholderSkillInstallation, enabled: false }, meta }, 200),
  replaceSkill: (c) => c.json({ data: placeholderSkillInstallation, meta }, 200),
  readSkillFile: (c) =>
    c.json(
      {
        data: {
          path: "SKILL.md",
          executable: false,
          sizeBytes: 128,
          offset: 0,
          nextOffset: 128,
          eof: true,
          encoding: "utf8" as const,
          content: placeholderSkillBundle.body,
        },
        meta,
      },
      200,
    ),
  listPlugins: (c) =>
    c.json(
      {
        data: [
          {
            ...placeholderPlugin,
            files: undefined,
            skills: undefined,
            stdioServers: undefined,
            fileCount: 1,
            skillCount: 1,
            stdioServerCount: 1,
          },
        ],
        meta,
      },
      200,
    ),
  previewPluginImport: (c) =>
    c.json(
      {
        data: {
          manifest: placeholderPlugin.manifest,
          source: placeholderPlugin.source,
          integrity: placeholderPlugin.integrity,
          files: [{ path: "plugin.json", sizeBytes: 128 }],
          fileCount: 1,
          totalBytes: 128,
          skills: [
            {
              path: "skills/contract-skill",
              name: "contract-skill",
              description: placeholderSkillBundle.description,
              integrity: placeholderSkillBundle.integrity,
              fileCount: 1,
              totalBytes: 128,
            },
          ],
          stdioServers: placeholderPlugin.stdioServers,
          report: {
            ignoredManifestFields: [],
            skills: placeholderPlugin.installReport.skills,
            mcp: placeholderPlugin.installReport.mcp,
          },
        },
        meta,
      },
      200,
    ),
  importPlugin: (c) => c.json({ data: { plugin: placeholderPlugin, replayed: false }, meta }, 201),
  getPlugin: (c) => c.json({ data: placeholderPlugin, meta }, 200),
  archivePlugin: (c) => c.json({ data: { name: placeholderPlugin.name }, meta }, 200),
  enablePlugin: (c) => c.json({ data: placeholderPlugin, meta }, 200),
  disablePlugin: (c) =>
    c.json({ data: { ...placeholderPlugin, status: "disabled" as const }, meta }, 200),
  approvePluginMcp: (c) =>
    c.json(
      {
        data: { ...placeholderPlugin, mcpApprovedIntegrity: placeholderPlugin.integrity },
        meta,
      },
      200,
    ),
  revokePluginMcp: (c) => c.json({ data: placeholderPlugin, meta }, 200),
  refreshPluginMcp: (c) => c.json({ data: placeholderPlugin, meta }, 200),
  deletePluginData: (c) =>
    c.json({ data: { name: placeholderPlugin.name, deleted: true }, meta }, 200),
  listConversations: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  getConversation: (c) => c.json({ data: placeholderConversation, meta }, 200),
  updateConversation: (c) =>
    c.json({ data: { conversationId: "conversation_contract", transactionId: "1" }, meta }, 200),
  getConversationShare: (c) =>
    c.json({ data: { conversationId: "conversation_contract", shareId: null }, meta }, 200),
  createConversationShare: (c) =>
    c.json(
      {
        data: {
          conversationId: "conversation_contract",
          shareId: "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd",
        },
        meta,
      },
      200,
    ),
  deleteConversationShare: (c) =>
    c.json({ data: { conversationId: "conversation_contract", shareId: null }, meta }, 200),
  generateConversationTitle: (c) =>
    c.json(
      {
        data: { conversationId: "conversation_contract", title: "Contract title", generated: true },
        meta,
      },
      200,
    ),
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
  deleteChatArtifact: (c) =>
    c.json({ data: { artifactId: "artifact_contract", state: "deleted" as const }, meta }, 200),
  downloadChatArtifact: (c) =>
    c.body("contract", 200, { "Content-Type": "application/octet-stream" }),
  downloadChatAttachment: (c) =>
    c.body("contract", 200, { "Content-Type": "application/octet-stream" }),
  downloadChatScreenshot: (c) =>
    c.body("contract", 200, { "Content-Type": "application/octet-stream" }),
  getPublicChatShare: (c) =>
    c.json(
      {
        data: {
          shareId: "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd",
          title: "Shared conversation",
          kind: "chat" as const,
          engine: "opencompany" as const,
          messages: [],
        },
        meta,
      },
      200,
    ),
  getPublicChatShareMetadata: (c) =>
    c.json(
      {
        data: {
          shareId: "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd",
          title: "Shared conversation",
          kind: "chat" as const,
          engine: "opencompany" as const,
        },
        meta,
      },
      200,
    ),
  downloadPublicChatAttachment: (c) =>
    c.body("contract", 200, { "Content-Type": "application/octet-stream" }),
  downloadPublicChatArtifact: (c) =>
    c.body("contract", 200, { "Content-Type": "application/octet-stream" }),
  getEngineRuntimeStatus: (c) =>
    c.json(
      { data: { conversationId: "conversation_contract", status: "running" as const }, meta },
      200,
    ),
  createEngineRuntimeAccess: (c) =>
    c.json(
      {
        data: {
          conversationId: "conversation_contract",
          websocketUrl: "wss://runner.example.test/goat/runtime",
          ticket: "runtime_ticket_contract",
          expiresAt: 1_786_449_900,
          runtimeStatus: "running" as const,
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
  updateUserPreferences: (c) =>
    c.json(
      {
        data: {
          timezone: "UTC",
          taskSpawningEnabled: false,
          wikiEnabled: false,
          taskViewMode: "board" as const,
          imessageEnabled: false,
          autoModelRoutingEnabled: false,
        },
        meta,
      },
      200,
    ),
  getMcpSetup: (c) =>
    c.json({ data: { preferredClient: null, complete: false, completedAt: null }, meta }, 200),
  updateMcpSetup: (c) =>
    c.json(
      {
        data: { preferredClient: "claude" as const, complete: false, completedAt: null },
        meta,
      },
      200,
    ),
  submitFeedback: (c) => c.json({ data: { submitted: true as const }, meta }, 200),
  listRepoConfigs: (c) => c.json({ data: { repositories: [], configs: [] }, meta }, 200),
  setRepoConfigEnv: (c) =>
    c.json(
      {
        data: {
          repositoryExternalId: "123456789",
          repositoryFullName: "opencompany/contract",
          envKeys: ["API_KEY"],
          setupInstructions: "",
          updatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  setRepoConfigSetup: (c) =>
    c.json(
      {
        data: {
          repositoryExternalId: "123456789",
          repositoryFullName: "opencompany/contract",
          envKeys: [],
          setupInstructions: "Run bun install.",
          updatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  deleteRepoConfig: (c) =>
    c.json({ data: { repositoryExternalId: "123456789", deleted: true as const }, meta }, 200),
  connectAttioAccount: (c) =>
    c.json(
      {
        data: {
          state: {
            provider: "attio" as const,
            connected: true,
            status: "connected" as const,
            integrationId: "gint_contract",
            workspaceName: "Contract",
            statusReason: null,
          },
        },
        meta,
      },
      200,
    ),
  disconnectAttioAccount: (c) =>
    c.json({ data: { integrationId: "gint_contract", deleted: true as const }, meta }, 200),
  connectFathomAccount: (c) =>
    c.json(
      {
        data: {
          state: {
            provider: "fathom" as const,
            connected: true,
            status: "connected" as const,
            integrationId: "gint_contract",
            accountEmail: null,
            accountName: null,
            statusReason: null,
          },
        },
        meta,
      },
      200,
    ),
  connectGranolaAccount: (c) =>
    c.json(
      {
        data: {
          state: {
            provider: "granola" as const,
            connected: true,
            status: "connected" as const,
            integrationId: "gint_contract",
            accountEmail: null,
            accountName: null,
            statusReason: null,
          },
        },
        meta,
      },
      200,
    ),
  startImessagePairing: (c) => c.json({ data: { started: true as const }, meta }, 200),
  confirmImessagePairing: (c) =>
    c.json(
      {
        data: {
          state: {
            provider: "imessage" as const,
            connected: true,
            status: "connected" as const,
            integrationId: "gint_contract",
            phoneE164: "+14155551234",
            statusReason: null,
          },
        },
        meta,
      },
      200,
    ),
  connectStripeAccount: (c) =>
    c.json(
      {
        data: {
          state: {
            provider: "stripe" as const,
            connected: true,
            status: "connected" as const,
            integrationId: "gint_contract",
            accountName: "Contract",
            livemode: false,
            statusReason: null,
          },
        },
        meta,
      },
      200,
    ),
  disconnectStripeAccount: (c) => c.json({ data: { deleted: true as const }, meta }, 200),
  createJamieWebhookEndpoint: (c) =>
    c.json(
      {
        data: {
          setup: {
            integrationId: "gint_contract",
            webhookUrl: "https://app.example.com/api/webhooks/jamie",
            headerName: "x-api-key",
            apiKeyConfigured: false,
          },
        },
        meta,
      },
      200,
    ),
  saveJamieApiKey: (c) =>
    c.json(
      {
        data: {
          setup: {
            integrationId: "gint_contract",
            webhookUrl: "https://app.example.com/api/webhooks/jamie",
            headerName: "x-api-key",
            apiKeyConfigured: true,
          },
        },
        meta,
      },
      200,
    ),
  listIntegrationAccounts: (c) => c.json({ data: [], meta }, 200),
  getSlackBotWorkspaceSettings: (c) =>
    c.json(
      {
        data: {
          isAdmin: true,
          configured: true,
          installed: false,
          status: "not_connected" as const,
          needsScopeUpgrade: false,
          teamName: null,
          statusReason: null,
          destinationCount: 0,
        },
        meta,
      },
      200,
    ),
  disconnectSlackBot: (c) => c.json({ data: { updated: true as const }, meta }, 200),
  getSlackBotDestination: (c) =>
    c.json(
      {
        data: {
          installed: false,
          botConnected: false,
          isAdmin: true,
          brainVisibility: "workspace" as const,
          source: null,
        },
        meta,
      },
      200,
    ),
  setSlackBotDestination: (c) => c.json({ data: { updated: true as const }, meta }, 200),
  listSlackBotChannels: (c) => c.json({ data: { channels: [], partial: false }, meta }, 200),
  getIntegrationAccountUsage: (c) => c.json({ data: { affectedBrainSourceCount: 0 }, meta }, 200),
  setIntegrationCapabilityMode: (c) =>
    c.json(
      {
        data: {
          integrationId: "gint_contract",
          capabilityId: "write",
          mode: "on" as const,
        },
        meta,
      },
      200,
    ),
  alwaysAllowAction: (c) =>
    c.json({ data: { actionId: "gmail.send_email", state: "allowed" as const }, meta }, 200),
  deleteIntegrationAccount: (c) =>
    c.json({ data: { integrationId: "gint_contract", deleted: true as const }, meta }, 200),
  getClaudeCodeAuth: (c) =>
    c.json(
      {
        data: {
          status: "connected" as const,
          statusReason: null,
          lastValidatedAt: placeholderTime,
          lastRotatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  saveClaudeCodeToken: (c) =>
    c.json(
      {
        data: {
          status: "connected" as const,
          statusReason: null,
          lastValidatedAt: null,
          lastRotatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  deleteClaudeCodeAuth: (c) => c.json({ data: { deleted: true as const }, meta }, 200),
  getCodexAuth: (c) =>
    c.json(
      {
        data: {
          status: "connected" as const,
          statusReason: null,
          lastValidatedAt: placeholderTime,
          lastRotatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  startCodexDeviceAuth: (c) =>
    c.json(
      {
        data: {
          flow: {
            id: "gcodf_contract",
            status: "code_ready" as const,
            userCode: "ABCD-1234",
            verificationUri: "https://auth.example.com/device",
            statusReason: null,
            expiresAt: placeholderTime,
          },
        },
        meta,
      },
      201,
    ),
  pollCodexDeviceAuth: (c) =>
    c.json(
      {
        data: {
          flow: {
            id: "gcodf_contract",
            status: "completed" as const,
            userCode: null,
            verificationUri: null,
            statusReason: null,
            expiresAt: placeholderTime,
          },
        },
        meta,
      },
      200,
    ),
  deleteCodexAuth: (c) => c.json({ data: { deleted: true as const }, meta }, 200),
  getInfisicalAuth: (c) =>
    c.json(
      {
        data: {
          status: "connected" as const,
          statusReason: null,
          accountEmail: "ops@example.com",
          host: "https://app.infisical.com",
          lastValidatedAt: placeholderTime,
        },
        meta,
      },
      200,
    ),
  startInfisicalAuth: (c) =>
    c.json(
      {
        data: {
          flow: {
            id: "ginff_contract",
            status: "link_ready" as const,
            loginUrl: "https://app.infisical.com/login?flow=contract",
            statusReason: null,
            expiresAt: placeholderTime,
          },
        },
        meta,
      },
      201,
    ),
  completeInfisicalAuth: (c) =>
    c.json(
      {
        data: {
          flow: {
            id: "ginff_contract",
            status: "completed" as const,
            loginUrl: null,
            statusReason: null,
            expiresAt: placeholderTime,
          },
        },
        meta,
      },
      200,
    ),
  deleteInfisicalAuth: (c) => c.json({ data: { deleted: true as const }, meta }, 200),
  getBillingOverview: (c) =>
    c.json(
      {
        data: {
          creditBalanceUsdMicros: 0,
          includedBalanceUsdMicros: 0,
          topUpBalanceUsdMicros: 0,
          plan: "hobby" as const,
          subscriptionStatus: null,
          seatQuantity: 0,
          includedUsagePeriodEnd: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          paymentNeedsAttention: false,
          proMonthlyPriceCents: 2_000,
          hobbyIncludedUsageCents: 100,
          memberCount: 1,
          memberCap: 1,
          spendThisMonthUsdMicros: 0,
          spendThisMonthByCategory: { chat: 0, ingestion: 0, capabilities: 0 },
          recentActivity: [],
          lowBalanceWarnUsdMicros: 1_000_000,
          includedUsagePerSeatCents: 2_000,
          topUpAmountsCents: [1_000],
          defaultTopUpCents: 1_000,
          minTopUpCents: 500,
          maxTopUpCents: 50_000,
          autoRefillMonthlyMaxCents: 50_000,
          autoRefill: {
            enabled: false,
            amountCents: 1_000,
            hasPaymentMethod: false,
            lastError: null,
          },
          isAdmin: true,
        },
        meta,
      },
      200,
    ),
  getBillingUsage: (c) =>
    c.json(
      {
        data: {
          breakdown: [],
          ingestedThisMonth: 0,
          pending: 0,
          creditBalanceUsdMicros: 0,
          providers: [],
          recent: [],
        },
        meta,
      },
      200,
    ),
  getBillingBalance: (c) =>
    c.json(
      {
        data: {
          balanceUsdMicros: 0,
          lowBalanceWarnUsdMicros: 1_000_000,
          enforcementEnabled: true,
        },
        meta,
      },
      200,
    ),
  createBillingTopUp: (c) =>
    c.json({ data: { redirectUrl: "https://checkout.stripe.com/session" }, meta }, 201),
  createBillingSubscriptionCheckout: (c) =>
    c.json({ data: { redirectUrl: "https://checkout.stripe.com/subscription" }, meta }, 201),
  createBillingPortalSession: (c) =>
    c.json({ data: { redirectUrl: "https://billing.stripe.com/session" }, meta }, 201),
  updateBillingAutoRefill: (c) => c.json({ data: { updated: true as const }, meta }, 200),
};

function contractIdentity() {
  return {
    user: {
      id: "user_contract",
      email: "owner@example.com",
      firstName: "Contract",
      lastName: "Owner",
      avatarUrl: null,
      timezone: "UTC",
      taskSpawningEnabled: true,
      autoModelRoutingEnabled: false,
      chatCapabilitiesBetaEnabled: false,
      imessageEnabled: false,
      wikiEnabled: true,
      taskViewMode: "board" as const,
      preferredMcpClient: null,
      mcpSetupCompletedAt: null,
      onboardedAt: placeholderTime,
      createdAt: placeholderTime,
      updatedAt: placeholderTime,
    },
    workspaces: [
      {
        id: "goat_ws_contract",
        name: "Contract Workspace",
        slug: "contract-workspace",
        role: "admin" as const,
      },
    ],
    activeWorkspaceId: "goat_ws_contract",
    brains: [
      {
        id: "brain_contract",
        workspaceId: "goat_ws_contract",
        name: "General",
        slug: "general",
        description: null,
        visibility: "workspace" as const,
        enrichmentEnabled: true,
        intelligence: "basic" as const,
      },
    ],
    activeBrainId: "brain_contract",
  };
}

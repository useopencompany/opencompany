import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  AutoModelRoutingError,
  type AutoModelRoutingResolution,
} from "@opencompany/agent/application/auto-model-routing";
import type { BrainImportApplicationService } from "@opencompany/agent/brain-imports";
import type { BrainSourceApplicationService } from "@opencompany/agent/brain-sources";
import type { BrowserProfileApplicationService } from "@opencompany/agent/browser-profiles/service";
import type {
  AttioProviderState,
  FathomProviderState,
  GranolaProviderState,
  ImessageProviderState,
  StripeProviderState,
} from "@opencompany/agent/integration-state";
import type { McpService } from "@opencompany/agent/mcp-http";
import type { BillingApplicationService } from "@opencompany/billing/application-service";
import {
  CHAT_PRESENTATION_READ_LIMIT,
  type ChatPresentationReader,
} from "@opencompany/chat-presentation";
import {
  type Actor,
  type BrainDocument,
  type BrainFolder,
  type BrainOverview,
  type BrainSourceItem,
  CHAT_ATTACHMENT_MAX_BYTES,
  type ChatApplicationService,
  CoreError,
  type KnowledgeApplicationService,
  type LegacyTask,
  type LegacyTaskHistory,
  type PluginImportApplicationService,
  publicPluginInstallation,
  type RunEvent,
  type SkillImportApplicationService,
  type SkillInstallation,
  type SkillInstallationListItem,
  type Task,
  type TaskApplicationService,
  type TaskSchedule,
  type TaskScheduleApplicationService,
  type WikiCommandApplicationService,
  type WikiPage,
  type WikiTimelineEntry,
  type Workflow,
  type WorkflowApplicationService,
} from "@opencompany/core";
import { captureException, createLogger, type LogFields } from "@opencompany/observability";
import {
  createOpenApiDocument,
  createV1Router,
  decodeEventCursor,
  decodePresentationCursor,
  encodeEventCursor,
  encodePresentationCursor,
  InternalWikiCommandRequestSchema,
  PROTOCOL_UPDATE_REQUIRED_MESSAGE,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  PresentationDeltaEventSchema,
  RunEventSchema,
  type V1RouteHandlers,
} from "@opencompany/protocol";
import { SPANS, withSpan } from "@opencompany/telemetry";
import { WIKI_READ_COMMANDS } from "@opencompany/wiki/tool";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { stream as streamResponse } from "hono/streaming";
import type { AttachmentUploadService } from "./attachments";
import type { AttioIngressService } from "./attio-ingress";
import type { ApiAuthenticator, ApiIdentity, ApiIdentityVerifier } from "./auth";
import type { BillingReconcileService } from "./billing-reconcile";
import type { BrainAssetService } from "./brain-assets";
import type { BrainControlService } from "./brain-control";
import type { ChatResourceDownload, ChatResourceService } from "./chat-resources";
import type { ChatTitleService } from "./chat-title";
import type { ReadModelService } from "./electric-read-models";
import type { EngineAuthService } from "./engine-auth";
import { admitEngineMessage } from "./engine-messages";
import type { EngineSessionService } from "./engine-sessions";
import { ApiError, errorResponse } from "./errors";
import type { FeedbackService } from "./feedback";
import type { GitHubIngressService } from "./github-ingress";
import type { GoogleIngressService } from "./google-ingress";
import type { HubspotIngressService } from "./hubspot-ingress";
import type { IdentityService } from "./identity";
import type { IntegrationAccountService } from "./integration-accounts";
import type { JamieIngressService } from "./jamie-ingress";
import type { LinearIngressService } from "./linear-ingress";
import type { McpOAuthIngressService } from "./mcp-oauth-ingress";
import type { OnboardingService } from "./onboarding";
import type { OnboardingEmailService } from "./onboarding-emails";
import { type ApiRateLimiter, InMemoryApiRateLimiter } from "./rate-limit";
import type { RepoConfigService } from "./repo-configs";
import { PollingRunEventNotifier, type RunEventNotifier } from "./run-event-notifier";
import type { SlackBotIngressService } from "./slack-bot-ingress";
import type { SlackBotSettingsService } from "./slack-bot-settings";
import type { SlackIngressService } from "./slack-ingress";
import type { StripeIngressService } from "./stripe-ingress";
import type { UserSettingsService } from "./user-settings";
import type { WikiSourceService } from "./wiki-sources";
import type { CapabilityApprovalView, WorkspaceCapabilityService } from "./workspace-capabilities";
import type { WorkspaceControlService } from "./workspace-control";
import type { XAccountIngressService } from "./x-account-ingress";

const logger = createLogger({ service: "opencompany-api", runtime: "hono" });
const meta = { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION } as const;
const EVENT_BATCH_SIZE = 100;
const EVENT_POLL_MS = 1_000;
const PRESENTATION_POLL_MS = 20;
const HEARTBEAT_MS = 15_000;
// A paused Run has reached an interaction boundary. Close this SSE response after the durable
// run.paused event so clients can present approvals, then reconnect after resolving them.
const TERMINAL_RUN_STATUSES = new Set(["paused", "completed", "failed", "canceled"]);
const MULTIPART_ENVELOPE_BYTES = 64 * 1024;
const SAFE_BROWSER_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CORS_ALLOW_HEADERS = [
  "Accept",
  "Content-Type",
  "Idempotency-Key",
  "Last-Event-ID",
  "X-OpenCompany-Protocol-Version",
];
const CORS_EXPOSE_HEADERS = [
  "Content-Disposition",
  "Electric-Cursor",
  "Electric-Handle",
  "Electric-Offset",
  "Electric-Schema",
  "Electric-Up-To-Date",
  "Retry-After",
  "X-OpenCompany-Run-Status",
  "X-Request-Id",
];
const ONBOARDING_IDENTITY_PATH = "/v1/onboarding";
const IDENTITY_PATH = "/v1/identity";
const REQUEST_FAILURE_LOG_FIELDS_KEY = "requestFailureLogFields";

export type CreateApiAppInput = {
  chat: ChatApplicationService;
  tasks: TaskApplicationService;
  workflows: WorkflowApplicationService;
  schedules: TaskScheduleApplicationService;
  knowledge: KnowledgeApplicationService;
  // Executes the `wiki` agent tool command contract for internal callers
  // (the runner over HTTP, the API-hosted MCP tool in-process).
  wikiCommands: WikiCommandApplicationService;
  // Reconstructs an Actor for the internal wiki command endpoint from the
  // caller-named tenancy; never trusts caller-supplied permissions.
  resolveWikiServiceActor: (input: { userWorkosId: string; workspaceId: string }) => Promise<Actor>;
  // Bearer secret for POST /internal/wiki/commands (runner→API). Distinct from
  // the runner's own internal token so the two directions rotate independently.
  wikiCommandsInternalSecret?: string;
  wikiSources: WikiSourceService;
  brainSources: Pick<BrainSourceApplicationService, "list" | "set" | "remove" | "listOptions">;
  brainImports: Pick<BrainImportApplicationService, "start" | "confirm" | "cancel" | "retry">;
  browserProfiles: Pick<
    BrowserProfileApplicationService,
    | "list"
    | "create"
    | "remove"
    | "createLoginSession"
    | "completeLoginSession"
    | "resolveLiveViewUrl"
  >;
  skillImports: SkillImportApplicationService;
  pluginImports: PluginImportApplicationService;
  brainAssets: BrainAssetService;
  chatResources?: ChatResourceService;
  chatTitles?: ChatTitleService;
  captureChatMessage?: (input: {
    actor: Actor;
    conversationId: string;
    firstMessage: boolean;
    engine: "opencompany" | "codex" | "claude_code";
    model: string;
    messageLength: number;
    selectionMode: "manual" | "auto";
    routing?: {
      tier: "standard" | "frontier";
      reason: string;
      outcome: string;
      durationMs: number;
    };
  }) => Promise<unknown> | unknown;
  brainControl: BrainControlService;
  attachments: AttachmentUploadService;
  userSettings: UserSettingsService;
  feedback: FeedbackService;
  repoConfigs: RepoConfigService;
  integrationAccounts: IntegrationAccountService;
  slackBotSettings: SlackBotSettingsService;
  mcp?: McpService;
  engineAuth: EngineAuthService;
  engineSessions: EngineSessionService;
  billing: BillingApplicationService;
  workspaceCapabilities: WorkspaceCapabilityService;
  workspaceControl: WorkspaceControlService;
  identity: IdentityService;
  onboarding: OnboardingService;
  onboardingEmails: OnboardingEmailService;
  authenticate: ApiAuthenticator;
  identify: ApiIdentityVerifier;
  emailLifecycleInternalSecret?: string;
  browserOrigins?: readonly string[];
  githubIngress?: GitHubIngressService;
  googleIngress?: GoogleIngressService;
  slackIngress?: SlackIngressService;
  linearIngress?: LinearIngressService;
  hubspotIngress?: HubspotIngressService;
  attioIngress?: AttioIngressService;
  jamieIngress?: JamieIngressService;
  mcpOAuthIngress?: McpOAuthIngressService;
  xAccountIngress?: XAccountIngressService;
  slackBotIngress?: SlackBotIngressService;
  stripeIngress?: StripeIngressService;
  billingReconcile?: BillingReconcileService;
  notifier?: RunEventNotifier;
  presentation?: ChatPresentationReader;
  shutdownSignal?: AbortSignal;
  rateLimiter?: ApiRateLimiter;
  defaultModel?: string;
  now?: () => Date;
  readModels?: ReadModelService;
  resolveAutoModel?: (input: {
    actorId: string;
    workspaceId: string;
    idempotencyKey: string;
    conversationId?: string;
    clientMessageId?: string;
    prompt: string;
    attachmentIds: readonly string[];
  }) => Promise<AutoModelRoutingResolution>;
};

export function createApiApp(input: CreateApiAppInput) {
  const notifier: RunEventNotifier = input.notifier ?? new PollingRunEventNotifier();
  const rateLimiter = input.rateLimiter ?? new InMemoryApiRateLimiter();
  const now = input.now ?? (() => new Date());
  const browserOrigins = [...(input.browserOrigins ?? [])];
  const handlers: V1RouteHandlers = {
    listTasks: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const query = c.req.valid("query");
      const page = await input.tasks.listTasks(actor, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
        archived: query.archived === "true",
      });
      return c.json({ data: page.tasks.map(taskDto), nextCursor: page.nextCursor, meta }, 200);
    },
    createTask: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const body = c.req.valid("json");
      const idempotencyKey = c.req.valid("header")["idempotency-key"];
      const requestedModel =
        body.model ??
        input.defaultModel ??
        process.env.OPENCOMPANY_DEFAULT_CHAT_MODEL ??
        "moonshotai/kimi-k3";
      let autoResolution: AutoModelRoutingResolution | null = null;
      if (requestedModel === "auto") {
        if (body.engine !== "opencompany") {
          throw new ApiError(
            400,
            "invalid_request",
            "Auto model routing is available only for opencompany Tasks.",
          );
        }
        if (!input.resolveAutoModel) {
          throw new ApiError(503, "unavailable", "Task model routing is not configured.", true);
        }
        try {
          autoResolution = await input.resolveAutoModel({
            actorId: actor.userId,
            workspaceId: actor.workspaceId,
            idempotencyKey,
            prompt: body.goal,
            attachmentIds: body.attachmentIds ?? [],
          });
        } catch (error) {
          throw autoRoutingApiError(error);
        }
        logger.info("Canonical Task model resolved", {
          event: "opencompany.canonical_task_model_resolved",
          source: autoResolution.source,
          selected_model: autoResolution.model,
        });
      }
      const result = await input.tasks.createTask(actor, {
        idempotencyKey,
        ...(body.name ? { name: body.name } : {}),
        goal: body.goal,
        engine: body.engine,
        model: autoResolution?.model ?? requestedModel,
        ...(body.attachmentIds ? { attachmentIds: body.attachmentIds } : {}),
        source: "manual",
      });
      return c.json(
        {
          data: {
            task: taskDto(result.task),
            messageId: result.messageId,
            assistantMessageId: result.assistantMessageId,
            runId: result.runId,
            transactionId: result.transactionId,
            replayed: result.idempotentReplay,
          },
          meta,
        },
        202,
      );
    },
    createTaskComment: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const { taskId } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await input.tasks.createComment(actor, taskId, body);
      if (!result.idempotentReplay && input.captureChatMessage) {
        void Promise.resolve(
          input.captureChatMessage({
            actor,
            conversationId: result.task.conversationId,
            firstMessage: false,
            engine: result.task.engine,
            model: result.task.model,
            messageLength: body.body.length,
            selectionMode: "manual",
          }),
        ).catch((error) =>
          logger.warn("Canonical Task comment analytics capture failed", {
            event: "opencompany.canonical_task_comment_analytics_failed",
            task_id: result.task.id,
            error_name: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
      return c.json(
        {
          data: {
            task: taskDto(result.task),
            comment: {
              id: result.comment.id,
              taskId: result.comment.taskId,
              author: "user" as const,
              kind: "comment" as const,
              body: result.comment.body,
              createdAt: result.comment.createdAt.toISOString(),
            },
            messageId: result.messageId,
            assistantMessageId: result.assistantMessageId,
            runId: result.runId,
            transactionId: result.transactionId,
            replayed: result.idempotentReplay,
          },
          meta,
        },
        202,
      );
    },
    getTask: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const task = await input.tasks.getTask(actor, c.req.valid("param").taskId);
      return c.json({ data: taskDto(task), meta }, 200);
    },
    updateTask: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.tasks.updateTask(
        actor,
        c.req.valid("param").taskId,
        c.req.valid("json"),
      );
      return c.json(
        { data: { task: taskDto(result.task), transactionId: result.transactionId }, meta },
        200,
      );
    },
    getTaskSummary: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const summary = await input.tasks.getTaskSummary(actor, c.req.valid("param").taskId);
      return c.json({ data: summary, meta }, 200);
    },
    listLegacyTasks: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const tasks = await input.tasks.listLegacyTasks(actor);
      return c.json({ data: tasks.map(legacyTaskDto), meta }, 200);
    },
    getLegacyTaskHistory: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const history = await input.tasks.getLegacyTaskHistory(actor, c.req.valid("param").taskId);
      return c.json({ data: legacyTaskHistoryDto(history), meta }, 200);
    },
    listWorkflows: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const query = c.req.valid("query");
      const page = await input.workflows.listWorkflows(actor, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      });
      return c.json(
        { data: page.workflows.map(workflowDto), nextCursor: page.nextCursor, meta },
        200,
      );
    },
    createWorkflow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const body = c.req.valid("json");
      const result = await input.workflows.createWorkflow(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
      return c.json(
        {
          data: {
            workflow: workflowDto(result.workflow),
            transactionId: result.transactionId,
            replayed: result.idempotentReplay,
          },
          meta,
        },
        201,
      );
    },
    getWorkflow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const workflow = await input.workflows.getWorkflow(actor, c.req.valid("param").workflowId);
      return c.json({ data: workflowDto(workflow), meta }, 200);
    },
    updateWorkflow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.workflows.updateWorkflow(
        actor,
        c.req.valid("param").workflowId,
        c.req.valid("json"),
      );
      return c.json(
        {
          data: { workflow: workflowDto(result.workflow), transactionId: result.transactionId },
          meta,
        },
        200,
      );
    },
    archiveWorkflow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.workflows.archiveWorkflow(
        actor,
        c.req.valid("param").workflowId,
        c.req.valid("json").expectedVersion,
      );
      return c.json({ data: result, meta }, 200);
    },
    invokeWorkflow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const body = c.req.valid("json");
      const result = await input.workflows.invokeWorkflow(actor, c.req.valid("param").workflowId, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        description: body.description,
        ...(body.attachmentIds ? { attachmentIds: body.attachmentIds } : {}),
        ...(body.skillIds ? { skillIds: body.skillIds } : {}),
      });
      return c.json({ data: taskCreationDto(result), meta }, 202);
    },
    runWorkflowNow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const result = await input.workflows.runWorkflowNow(
        actor,
        c.req.valid("param").workflowId,
        c.req.valid("header")["idempotency-key"],
      );
      return c.json({ data: taskCreationDto(result), meta }, 202);
    },
    listTaskSchedules: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const query = c.req.valid("query");
      const page = await input.schedules.listTaskSchedules(actor, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      });
      return c.json(
        { data: page.schedules.map(taskScheduleDto), nextCursor: page.nextCursor, meta },
        200,
      );
    },
    createTaskSchedule: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const body = c.req.valid("json");
      const result = await input.schedules.createTaskSchedule(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.sourceDescription !== undefined
          ? { sourceDescription: body.sourceDescription }
          : {}),
        cron: body.cron,
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        prompt: body.prompt,
      });
      return c.json(
        {
          data: {
            schedule: taskScheduleDto(result.schedule),
            transactionId: result.transactionId,
            replayed: result.idempotentReplay,
          },
          meta,
        },
        201,
      );
    },
    getTaskSchedule: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const schedule = await input.schedules.getTaskSchedule(
        actor,
        c.req.valid("param").scheduleId,
      );
      return c.json({ data: taskScheduleDto(schedule), meta }, 200);
    },
    updateTaskSchedule: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const body = c.req.valid("json");
      const scheduleId = c.req.valid("param").scheduleId;
      const result =
        "enabled" in body
          ? await input.schedules.setTaskScheduleEnabled(actor, scheduleId, body)
          : await input.schedules.updateTaskSchedule(actor, scheduleId, body);
      return c.json(
        {
          data: { schedule: taskScheduleDto(result.schedule), transactionId: result.transactionId },
          meta,
        },
        200,
      );
    },
    archiveTaskSchedule: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.schedules.archiveTaskSchedule(
        actor,
        c.req.valid("param").scheduleId,
        c.req.valid("json").expectedVersion,
      );
      return c.json({ data: result, meta }, 200);
    },
    runTaskScheduleNow: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const result = await input.schedules.runTaskScheduleNow(
        actor,
        c.req.valid("param").scheduleId,
        c.req.valid("header")["idempotency-key"],
      );
      return c.json({ data: taskCreationDto(result), meta }, 202);
    },
    getBrainSnapshot: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const snapshot = await input.knowledge.getBrainSnapshot(actor, c.req.valid("param").brainId);
      return c.json(
        {
          data: {
            folders: snapshot.folders.map(brainFolderDto),
            documents: snapshot.documents.map(brainDocumentDto),
          },
          meta,
        },
        200,
      );
    },
    getBrainOverview: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const overview = await input.knowledge.getBrainOverview(actor, c.req.valid("param").brainId);
      return c.json({ data: brainOverviewDto(overview), meta }, 200);
    },
    listBrainSourceItems: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const sourceItems = await input.knowledge.listBrainSourceItems(
        actor,
        c.req.valid("param").brainId,
        c.req.valid("query").ids,
      );
      return c.json({ data: sourceItems.map(brainSourceItemDto), meta }, 200);
    },
    listBrainSources: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const details = await input.brainSources.list(actor, c.req.valid("param").brainId);
      return c.json({ data: details, meta }, 200);
    },
    setBrainSource: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const command = c.req.valid("json");
      await input.brainSources.set(actor, params.brainId, params.integrationId, command);
      return c.json(
        {
          data: {
            brainId: params.brainId,
            integrationId: params.integrationId,
            provider: command.provider,
            enabled: command.enabled,
          },
          meta,
        },
        200,
      );
    },
    deleteBrainSource: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      await input.brainSources.remove(actor, params.brainId, params.integrationId);
      return c.json(
        {
          data: { brainId: params.brainId, integrationId: params.integrationId, deleted: true },
          meta,
        },
        200,
      );
    },
    listBrainSourceOptions: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 120);
      const options = await input.brainSources.listOptions(
        actor,
        c.req.valid("param").integrationId,
        c.req.valid("json"),
      );
      return c.json({ data: options, meta }, 200);
    },
    listBrowserProfiles: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const profiles = await input.browserProfiles.list(actor);
      return c.json({ data: profiles, meta }, 200);
    },
    createBrowserProfile: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 20);
      const profile = await input.browserProfiles.create(actor, c.req.valid("json"));
      return c.json({ data: profile, meta }, 201);
    },
    deleteBrowserProfile: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const { profileId } = c.req.valid("param");
      await input.browserProfiles.remove(actor, profileId);
      return c.json({ data: { profileId, deleted: true as const }, meta }, 200);
    },
    createBrowserProfileLoginSession: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 30);
      const { profileId } = c.req.valid("param");
      const session = await input.browserProfiles.createLoginSession(actor, profileId);
      return c.json(
        {
          data: {
            profileId,
            sessionId: session.sessionId,
            liveViewUrl: session.liveViewUrl,
          },
          meta,
        },
        201,
      );
    },
    completeBrowserProfileLogin: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const { profileId, sessionId } = c.req.valid("param");
      await input.browserProfiles.completeLoginSession(actor, profileId, sessionId);
      return c.json({ data: { profileId, sessionId, completed: true as const }, meta }, 200);
    },
    getBrowserProfileLiveView: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 120);
      const { profileId } = c.req.valid("param");
      const { sessionId } = c.req.valid("query");
      const url = await input.browserProfiles.resolveLiveViewUrl(actor, profileId, sessionId);
      return c.json({ data: { url }, meta }, 200);
    },
    getWorkspaceCapabilities: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const settings = await input.workspaceCapabilities.getSettings(actor);
      return c.json({ data: settings, meta }, 200);
    },
    setCapabilitySessionBudget: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const sessionBudgetUsdMicros = await input.workspaceCapabilities.setSessionBudget(
        actor,
        c.req.valid("json").budgetUsd,
      );
      return c.json({ data: { sessionBudgetUsdMicros }, meta }, 200);
    },
    setWorkspaceCapability: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const capability = await input.workspaceCapabilities.setCapability(
        actor,
        c.req.valid("param").source,
        c.req.valid("json").enabled,
      );
      return c.json({ data: capability, meta }, 200);
    },
    getCapabilityApprovalByToolCall: async (c) => {
      const actor = actorFrom(c);
      // Chat polls this resource while an approval card is visible, so it gets
      // a dedicated read bucket instead of competing with ordinary RSC reads.
      await enforceRateLimit(rateLimiter, actor, "capability-approval-read", 300);
      const approval = await input.workspaceCapabilities.getApprovalByToolCall(
        actor,
        c.req.valid("param").toolCallId,
      );
      return c.json({ data: capabilityApprovalDto(approval), meta }, 200);
    },
    getCapabilityApproval: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "capability-approval-read", 300);
      const approval = await input.workspaceCapabilities.getApproval(
        actor,
        c.req.valid("param").runId,
      );
      return c.json({ data: capabilityApprovalDto(approval), meta }, 200);
    },
    createBrain: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.brainControl.createBrain(actor, c.req.valid("json"));
      return c.json({ data: result, meta }, 201);
    },
    switchBrain: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.brainControl.switchBrain(actor, c.req.valid("param").brainId);
      return c.json({ data: result, meta }, 200);
    },
    getBrainAccess: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const access = await input.brainControl.getAccess(actor, c.req.valid("param").brainId);
      return c.json({ data: access, meta }, 200);
    },
    setBrainAccess: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.brainControl.setAccess(actor, c.req.valid("param").brainId, c.req.valid("json"));
      return c.json({ data: { updated: true as const }, meta }, 200);
    },
    getBrainEnrichment: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const setting = await input.brainControl.getEnrichment(actor, c.req.valid("param").brainId);
      return c.json({ data: setting, meta }, 200);
    },
    setBrainEnrichment: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const { brainId } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      await input.brainControl.setEnrichment(actor, brainId, enabled);
      return c.json({ data: { enabled }, meta }, 200);
    },
    getBrainIntelligence: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const setting = await input.brainControl.getIntelligence(actor, c.req.valid("param").brainId);
      return c.json({ data: setting, meta }, 200);
    },
    setBrainIntelligence: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const { brainId } = c.req.valid("param");
      const { intelligence } = c.req.valid("json");
      await input.brainControl.setIntelligence(actor, brainId, intelligence);
      return c.json({ data: { intelligence }, meta }, 200);
    },
    getIdentity: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "identity-read", 300);
      return c.json({ data: await input.identity.get(identity), meta }, 200);
    },
    syncIdentity: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "identity-sync", 30);
      return c.json({ data: await input.identity.sync(identity), meta }, 200);
    },
    getWorkspaceSettings: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const settings = await input.workspaceControl.getSettings(actor);
      return c.json({ data: settings, meta }, 200);
    },
    renameWorkspace: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const workspace = await input.workspaceControl.rename(actor, c.req.valid("json").name);
      return c.json({ data: workspace, meta }, 200);
    },
    inviteWorkspaceMember: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "workspace-invitation", 20);
      await input.workspaceControl.invite(actor, c.req.valid("json").email);
      return c.json({ data: { completed: true as const }, meta }, 201);
    },
    revokeWorkspaceInvitation: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.workspaceControl.revokeInvitation(actor, c.req.valid("param").invitationId);
      return c.json({ data: { completed: true as const }, meta }, 200);
    },
    removeWorkspaceMember: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.workspaceControl.removeMember(actor, c.req.valid("param").userId);
      return c.json({ data: { completed: true as const }, meta }, 200);
    },
    createWorkspace: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "workspace-create", 5);
      const activation = await input.workspaceControl.create(actor, c.req.valid("json"));
      return c.json({ data: activation, meta }, 201);
    },
    switchWorkspace: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const activation = await input.workspaceControl.switch(
        actor,
        c.req.valid("param").workspaceId,
      );
      return c.json({ data: activation, meta }, 200);
    },
    getOnboardingState: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "onboarding-read", 300);
      const state = await input.onboarding.getState(identity);
      return c.json({ data: state, meta }, 200);
    },
    checkOnboardingWorkspaceSlug: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "onboarding-slug", 120);
      const result = await input.onboarding.checkSlug(identity, c.req.valid("json").slug);
      return c.json({ data: result, meta }, 200);
    },
    saveOnboardingProfile: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "onboarding-write", 30);
      await input.onboarding.saveProfile(identity, c.req.valid("json"));
      return c.json({ data: { completed: true as const }, meta }, 200);
    },
    saveOnboardingWorkspace: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "onboarding-workspace", 10);
      const workspace = await input.onboarding.saveWorkspace(identity, c.req.valid("json"));
      return c.json({ data: workspace, meta }, 200);
    },
    finishOnboarding: async (c) => {
      const identity = identityFrom(c);
      await enforceIdentityRateLimit(rateLimiter, identity, "onboarding-write", 30);
      await input.onboarding.finish(identity, c.req.valid("json").referralSource);
      return c.json({ data: { completed: true as const }, meta }, 200);
    },
    startBrainImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const result = await input.brainImports.start(actor, c.req.valid("param").brainId, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: {
            importRunId: result.importRunId,
            status: result.status,
            replayed: result.replayed,
          },
          meta,
        },
        201,
      );
    },
    confirmBrainImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const result = await input.brainImports.confirm(
        actor,
        params.brainId,
        params.importRunId,
        c.req.valid("json").enabledProviders,
      );
      return c.json(
        {
          data: {
            importRunId: result.importRunId,
            status: result.status,
            replayed: result.replayed,
          },
          meta,
        },
        200,
      );
    },
    cancelBrainImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const result = await input.brainImports.cancel(actor, params.brainId, params.importRunId);
      return c.json(
        {
          data: {
            importRunId: result.importRunId,
            status: result.status,
            replayed: result.replayed,
          },
          meta,
        },
        200,
      );
    },
    retryBrainImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const result = await input.brainImports.retry(actor, params.brainId, params.importRunId);
      return c.json(
        {
          data: {
            importRunId: result.importRunId,
            status: result.status,
            replayed: result.replayed,
          },
          meta,
        },
        200,
      );
    },
    createBrainDocument: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const document = await input.knowledge.createBrainDocument(
        actor,
        c.req.valid("param").brainId,
        {
          idempotencyKey: c.req.valid("header")["idempotency-key"],
          ...c.req.valid("json"),
        },
      );
      return c.json({ data: brainDocumentDto(document), meta }, 201);
    },
    uploadBrainAsset: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 30);
      const params = c.req.valid("param");
      const form = c.req.valid("form");
      const result = await input.brainAssets.upload({
        actor,
        brainId: params.brainId,
        folderPath: form.folderPath,
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        file: form.file,
      });
      return c.json(
        {
          data: {
            document: brainDocumentDto(result.document),
            quotaPaused: result.quotaPaused,
            replayed: result.replayed,
          },
          meta,
        },
        201,
      );
    },
    replaceBrainAsset: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 30);
      const params = c.req.valid("param");
      const result = await input.brainAssets.replace({
        actor,
        brainId: params.brainId,
        documentId: params.documentId,
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        file: c.req.valid("form").file,
      });
      return c.json(
        {
          data: {
            document: brainDocumentDto(result.document),
            quotaPaused: result.quotaPaused,
            replayed: result.replayed,
          },
          meta,
        },
        200,
      );
    },
    downloadBrainAsset: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const asset = await input.brainAssets.download({
        actor,
        documentId: c.req.valid("param").documentId,
      });
      const headers = new Headers({
        "Content-Type": asset.mediaType,
        "Content-Disposition": contentDisposition(asset.filename),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (asset.sizeBytes !== null) headers.set("Content-Length", String(asset.sizeBytes));
      return new Response(asset.stream, {
        status: 200,
        headers,
      }) as never;
    },
    updateBrainDocument: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const document = await input.knowledge.updateBrainDocument(
        actor,
        params.brainId,
        params.documentId,
        c.req.valid("json"),
      );
      return c.json({ data: brainDocumentDto(document), meta }, 200);
    },
    renameBrainDocument: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const document = await input.knowledge.renameBrainDocument(
        actor,
        params.brainId,
        params.documentId,
        c.req.valid("json"),
      );
      return c.json({ data: brainDocumentDto(document), meta }, 200);
    },
    deleteBrainDocument: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      await input.knowledge.deleteBrainDocument(actor, params.brainId, params.documentId);
      return c.json({ data: { documentId: params.documentId }, meta }, 200);
    },
    createBrainFolder: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const folder = await input.knowledge.createBrainFolder(
        actor,
        c.req.valid("param").brainId,
        c.req.valid("json"),
      );
      return c.json({ data: brainFolderDto(folder), meta }, 201);
    },
    renameBrainFolder: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.knowledge.renameBrainFolder(
        actor,
        c.req.valid("param").brainId,
        c.req.valid("json"),
      );
      return c.json({ data: result, meta }, 200);
    },
    deleteBrainFolder: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      await input.knowledge.deleteBrainFolder(actor, params.brainId, body);
      return c.json({ data: { path: body.path }, meta }, 200);
    },
    listWikiPages: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const pages = await input.knowledge.listWikiPages(actor);
      return c.json({ data: pages.map(wikiPageDto), meta }, 200);
    },
    createWikiPage: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.knowledge.createWikiPage(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: { page: wikiPageDto(result.page), transactionIds: result.transactionIds },
          meta,
        },
        201,
      );
    },
    updateWikiPage: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.knowledge.updateWikiPage(
        actor,
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(
        {
          data: { page: wikiPageDto(result.page), transactionIds: result.transactionIds },
          meta,
        },
        200,
      );
    },
    deleteWikiPage: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.knowledge.deleteWikiPage(actor, {
        id: c.req.valid("param").id,
        ...c.req.valid("json"),
      });
      return c.json({ data: result, meta }, 200);
    },
    addWikiTimelineEntry: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.knowledge.addWikiTimelineEntry(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        id: c.req.valid("param").id,
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: {
            entry: wikiTimelineEntryDto(result.entry),
            transactionId: result.transactionId,
          },
          meta,
        },
        201,
      );
    },
    listWikiSources: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const sources = await input.wikiSources.list(actor);
      return c.json({ data: sources, meta }, 200);
    },
    listWikiIngestActivity: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const query = c.req.valid("query");
      const activity = await input.wikiSources.listActivity(actor, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return c.json({ data: activity, meta }, 200);
    },
    upsertWikiSource: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const source = await input.wikiSources.upsert(actor, c.req.valid("json"));
      return c.json({ data: source, meta }, 200);
    },
    setWikiSourceEnabled: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const source = await input.wikiSources.setEnabled(
        actor,
        c.req.valid("param").sourceId,
        c.req.valid("json").enabled,
      );
      return c.json({ data: source, meta }, 200);
    },
    deleteWikiSource: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const { sourceId } = c.req.valid("param");
      await input.wikiSources.remove(actor, sourceId);
      return c.json({ data: { sourceId, deleted: true }, meta }, 200);
    },
    listSkills: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const installations = await input.skillImports.list(actor);
      return c.json({ data: installations.map(skillInstallationListItemDto), meta }, 200);
    },
    createWorkspaceSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const result = await input.skillImports.create(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: {
            installation: skillInstallationDto(result.installation),
            replayed: result.idempotentReplay,
          },
          meta,
        },
        201,
      );
    },
    previewSkillImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const preview = await input.skillImports.preview(actor, c.req.valid("json"));
      return c.json({ data: preview, meta }, 200);
    },
    importSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const result = await input.skillImports.install(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: {
            installation: skillInstallationDto(result.installation),
            replayed: result.idempotentReplay,
          },
          meta,
        },
        201,
      );
    },
    listSkillCatalog: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      return c.json({ data: await input.skillImports.listCatalog(actor), meta }, 200);
    },
    getSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const installation = await input.skillImports.inspect(actor, c.req.valid("param").slug);
      return c.json({ data: skillInstallationDto(installation), meta }, 200);
    },
    updateWorkspaceSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const installation = await input.skillImports.update(
        actor,
        c.req.valid("param").slug,
        c.req.valid("json"),
      );
      return c.json({ data: skillInstallationDto(installation), meta }, 200);
    },
    archiveSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const name = c.req.valid("param").slug;
      await input.skillImports.archive(actor, name);
      return c.json({ data: { name }, meta }, 200);
    },
    enableSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const installation = await input.skillImports.setEnabled(
        actor,
        c.req.valid("param").slug,
        true,
      );
      return c.json({ data: skillInstallationDto(installation), meta }, 200);
    },
    disableSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const installation = await input.skillImports.setEnabled(
        actor,
        c.req.valid("param").slug,
        false,
      );
      return c.json({ data: skillInstallationDto(installation), meta }, 200);
    },
    replaceSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const installation = await input.skillImports.replace(
        actor,
        c.req.valid("param").slug,
        c.req.valid("json"),
      );
      return c.json({ data: skillInstallationDto(installation), meta }, 200);
    },
    readSkillFile: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const query = c.req.valid("query");
      const chunk = await input.skillImports.readFile(actor, c.req.valid("param").slug, {
        path: query.path,
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.maxBytes !== undefined ? { maxBytes: query.maxBytes } : {}),
      });
      return c.json({ data: chunk, meta }, 200);
    },
    listPlugins: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      return c.json({ data: await input.pluginImports.list(actor), meta }, 200);
    },
    previewPluginImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const preview = await input.pluginImports.preview(actor, c.req.valid("json"));
      return c.json({ data: preview, meta }, 200);
    },
    importPlugin: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const result = await input.pluginImports.install(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: {
            plugin: publicPluginInstallation(result.plugin),
            replayed: result.idempotentReplay,
          },
          meta,
        },
        201,
      );
    },
    getPlugin: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const plugin = await input.pluginImports.inspect(actor, c.req.valid("param").name);
      return c.json({ data: publicPluginInstallation(plugin), meta }, 200);
    },
    archivePlugin: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const name = c.req.valid("param").name;
      await input.pluginImports.archive(actor, name);
      return c.json({ data: { name }, meta }, 200);
    },
    enablePlugin: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const plugin = await input.pluginImports.setEnabled(actor, c.req.valid("param").name, true);
      return c.json({ data: publicPluginInstallation(plugin), meta }, 200);
    },
    disablePlugin: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const plugin = await input.pluginImports.setEnabled(actor, c.req.valid("param").name, false);
      return c.json({ data: publicPluginInstallation(plugin), meta }, 200);
    },
    approvePluginMcp: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const plugin = await input.pluginImports.approveMcp(
        actor,
        c.req.valid("param").name,
        c.req.valid("json").integrity,
      );
      return c.json({ data: publicPluginInstallation(plugin), meta }, 200);
    },
    revokePluginMcp: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const plugin = await input.pluginImports.revokeMcp(actor, c.req.valid("param").name);
      return c.json({ data: publicPluginInstallation(plugin), meta }, 200);
    },
    deletePluginData: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const name = c.req.valid("param").name;
      const result = await input.pluginImports.deleteData(actor, name);
      return c.json({ data: { name, deleted: result.deleted }, meta }, 200);
    },
    listConversations: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const query = c.req.valid("query");
      const page = await input.chat.listConversations(actor, query);
      return c.json(
        {
          data: page.conversations.map(conversationDto),
          nextCursor: page.nextCursor,
          meta,
        },
        200,
      );
    },
    getConversation: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const conversation = await input.chat.getConversation(
        actor,
        c.req.valid("param").conversationId,
      );
      return c.json({ data: conversationDto(conversation), meta }, 200);
    },
    updateConversation: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.chat.updateConversation(
        actor,
        c.req.valid("param").conversationId,
        c.req.valid("json"),
      );
      return c.json({ data: result, meta }, 200);
    },
    getConversationShare: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const conversationId = c.req.valid("param").conversationId;
      await authorizeConversationRead(input, actor, conversationId);
      const shareId = await chatResourcesFrom(input).findShare(actor, conversationId);
      return c.json({ data: { conversationId, shareId }, meta }, 200);
    },
    createConversationShare: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "share", 30);
      const conversationId = c.req.valid("param").conversationId;
      await authorizeConversationRead(input, actor, conversationId);
      const shareId = await chatResourcesFrom(input).ensureShare(actor, conversationId);
      return c.json({ data: { conversationId, shareId }, meta }, 200);
    },
    deleteConversationShare: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "share", 30);
      const conversationId = c.req.valid("param").conversationId;
      await authorizeConversationRead(input, actor, conversationId);
      await chatResourcesFrom(input).revokeShare(actor, conversationId);
      return c.json({ data: { conversationId, shareId: null }, meta }, 200);
    },
    generateConversationTitle: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "title", 30);
      const conversationId = c.req.valid("param").conversationId;
      await authorizeConversationRead(input, actor, conversationId);
      const result = await chatTitlesFrom(input).generate(
        actor,
        conversationId,
        c.req.valid("json").messageId,
      );
      return c.json({ data: result, meta }, 200);
    },
    listMessages: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const params = c.req.valid("param");
      const page = await input.chat.listMessages(actor, {
        conversationId: params.conversationId,
        ...c.req.valid("query"),
      });
      return c.json(
        { data: page.messages.map(messageDto), nextCursor: page.nextCursor, meta },
        200,
      );
    },
    createMessage: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const body = c.req.valid("json");
      setRequestFailureLogFields(c, {
        operation: "message.create",
        message_target: body.conversationId ? "existing" : "new",
        engine: body.engine.type,
        ...(body.conversationId ? { conversation_id: body.conversationId } : {}),
      });
      const idempotencyKey = c.req.valid("header")["idempotency-key"];
      const existingTarget = body.conversationId
        ? await getConversationOrTask(input, actor, body.conversationId)
        : null;
      setRequestFailureLogFields(c, {
        target_resource: existingTarget
          ? "conversationId" in existingTarget
            ? "task"
            : "chat"
          : "new_chat",
      });
      if (existingTarget && existingTarget.engine !== body.engine.type) {
        throw new ApiError(409, "conflict", "This conversation uses a different engine.");
      }
      const requestedModel =
        body.model ??
        existingTarget?.model ??
        input.defaultModel ??
        process.env.OPENCOMPANY_DEFAULT_CHAT_MODEL ??
        "moonshotai/kimi-k3";
      let autoResolution: AutoModelRoutingResolution | null = null;
      if (requestedModel === "auto") {
        if (body.engine.type !== "opencompany") {
          throw new ApiError(
            400,
            "invalid_request",
            "Auto model routing is available only for opencompany Chat.",
          );
        }
        if (!input.resolveAutoModel) {
          throw new ApiError(503, "unavailable", "Chat model routing is not configured.", true);
        }
        try {
          autoResolution = await input.resolveAutoModel({
            actorId: actor.userId,
            workspaceId: actor.workspaceId,
            idempotencyKey,
            ...(body.conversationId ? { conversationId: body.conversationId } : {}),
            ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
            prompt: body.content,
            attachmentIds: body.attachmentIds ?? [],
          });
        } catch (error) {
          throw autoRoutingApiError(error);
        }
        logger.info("Canonical Chat model resolved", {
          event: "opencompany.canonical_chat_model_resolved",
          source: autoResolution.source,
          selected_model: autoResolution.model,
          ...(autoResolution.routing
            ? {
                tier: autoResolution.routing.tier,
                reason: autoResolution.routing.reason,
                outcome: autoResolution.routing.classifier.outcome,
                duration_ms: autoResolution.routing.classifier.durationMs,
              }
            : {}),
        });
      }
      const admitted = await admitEngineMessage({
        actor,
        engine: body.engine,
        model: autoResolution?.model ?? requestedModel,
        defaultProductModel:
          input.defaultModel ?? process.env.OPENCOMPANY_DEFAULT_CHAT_MODEL ?? "moonshotai/kimi-k3",
        auth: input.engineAuth,
      });
      const { engine: _engine, model: _model, ...message } = body;
      const result = await input.chat.createMessage(actor, {
        ...message,
        idempotencyKey,
        engine: admitted.engine,
        model: admitted.model,
        runtimeModel: admitted.runtimeModel,
        ...(admitted.settings ? { settings: admitted.settings } : {}),
      });
      if (!result.idempotentReplay && !existingTarget && input.chatTitles) {
        void input.chatTitles
          .generate(actor, result.conversationId, result.messageId)
          .catch((error) =>
            logger.warn("Canonical Chat title generation failed", {
              event: "opencompany.chat_title_generation_failed",
              conversation_id: result.conversationId,
              error_name: error instanceof Error ? error.name : typeof error,
            }),
          );
      }
      if (!result.idempotentReplay && input.captureChatMessage) {
        void Promise.resolve(
          input.captureChatMessage({
            actor,
            conversationId: result.conversationId,
            firstMessage: !existingTarget,
            engine: admitted.engine,
            model: admitted.model,
            messageLength: body.content.length,
            selectionMode: requestedModel === "auto" ? "auto" : "manual",
            ...(autoResolution?.routing
              ? {
                  routing: {
                    tier: autoResolution.routing.tier === "frontier" ? "frontier" : "standard",
                    reason: autoResolution.routing.reason,
                    outcome: autoResolution.routing.classifier.outcome,
                    durationMs: autoResolution.routing.classifier.durationMs,
                  },
                }
              : {}),
          }),
        ).catch((error) =>
          logger.warn("Canonical Chat analytics capture failed", {
            event: "opencompany.chat_analytics_capture_failed",
            conversation_id: result.conversationId,
            error_name: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
      return c.json(
        {
          data: {
            conversationId: result.conversationId,
            messageId: result.messageId,
            assistantMessageId: result.assistantMessageId,
            runId: result.runId,
            transactionId: result.transactionId,
            replayed: result.idempotentReplay,
            ...(autoResolution ? { model: autoResolution.model } : {}),
          },
          meta,
        },
        202,
      );
    },
    uploadAttachment: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "attachment", 20);
      const file = c.req.valid("form").file;
      if (!(file instanceof File)) {
        throw new ApiError(400, "invalid_request", "A file upload is required.");
      }
      const upload = await input.attachments.upload({ actor, file });
      return c.json(
        {
          data: {
            attachment: {
              id: upload.id,
              filename: upload.filename,
              mediaType: upload.mediaType,
              sizeBytes: upload.sizeBytes,
              kind: upload.format === "image" ? ("image" as const) : ("document" as const),
            },
            expiresAt: upload.expiresAt.toISOString(),
          },
          meta,
        },
        201,
      );
    },
    deleteChatArtifact: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const artifactId = c.req.valid("param").artifactId;
      await chatResourcesFrom(input).deleteArtifact(actor, artifactId);
      return c.json({ data: { artifactId, state: "deleted" as const }, meta }, 200);
    },
    downloadChatArtifact: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const params = c.req.valid("param");
      const download = c.req.valid("query").download === "1";
      const asset = await chatResourcesFrom(input).downloadArtifact({ actor, ...params, download });
      return chatResourceResponse(asset) as never;
    },
    downloadChatAttachment: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const asset = await chatResourcesFrom(input).downloadAttachment({
        actor,
        ...c.req.valid("param"),
      });
      return chatResourceResponse(asset) as never;
    },
    downloadChatScreenshot: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const asset = await chatResourcesFrom(input).downloadScreenshot({
        actor,
        ...c.req.valid("param"),
      });
      return chatResourceResponse(asset) as never;
    },
    getPublicChatShare: async (c) => {
      const shareId = c.req.valid("param").shareId;
      await enforcePublicRateLimit(rateLimiter, shareId, "public-share-read", 300);
      const share = await chatResourcesFrom(input).loadPublicShare(shareId);
      c.header("Cache-Control", "private, no-store");
      c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
      return c.json({ data: share, meta }, 200);
    },
    getPublicChatShareMetadata: async (c) => {
      const shareId = c.req.valid("param").shareId;
      await enforcePublicRateLimit(rateLimiter, shareId, "public-share-read", 300);
      const share = await chatResourcesFrom(input).loadPublicShareMetadata(shareId);
      c.header("Cache-Control", "private, no-store");
      c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
      return c.json({ data: share, meta }, 200);
    },
    downloadPublicChatAttachment: async (c) => {
      const params = c.req.valid("param");
      await enforcePublicRateLimit(rateLimiter, params.shareId, "public-share-bytes", 600);
      const asset = await chatResourcesFrom(input).downloadPublicAttachment(params);
      return chatResourceResponse(asset) as never;
    },
    downloadPublicChatArtifact: async (c) => {
      const params = c.req.valid("param");
      await enforcePublicRateLimit(rateLimiter, params.shareId, "public-share-bytes", 600);
      const asset = await chatResourcesFrom(input).downloadPublicArtifact({
        ...params,
        download: c.req.valid("query").download === "1",
      });
      return chatResourceResponse(asset) as never;
    },
    getEngineRuntimeStatus: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const conversationId = c.req.valid("param").conversationId;
      const status = await input.engineSessions.getRuntimeStatus(actor, conversationId);
      return c.json({ data: { conversationId, status }, meta }, 200);
    },
    createEngineRuntimeAccess: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "engine-runtime-access", 30);
      const conversationId = c.req.valid("param").conversationId;
      const access = await input.engineSessions.createRuntimeAccess(actor, conversationId);
      return c.json({ data: access, meta }, 201);
    },
    getRun: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const run = await input.chat.getRun(actor, c.req.valid("param").runId);
      return c.json({ data: runDto(run), meta }, 200);
    },
    streamRunEvents: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "stream", 60);
      const runId = c.req.valid("param").runId;
      const queryCursor = c.req.valid("query").cursor;
      const queryPresentationCursor = c.req.valid("query").presentationCursor;
      const headerCursor = c.req.valid("header")["last-event-id"];
      if (queryCursor && headerCursor && queryCursor !== headerCursor) {
        throw new ApiError(400, "invalid_request", "Conflicting event cursors were provided.");
      }
      let sequence: number;
      let presentationStreamId: string | undefined;
      try {
        sequence = decodeEventCursor(queryCursor ?? headerCursor);
        presentationStreamId = queryPresentationCursor
          ? decodePresentationCursor(queryPresentationCursor)
          : undefined;
      } catch {
        throw new ApiError(400, "invalid_request", "The event cursor is invalid.");
      }
      const initialRun = await input.chat.getRun(actor, runId);
      // A cursor may already point at the final durable event. In that case the response body is
      // intentionally empty, so the shared client needs the authenticated status snapshot to
      // distinguish terminal exhaustion from an early network disconnect.
      c.header("X-OpenCompany-Run-Status", initialRun.status);
      c.header("Content-Type", "text/event-stream; charset=utf-8");
      c.header("Cache-Control", "private, no-store, no-transform");
      return streamResponse(c, async (stream) => {
        const streamSignal = input.shutdownSignal
          ? AbortSignal.any([c.req.raw.signal, input.shutdownSignal])
          : c.req.raw.signal;
        let lastHeartbeatAt = now().getTime();
        let nextDurablePollAt = 0;
        let durableWake = true;
        let currentAttemptNumber = initialRun.attemptCount;
        try {
          while (!stream.aborted && !streamSignal.aborted) {
            const currentTime = now().getTime();
            if (durableWake || currentTime >= nextDurablePollAt) {
              const page = await input.chat.listRunEvents(actor, {
                runId,
                afterSequence: sequence,
                limit: EVENT_BATCH_SIZE,
              });
              for (const event of page.events) {
                const dto = runEventDto(event);
                await writeSse(stream, {
                  id: dto.cursor,
                  event: dto.type,
                  data: JSON.stringify(dto),
                });
                sequence = event.sequence;
              }
              if (page.events.length >= EVENT_BATCH_SIZE) {
                durableWake = true;
                continue;
              }
              const run = await input.chat.getRun(actor, runId);
              currentAttemptNumber = run.attemptCount;
              if (TERMINAL_RUN_STATUSES.has(run.status)) return;
              durableWake = false;
              nextDurablePollAt = currentTime + EVENT_POLL_MS;
            }
            if (input.presentation) {
              const hot = await input.presentation.read({
                runId,
                ...(presentationStreamId ? { afterStreamId: presentationStreamId } : {}),
                limit: CHAT_PRESENTATION_READ_LIMIT,
              });
              let sawFutureAttempt = false;
              for (const entry of hot.entries) {
                if (entry.frame.attemptNumber < currentAttemptNumber) {
                  presentationStreamId = entry.streamId;
                  continue;
                }
                if (entry.frame.attemptNumber > currentAttemptNumber) {
                  sawFutureAttempt = true;
                  durableWake = true;
                  break;
                }
                const dto = PresentationDeltaEventSchema.parse({
                  ...entry.frame,
                  presentationCursor: encodePresentationCursor(entry.streamId),
                });
                await writeSse(stream, { event: dto.type, data: JSON.stringify(dto) });
                presentationStreamId = entry.streamId;
              }
              if (!sawFutureAttempt && hot.entries.length === 0 && hot.nextStreamId) {
                presentationStreamId = hot.nextStreamId;
              }
              if (hot.entries.length >= CHAT_PRESENTATION_READ_LIMIT) continue;
            }
            if (currentTime - lastHeartbeatAt >= HEARTBEAT_MS) {
              await stream.write(": keep-alive\n\n");
              lastHeartbeatAt = currentTime;
            }
            durableWake = await notifier.wait({
              runId,
              signal: streamSignal,
              timeoutMs: input.presentation ? PRESENTATION_POLL_MS : EVENT_POLL_MS,
            });
          }
        } catch (error) {
          captureException(error, {
            event: "opencompany.api_run_event_stream_failed",
            run_id: runId,
          });
        }
      });
    },
    cancelRun: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const result = await input.chat.cancelRun(actor, c.req.valid("param").runId);
      return c.json(
        {
          data: {
            runId: result.runId,
            status: result.status,
            replayed: result.idempotentReplay,
          },
          meta,
        },
        202,
      );
    },
    resolveApproval: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "message", 30);
      const params = c.req.valid("param");
      const result = await input.chat.resolveApproval(actor, {
        runId: params.runId,
        approvalId: params.approvalId,
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: {
            approvalId: result.approvalId,
            runId: result.runId,
            resolution: result.resolution,
            replayed: result.idempotentReplay,
          },
          meta,
        },
        200,
      );
    },
    streamReadModel: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read-model", 300);
      if (!input.readModels) {
        throw new ApiError(503, "unavailable", "Electric read models are not configured.", true);
      }
      const params = c.req.valid("param");
      const query = c.req.valid("query");
      if (params.readModel !== "task-activities-v1" && query.taskId) {
        throw new ApiError(400, "invalid_request", "taskId is not valid for this read model.");
      }
      if (params.readModel === "task-activities-v1") {
        if (!query.taskId || query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "taskId is required and other resource identifiers are not valid for this read model.",
          );
        }
        await input.tasks.getTask(actor, query.taskId);
      } else if (params.readModel.startsWith("brain-")) {
        if (query.conversationId || !query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "brainId is required and conversationId is not valid for this read model.",
          );
        }
        await input.knowledge.authorizeBrainRead(actor, query.brainId);
      } else if (params.readModel.startsWith("wiki-")) {
        if (query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId and brainId are not valid for this read model.",
          );
        }
        input.knowledge.authorizeWikiRead(actor);
      } else if (params.readModel === "tasks-v1") {
        if (query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId and brainId are not valid for this read model.",
          );
        }
        await input.tasks.listTasks(actor, { limit: 1 });
      } else if (params.readModel === "workflows-v1") {
        if (query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId is not valid for this read model.",
          );
        }
        await input.workflows.listWorkflows(actor, { limit: 1 });
      } else if (params.readModel === "workflow-schedules-v1") {
        if (query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId is not valid for this read model.",
          );
        }
        await input.workflows.listWorkflows(actor, { limit: 1 });
      } else if (params.readModel === "task-schedules-v1") {
        if (query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId is not valid for this read model.",
          );
        }
        await input.schedules.listTaskSchedules(actor, { limit: 1 });
      } else if (params.readModel === "integration-accounts-v1") {
        if (query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId and brainId are not valid for this read model.",
          );
        }
      } else if (params.readModel === "chat-conversations-v2") {
        if (query.brainId) {
          throw new ApiError(400, "invalid_request", "brainId is not valid for this read model.");
        }
        if (query.conversationId) {
          await input.chat.getConversation(actor, query.conversationId);
        }
      } else if (params.readModel === "engine-sessions-v1") {
        if (query.brainId) {
          throw new ApiError(400, "invalid_request", "brainId is not valid for this read model.");
        }
        // Task Conversations resolve through the Task boundary, so the chat-only lookup is not
        // enough here.
        if (query.conversationId) {
          await authorizeConversationRead(input, actor, query.conversationId);
        }
      } else if (params.readModel !== "chat-conversations-v1") {
        if (!query.conversationId || query.brainId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId is required for this read model.",
          );
        }
        await authorizeConversationRead(input, actor, query.conversationId);
      } else if (query.conversationId || query.brainId) {
        throw new ApiError(
          400,
          "invalid_request",
          "conversationId is not valid for this read model.",
        );
      }
      return input.readModels.stream({
        actor,
        readModel: params.readModel,
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        ...(query.brainId ? { brainId: query.brainId } : {}),
        ...(query.taskId ? { taskId: query.taskId } : {}),
        requestUrl: new URL(c.req.url),
      }) as never;
    },
    updateUserPreferences: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const preferences = await input.userSettings.updatePreferences(actor, c.req.valid("json"));
      return c.json({ data: preferences, meta }, 200);
    },
    getMcpSetup: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const status = await input.userSettings.getMcpSetup(actor);
      return c.json({ data: mcpSetupDto(status), meta }, 200);
    },
    updateMcpSetup: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const status = await input.userSettings.setPreferredMcpClient(
        actor,
        c.req.valid("json").preferredClient,
      );
      return c.json({ data: mcpSetupDto(status), meta }, 200);
    },
    submitFeedback: async (c) => {
      const actor = actorFrom(c);
      // Feedback gets its own bucket: sharing the write counter would let
      // ordinary settings churn 429 the always-available feedback widget.
      await enforceRateLimit(rateLimiter, actor, "feedback", 10);
      await input.feedback.submit(actor, c.req.valid("json"));
      return c.json({ data: { submitted: true as const }, meta }, 200);
    },
    listRepoConfigs: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const result = await input.repoConfigs.list(actor);
      return c.json(
        {
          data: {
            repositories: result.repositories,
            configs: result.configs.map(repoConfigDto),
          },
          meta,
        },
        200,
      );
    },
    setRepoConfigEnv: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const config = await input.repoConfigs.setEnv(
        actor,
        c.req.valid("param").repositoryExternalId,
        c.req.valid("json").content,
      );
      return c.json({ data: repoConfigDto(config), meta }, 200);
    },
    setRepoConfigSetup: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const config = await input.repoConfigs.setSetupInstructions(
        actor,
        c.req.valid("param").repositoryExternalId,
        c.req.valid("json").setupInstructions,
      );
      return c.json({ data: repoConfigDto(config), meta }, 200);
    },
    deleteRepoConfig: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const repositoryExternalId = c.req.valid("param").repositoryExternalId;
      await input.repoConfigs.remove(actor, repositoryExternalId);
      return c.json({ data: { repositoryExternalId, deleted: true as const }, meta }, 200);
    },
    connectAttioAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const state = await input.integrationAccounts.connectAttio(actor, c.req.valid("json").apiKey);
      return c.json({ data: { state: attioStateDto(state) }, meta }, 200);
    },
    disconnectAttioAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const integrationId = c.req.valid("param").integrationId;
      await input.integrationAccounts.disconnectAttio(actor, integrationId);
      return c.json({ data: { integrationId, deleted: true as const }, meta }, 200);
    },
    connectFathomAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const state = await input.integrationAccounts.connectFathom(
        actor,
        c.req.valid("json").apiKey,
      );
      return c.json({ data: { state: fathomStateDto(state) }, meta }, 200);
    },
    connectGranolaAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const state = await input.integrationAccounts.connectGranola(
        actor,
        c.req.valid("json").apiKey,
      );
      return c.json({ data: { state: granolaStateDto(state) }, meta }, 200);
    },
    startImessagePairing: async (c) => {
      const actor = actorFrom(c);
      // Pairing sends a real text message, so it gets its own small bucket
      // instead of sharing the general write counter.
      await enforceRateLimit(rateLimiter, actor, "imessage-pairing", 5);
      await input.integrationAccounts.startImessagePairing(actor, c.req.valid("json").phone);
      return c.json({ data: { started: true as const }, meta }, 200);
    },
    confirmImessagePairing: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const state = await input.integrationAccounts.confirmImessagePairing(
        actor,
        c.req.valid("json").code,
      );
      return c.json({ data: { state: imessageStateDto(state) }, meta }, 200);
    },
    connectStripeAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const state = await input.integrationAccounts.connectStripe(
        actor,
        c.req.valid("json").apiKey,
      );
      return c.json({ data: { state: stripeStateDto(state) }, meta }, 200);
    },
    disconnectStripeAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.integrationAccounts.disconnectStripe(actor);
      return c.json({ data: { deleted: true as const }, meta }, 200);
    },
    createJamieWebhookEndpoint: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const setup = await input.integrationAccounts.createOrResetJamieWebhookEndpoint(actor);
      return c.json({ data: { setup }, meta }, 200);
    },
    saveJamieApiKey: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const setup = await input.integrationAccounts.saveJamieWebhookApiKey(
        actor,
        c.req.valid("json").apiKey,
      );
      return c.json({ data: { setup }, meta }, 200);
    },
    listIntegrationAccounts: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      return c.json({ data: await input.integrationAccounts.list(actor), meta }, 200);
    },
    getSlackBotWorkspaceSettings: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      return c.json({ data: await input.slackBotSettings.getWorkspaceSettings(actor), meta }, 200);
    },
    disconnectSlackBot: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.slackBotSettings.disconnect(actor);
      return c.json({ data: { updated: true as const }, meta }, 200);
    },
    getSlackBotDestination: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const destination = await input.slackBotSettings.getDestination(
        actor,
        c.req.valid("param").brainId,
      );
      return c.json({ data: destination, meta }, 200);
    },
    setSlackBotDestination: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.slackBotSettings.setDestination(
        actor,
        c.req.valid("param").brainId,
        c.req.valid("json"),
      );
      return c.json({ data: { updated: true as const }, meta }, 200);
    },
    listSlackBotChannels: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const result = await input.slackBotSettings.listChannels(actor, c.req.valid("param").brainId);
      return c.json({ data: result, meta }, 200);
    },
    getIntegrationAccountUsage: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const usage = await input.integrationAccounts.getUsage(
        actor,
        c.req.valid("param").integrationId,
      );
      return c.json({ data: usage, meta }, 200);
    },
    setIntegrationCapabilityMode: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const params = c.req.valid("param");
      const mode = c.req.valid("json").mode;
      await input.integrationAccounts.setCapabilityMode(
        actor,
        params.integrationId,
        params.capabilityId,
        mode,
      );
      return c.json(
        {
          data: {
            integrationId: params.integrationId,
            capabilityId: params.capabilityId,
            // The service rejects anything outside the mode vocabulary.
            mode: mode as "on" | "ask" | "off",
          },
          meta,
        },
        200,
      );
    },
    alwaysAllowAction: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const actionId = c.req.valid("param").actionId;
      await input.integrationAccounts.alwaysAllowAction(actor, actionId);
      return c.json({ data: { actionId, state: "allowed" as const }, meta }, 200);
    },
    deleteIntegrationAccount: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const integrationId = c.req.valid("param").integrationId;
      await input.integrationAccounts.disconnect(actor, integrationId);
      return c.json({ data: { integrationId, deleted: true as const }, meta }, 200);
    },
    getClaudeCodeAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const status = await input.engineAuth.getClaudeCodeStatus(actor);
      return c.json({ data: status, meta }, 200);
    },
    saveClaudeCodeToken: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const status = await input.engineAuth.saveClaudeCodeToken(actor, c.req.valid("json").token);
      return c.json({ data: status, meta }, 200);
    },
    deleteClaudeCodeAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.engineAuth.disconnectClaudeCode(actor);
      return c.json({ data: { deleted: true as const }, meta }, 200);
    },
    getCodexAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const status = await input.engineAuth.getCodexStatus(actor);
      return c.json({ data: status, meta }, 200);
    },
    startCodexDeviceAuth: async (c) => {
      const actor = actorFrom(c);
      // Flow starts open device/browser authorizations against external auth
      // providers, so they get a small dedicated bucket instead of the general
      // write counter.
      await enforceRateLimit(rateLimiter, actor, "engine-auth-start", 10);
      const flow = await input.engineAuth.startCodexDeviceAuth(actor);
      return c.json({ data: { flow }, meta }, 201);
    },
    pollCodexDeviceAuth: async (c) => {
      const actor = actorFrom(c);
      // The settings panel polls every few seconds during a device flow;
      // sharing the write bucket would let ordinary mutations 429 the poll.
      await enforceRateLimit(rateLimiter, actor, "engine-auth-poll", 120);
      const flow = await input.engineAuth.pollCodexDeviceAuth(actor, c.req.valid("param").flowId);
      return c.json({ data: { flow }, meta }, 200);
    },
    deleteCodexAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.engineAuth.disconnectCodex(actor);
      return c.json({ data: { deleted: true as const }, meta }, 200);
    },
    getInfisicalAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const status = await input.engineAuth.getInfisicalStatus(actor);
      return c.json({ data: status, meta }, 200);
    },
    startInfisicalAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "engine-auth-start", 10);
      const flow = await input.engineAuth.startInfisicalAuth(actor, c.req.valid("json").host);
      return c.json({ data: { flow }, meta }, 201);
    },
    completeInfisicalAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const flow = await input.engineAuth.completeInfisicalAuth(
        actor,
        c.req.valid("param").flowId,
        c.req.valid("json").browserToken,
      );
      return c.json({ data: { flow }, meta }, 200);
    },
    deleteInfisicalAuth: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      await input.engineAuth.disconnectInfisical(actor);
      return c.json({ data: { deleted: true as const }, meta }, 200);
    },
    getBillingOverview: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-read", 300);
      c.header("Cache-Control", "private, no-store");
      return c.json({ data: await input.billing.getOverview(actor), meta }, 200);
    },
    getBillingUsage: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-read", 300);
      c.header("Cache-Control", "private, no-store");
      return c.json({ data: await input.billing.getUsage(actor), meta }, 200);
    },
    getBillingBalance: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-read", 300);
      c.header("Cache-Control", "private, no-store");
      return c.json({ data: await input.billing.getBalance(actor), meta }, 200);
    },
    createBillingTopUp: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-command", 10);
      const result = await input.billing.createCreditTopUp(actor, {
        ...c.req.valid("json"),
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      });
      return c.json({ data: result, meta }, 201);
    },
    createBillingSubscriptionCheckout: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-command", 10);
      const result = await input.billing.createProCheckout(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      });
      return c.json({ data: result, meta }, 201);
    },
    createBillingPortalSession: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-command", 10);
      const result = await input.billing.createBillingPortal(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      });
      return c.json({ data: result, meta }, 201);
    },
    updateBillingAutoRefill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "billing-command", 10);
      const result = await input.billing.updateAutoRefill(actor, {
        ...c.req.valid("json"),
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      });
      return c.json({ data: result, meta }, 200);
    },
  };

  const app = createV1Router(handlers, {
    beforeRoutes(router) {
      router.use("/public/*", secureHeaders());
      router.use(
        "/public/*",
        requestId({
          headerName: "X-Request-Id",
          limitLength: 128,
          generator: () => `request_${randomUUID()}`,
        }),
      );
      router.use(
        "/v1/*",
        cors({
          origin: browserOrigins,
          allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          allowHeaders: CORS_ALLOW_HEADERS,
          exposeHeaders: CORS_EXPOSE_HEADERS,
          credentials: true,
          maxAge: 600,
        }),
      );
      router.use("/v1/*", secureHeaders());
      router.use(
        "/v1/*",
        requestId({
          headerName: "X-Request-Id",
          limitLength: 128,
          generator: () => `request_${randomUUID()}`,
        }),
      );
      router.use("/v1/*", async (c, next) => {
        const startedAt = performance.now();
        return withSpan(
          SPANS.apiRequest,
          { "goat.http_method": c.req.method, "goat.http_route": c.req.path },
          async (span) => {
            try {
              enforceCookieMutationOrigin(c.req.raw, browserOrigins);
              if (isIdentityTierPath(c.req.path)) {
                const identity = await input.identify(c.req.raw);
                setContextValue(c, "identity", identity);
                if (identity.refreshedSessionCookie) {
                  c.header("Set-Cookie", identity.refreshedSessionCookie);
                }
              } else {
                const authentication = await input.authenticate(c.req.raw);
                setContextValue(c, "actor", authentication.actor);
                if (authentication.refreshedSessionCookie) {
                  c.header("Set-Cookie", authentication.refreshedSessionCookie);
                }
              }
              enforceMessageProtocolVersion(c);
              await next();
              span.setAttributes({ "goat.http_status_code": c.res.status });
              return c.res;
            } catch (error) {
              if (!(error instanceof ApiError) && !(error instanceof CoreError)) {
                captureException(error, {
                  ...requestFailureLogFieldsFrom(c),
                  event: "opencompany.api_request_failed",
                  request_id: requestIdFrom(c),
                  method: c.req.method,
                  path: c.req.path,
                });
              }
              c.res = apiErrorResponse(c, error);
              span.setAttributes({ "goat.http_status_code": c.res.status });
              if (c.res.status >= 500) {
                span.fail(error, { "goat.http_status_code": c.res.status });
              }
              return c.res;
            } finally {
              logger.info("API request completed", {
                event: "opencompany.api_request_completed",
                request_id: requestIdFrom(c),
                method: c.req.method,
                path: c.req.path,
                status: c.res.status,
                duration_ms: Math.round(performance.now() - startedAt),
              });
            }
          },
        );
      });
      router.use(
        "/v1/attachments",
        bodyLimit({
          maxSize: CHAT_ATTACHMENT_MAX_BYTES + MULTIPART_ENVELOPE_BYTES,
          onError: (c) =>
            apiErrorResponse(
              c,
              new ApiError(413, "invalid_request", "The attachment upload is too large."),
            ),
        }),
      );
      router.use(
        "/v1/brains/:brainId/assets",
        bodyLimit({
          maxSize: 20 * 1024 * 1024 + MULTIPART_ENVELOPE_BYTES,
          onError: (c) =>
            apiErrorResponse(
              c,
              new ApiError(413, "invalid_request", "The Brain asset upload is too large."),
            ),
        }),
      );
      router.use(
        "/v1/brains/:brainId/assets/:documentId/replace",
        bodyLimit({
          maxSize: 20 * 1024 * 1024 + MULTIPART_ENVELOPE_BYTES,
          onError: (c) =>
            apiErrorResponse(
              c,
              new ApiError(413, "invalid_request", "The Brain asset upload is too large."),
            ),
        }),
      );
    },
    defaultHook(result, c) {
      if (result.success) return;
      logger.warn("API request validation failed", {
        event: "opencompany.api_request_validation_failed",
        request_id: requestIdFrom(c),
        method: c.req.method,
        path: c.req.path,
        validation_issues: result.error.issues.slice(0, 20).map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join(".") || "(root)",
        })),
      });
      return apiErrorResponse(
        c,
        new ApiError(400, "invalid_request", "Request validation failed."),
      );
    },
  });

  app.onError((error, c) => {
    captureException(error, {
      ...requestFailureLogFieldsFrom(c),
      event: "opencompany.api_request_failed",
      request_id: requestIdFrom(c),
      method: c.req.method,
      path: c.req.path,
    });
    return apiErrorResponse(c, error);
  });
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "opencompany-api",
      environment: process.env.OBSERVABILITY_ENV ?? process.env.NODE_ENV ?? "development",
      protocolVersion: PROTOCOL_VERSION,
      release:
        process.env.RENDER_GIT_COMMIT ??
        process.env.OBSERVABILITY_RELEASE ??
        process.env.GITHUB_SHA ??
        null,
      renderGitCommit: process.env.RENDER_GIT_COMMIT ?? null,
    }),
  );
  app.get("/openapi.json", (c) => c.json(createOpenApiDocument()));
  if (input.mcp) {
    app.on(["GET", "POST", "DELETE"], "/mcp", (c) => input.mcp!.handle(c.req.raw));
  }
  app.post("/internal/onboarding-emails/enroll", async (c) => {
    authorizeEmailLifecycleInternalRequest(c.req.raw, input.emailLifecycleInternalSecret);
    const body = await internalJsonBody(c.req.raw);
    const workosUserId = boundedString(body.workosUserId, 128);
    if (!workosUserId) {
      throw new ApiError(400, "invalid_request", "A valid user id is required.");
    }
    await input.onboardingEmails.enroll(workosUserId);
    return c.json({ data: { completed: true as const }, meta }, 200);
  });
  app.post("/internal/onboarding-emails/claim", async (c) => {
    authorizeEmailLifecycleInternalRequest(c.req.raw, input.emailLifecycleInternalSecret);
    const body = await internalJsonBody(c.req.raw);
    const limit = body.limit;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
      throw new ApiError(400, "invalid_request", "A claim limit from 1 to 100 is required.");
    }
    const workosUserId =
      body.workosUserId === undefined ? undefined : boundedString(body.workosUserId, 128);
    if (body.workosUserId !== undefined && !workosUserId) {
      throw new ApiError(400, "invalid_request", "A valid user id is required.");
    }
    const emails = workosUserId
      ? await input.onboardingEmails.claimDue(Number(limit), workosUserId)
      : await input.onboardingEmails.claimDue(Number(limit));
    return c.json({ data: { emails }, meta }, 200);
  });
  app.post("/internal/onboarding-emails/settle", async (c) => {
    authorizeEmailLifecycleInternalRequest(c.req.raw, input.emailLifecycleInternalSecret);
    const body = await internalJsonBody(c.req.raw);
    const id = boundedString(body.id, 128);
    const outcome = body.outcome;
    if (!id || !["sent", "failed", "rescheduled"].includes(String(outcome))) {
      throw new ApiError(400, "invalid_request", "A valid email settlement is required.");
    }
    const error = body.error === undefined ? undefined : boundedString(body.error, 2_000);
    const nextRunAt = body.nextRunAt === undefined ? undefined : validDate(String(body.nextRunAt));
    if (outcome !== "sent" && !error) {
      throw new ApiError(400, "invalid_request", "A delivery error is required.");
    }
    if (outcome === "rescheduled" && !nextRunAt) {
      throw new ApiError(400, "invalid_request", "A retry schedule is required.");
    }
    await input.onboardingEmails.settle({
      id,
      outcome: outcome as "sent" | "failed" | "rescheduled",
      ...(error ? { error } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
    });
    return c.json({ data: { completed: true as const }, meta }, 200);
  });
  app.post("/internal/onboarding-emails/unsubscribe", async (c) => {
    authorizeEmailLifecycleInternalRequest(c.req.raw, input.emailLifecycleInternalSecret);
    const body = await internalJsonBody(c.req.raw);
    const email = boundedString(body.email, 320)?.toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new ApiError(400, "invalid_request", "A valid email is required.");
    }
    const skipped = await input.onboardingEmails.unsubscribe(email);
    return c.json({ data: { skipped }, meta }, 200);
  });
  // Internal runner→API entrypoint for the `wiki` agent tool. The API owns the
  // whole boundary: bearer auth, body validation, server-side actor
  // reauthorization, command-aware rate limits, and command execution against
  // Postgres. The runner never touches the wiki database directly.
  app.post("/internal/wiki/commands", async (c) => {
    authorizeInternalBearer(
      c.req.raw,
      input.wikiCommandsInternalSecret,
      "Wiki command execution is unavailable.",
    );
    const idempotencyKey = boundedString(c.req.header("idempotency-key"), 200);
    if (!idempotencyKey) {
      throw new ApiError(400, "invalid_request", "An Idempotency-Key header is required.");
    }
    const parsed = InternalWikiCommandRequestSchema.safeParse(await internalJsonBody(c.req.raw));
    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "A valid wiki command is required.");
    }
    const { userWorkosId, workspaceId, command } = parsed.data;
    // Never trust the caller-supplied tenancy: reload the actor from Postgres.
    const actor = await input.resolveWikiServiceActor({ userWorkosId, workspaceId });
    const isRead = WIKI_READ_COMMANDS.includes(command.command);
    await enforceRateLimit(rateLimiter, actor, isRead ? "wiki_read" : "wiki_write", 120);
    const startedAt = now();
    const output = await input.wikiCommands.execute({ actor, command, idempotencyKey });
    logger.info("Internal wiki command executed", {
      event: "opencompany.internal_wiki_command",
      request_id: requestIdFrom(c),
      command: command.command,
      user_id: actor.userId,
      workspace_id: actor.workspaceId,
      duration_ms: now().getTime() - startedAt.getTime(),
      outcome: output.ok ? "ok" : "tool_error",
    });
    return c.json({ data: output, meta }, 200);
  });
  if (input.githubIngress) {
    // Purpose-specific provider ingress: registered outside /v1 so the /v1
    // browser middleware (CORS, cookie-mutation Origin checks, actor context)
    // does not apply. Each handler owns its authentication and verification.
    const ingress = input.githubIngress;
    app.get("/integrations/github/start", (c) => ingress.start(c.req.raw));
    app.get("/integrations/github/callback", (c) => ingress.callback(c.req.raw));
    // GitHub caps webhook payloads at 25 MB; unlike the retired Vercel route,
    // Render enforces no platform body limit, so cap it here.
    app.use("/webhooks/github/events", ingressBodyLimit(25 * 1024 * 1024));
    app.post("/webhooks/github/events", (c) => ingress.webhook(c.req.raw));
  }
  if (input.googleIngress) {
    const ingress = input.googleIngress;
    app.get("/integrations/gmail/start", (c) => ingress.start("gmail", c.req.raw));
    app.get("/integrations/gmail/callback", (c) => ingress.callback("gmail", c.req.raw));
    app.get("/integrations/google-calendar/start", (c) =>
      ingress.start("google_calendar", c.req.raw),
    );
    app.get("/integrations/google-calendar/callback", (c) =>
      ingress.callback("google_calendar", c.req.raw),
    );
    app.get("/integrations/google-drive/start", (c) => ingress.start("google_drive", c.req.raw));
    app.get("/integrations/google-drive/callback", (c) =>
      ingress.callback("google_drive", c.req.raw),
    );
    app.post("/webhooks/google-drive", (c) => ingress.driveWebhook(c.req.raw));
  }
  if (input.slackIngress) {
    const ingress = input.slackIngress;
    app.get("/integrations/slack/start", (c) => ingress.start(c.req.raw));
    app.get("/integrations/slack/callback", (c) => ingress.callback(c.req.raw));
    // Slack event payloads are small; Render enforces no platform body cap, so
    // bound the unauthenticated raw-body read here.
    app.use("/webhooks/slack/events", ingressBodyLimit(5 * 1024 * 1024));
    app.post("/webhooks/slack/events", (c) => ingress.webhook(c.req.raw));
  }
  if (input.linearIngress) {
    const ingress = input.linearIngress;
    app.get("/integrations/linear-ingest/start", (c) => ingress.start(c.req.raw));
    app.get("/integrations/linear-ingest/callback", (c) => ingress.callback(c.req.raw));
    app.use("/webhooks/linear/events", ingressBodyLimit(5 * 1024 * 1024));
    app.post("/webhooks/linear/events", (c) => ingress.webhook(c.req.raw));
  }
  if (input.hubspotIngress) {
    const ingress = input.hubspotIngress;
    app.get("/integrations/hubspot/start", (c) => ingress.start(c.req.raw));
    app.get("/integrations/hubspot/callback", (c) => ingress.callback(c.req.raw));
    app.use("/webhooks/hubspot/events", ingressBodyLimit(5 * 1024 * 1024));
    app.post("/webhooks/hubspot/events", (c) => ingress.webhook(c.req.raw));
  }
  if (input.attioIngress) {
    const ingress = input.attioIngress;
    app.use("/webhooks/attio/events", ingressBodyLimit(5 * 1024 * 1024));
    app.post("/webhooks/attio/events", (c) => ingress.webhook(c.req.raw));
  }
  if (input.jamieIngress) {
    const ingress = input.jamieIngress;
    app.use("/webhooks/jamie", ingressBodyLimit(5 * 1024 * 1024));
    app.post("/webhooks/jamie", (c) => ingress.webhook(c.req.raw));
    app.use("/webhooks/jamie/:integrationId", ingressBodyLimit(5 * 1024 * 1024));
    app.post("/webhooks/jamie/:integrationId", (c) =>
      ingress.webhookForIntegration(c.req.param("integrationId"), c.req.raw),
    );
  }
  if (input.mcpOAuthIngress) {
    const ingress = input.mcpOAuthIngress;
    app.get("/integrations/linear/start", (c) => ingress.start("linear", c.req.raw));
    app.get("/integrations/linear/callback", (c) => ingress.callback("linear", c.req.raw));
    app.get("/integrations/posthog/start", (c) => ingress.start("posthog", c.req.raw));
    app.get("/integrations/posthog/callback", (c) => ingress.callback("posthog", c.req.raw));
    app.get("/integrations/neon/start", (c) => ingress.start("neon", c.req.raw));
    app.get("/integrations/neon/callback", (c) => ingress.callback("neon", c.req.raw));
    app.get("/integrations/latitude/start", (c) => ingress.start("latitude", c.req.raw));
    app.get("/integrations/latitude/callback", (c) => ingress.callback("latitude", c.req.raw));
  }
  if (input.xAccountIngress) {
    const ingress = input.xAccountIngress;
    app.get("/integrations/x-account/start", (c) => ingress.start(c.req.raw));
    app.get("/integrations/x-account/callback", (c) => ingress.callback(c.req.raw));
  }
  if (input.slackBotIngress) {
    const ingress = input.slackBotIngress;
    app.get("/integrations/slack-bot/start", (c) => ingress.start(c.req.raw));
    app.get("/integrations/slack-bot/callback", (c) => ingress.callback(c.req.raw));
    app.use("/webhooks/slack-bot/events", ingressBodyLimit(1024 * 1024));
    app.post("/webhooks/slack-bot/events", (c) => ingress.webhook(c.req.raw));
  }
  if (input.stripeIngress) {
    app.use("/webhooks/stripe", ingressBodyLimit(1024 * 1024));
    app.post("/webhooks/stripe", (c) => input.stripeIngress!.webhook(c.req.raw));
  }
  if (input.billingReconcile) {
    app.get("/billing/reconcile", (c) => input.billingReconcile!.reconcile(c.req.raw));
  }
  app.notFound((c) => apiErrorResponse(c, new ApiError(404, "not_found", "Route not found.")));
  return app;
}

// Ingress webhooks read the raw body before signature verification can reject
// anything; Render has no platform request cap, so each route sets one.
function ingressBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      apiErrorResponse(
        c,
        new ApiError(413, "invalid_request", "The webhook payload is too large."),
      ),
  });
}

function autoRoutingApiError(error: unknown) {
  if (!(error instanceof AutoModelRoutingError)) return error;
  switch (error.code) {
    case "not_permitted":
    case "disabled":
      return new ApiError(403, "forbidden", error.message);
    case "attachments_unavailable":
      return new ApiError(400, "invalid_request", error.message);
    case "unavailable":
      return new ApiError(503, "unavailable", error.message, true);
  }
}

type SseOutput = {
  write(input: string): Promise<unknown>;
};

async function writeSse(output: SseOutput, message: { data: string; event?: string; id?: string }) {
  for (const value of [message.event, message.id]) {
    if (value && /[\r\n]/u.test(value)) {
      throw new Error("SSE event names and IDs cannot contain newlines.");
    }
  }
  const data = message.data
    .split(/\r\n|\r|\n/u)
    .map((line) => `data: ${line}`)
    .join("\n");
  const frame = [
    message.event && `event: ${message.event}`,
    data,
    message.id && `id: ${message.id}`,
  ]
    .filter(Boolean)
    .join("\n");
  await output.write(`${frame}\n\n`);
}

function enforceCookieMutationOrigin(request: Request, browserOrigins: readonly string[]) {
  if (
    browserOrigins.length === 0 ||
    SAFE_BROWSER_METHODS.has(request.method.toUpperCase()) ||
    request.headers.has("authorization")
  ) {
    return;
  }
  const origin = request.headers.get("origin");
  if (!origin || !browserOrigins.includes(origin)) {
    throw new ApiError(
      403,
      "forbidden",
      "Cookie-authenticated mutations require an allowed browser origin.",
    );
  }
}

function enforceMessageProtocolVersion(c: Context) {
  if (c.req.method !== "POST" || c.req.path !== "/v1/messages") return;
  const receivedProtocolVersion = c.req.header(PROTOCOL_VERSION_HEADER);
  if (receivedProtocolVersion === PROTOCOL_VERSION) return;

  logger.warn("Canonical Chat protocol version rejected", {
    event: "opencompany.api_protocol_version_rejected",
    request_id: requestIdFrom(c),
    path: c.req.path,
    expected_protocol_version: PROTOCOL_VERSION,
    received_protocol_version: receivedProtocolVersion ?? "missing",
  });
  throw new ApiError(400, "invalid_request", PROTOCOL_UPDATE_REQUIRED_MESSAGE);
}

function isIdentityTierPath(path: string) {
  return (
    path === IDENTITY_PATH ||
    path.startsWith(`${IDENTITY_PATH}/`) ||
    path === ONBOARDING_IDENTITY_PATH ||
    path.startsWith(`${ONBOARDING_IDENTITY_PATH}/`)
  );
}

// Timing-safe bearer check for internal service-to-service routes. Fails closed:
// a missing configured secret is 503 (unavailable/retryable), a wrong or absent
// token is 401.
function authorizeInternalBearer(
  request: Request,
  configuredSecret: string | undefined,
  unavailableMessage: string,
) {
  const secret = configuredSecret?.trim();
  if (!secret) {
    throw new ApiError(503, "unavailable", unavailableMessage, true);
  }
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new ApiError(401, "authentication_required", "Authentication required.");
  }
}

function authorizeEmailLifecycleInternalRequest(request: Request, configuredSecret?: string) {
  authorizeInternalBearer(request, configuredSecret, "Email lifecycle persistence is unavailable.");
}

async function internalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "A JSON object is required.");
  }
  return body as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function validDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function enforceRateLimit(
  limiter: ApiRateLimiter,
  actor: Actor,
  bucket: string,
  limit: number,
) {
  const decision = await limiter.consume({
    key: `${actor.workspaceId}:${actor.userId}`,
    bucket,
    limit,
    windowMs: 60_000,
  });
  if (!decision.allowed) {
    throw new ApiError(429, "rate_limited", "Too many requests.", true, {
      "Retry-After": String(decision.retryAfterSeconds),
    });
  }
}

async function enforcePublicRateLimit(
  limiter: ApiRateLimiter,
  publicKey: string,
  bucket: string,
  limit: number,
) {
  const decision = await limiter.consume({
    key: publicKey,
    bucket,
    limit,
    windowMs: 60_000,
  });
  if (!decision.allowed) {
    throw new ApiError(429, "rate_limited", "Too many requests.", true, {
      "Retry-After": String(decision.retryAfterSeconds),
    });
  }
}

async function enforceIdentityRateLimit(
  limiter: ApiRateLimiter,
  identity: ApiIdentity,
  bucket: string,
  limit: number,
) {
  const decision = await limiter.consume({
    key: identity.userId,
    bucket,
    limit,
    windowMs: 60_000,
  });
  if (!decision.allowed) {
    throw new ApiError(429, "rate_limited", "Too many requests.", true, {
      "Retry-After": String(decision.retryAfterSeconds),
    });
  }
}

function actorFrom(c: Context): Actor {
  const actor = getContextValue(c, "actor");
  if (!actor) throw new ApiError(401, "authentication_required", "Authentication required.");
  return actor as Actor;
}

function identityFrom(c: Context): ApiIdentity {
  const identity = getContextValue(c, "identity");
  if (!identity) throw new ApiError(401, "authentication_required", "Authentication required.");
  return identity as ApiIdentity;
}

function setContextValue(c: Context, key: string, value: unknown) {
  (c as unknown as { set(name: string, value: unknown): void }).set(key, value);
}

function getContextValue(c: Context, key: string) {
  return (c as unknown as { get(name: string): unknown }).get(key);
}

function setRequestFailureLogFields(c: Context, fields: LogFields) {
  const existing = getContextValue(c, REQUEST_FAILURE_LOG_FIELDS_KEY);
  setContextValue(c, REQUEST_FAILURE_LOG_FIELDS_KEY, {
    ...(isLogFields(existing) ? existing : {}),
    ...fields,
  });
}

function requestFailureLogFieldsFrom(c: Context): LogFields {
  const actor = getContextValue(c, "actor");
  const identity = getContextValue(c, "identity");
  const requestFields = getContextValue(c, REQUEST_FAILURE_LOG_FIELDS_KEY);
  return {
    ...(isActor(actor) ? { user_id: actor.userId, workspace_id: actor.workspaceId } : {}),
    ...(!isActor(actor) && isIdentity(identity) ? { user_id: identity.userId } : {}),
    ...(isLogFields(requestFields) ? requestFields : {}),
  };
}

function isActor(value: unknown): value is Actor {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { userId?: unknown }).userId === "string" &&
      typeof (value as { workspaceId?: unknown }).workspaceId === "string",
  );
}

function isIdentity(value: unknown): value is ApiIdentity {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { userId?: unknown }).userId === "string",
  );
}

function isLogFields(value: unknown): value is LogFields {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requestIdFrom(c: Context) {
  return (getContextValue(c, "requestId") as string | undefined) ?? `request_${randomUUID()}`;
}

function contentDisposition(value: string, inline = true) {
  const filename = value.replace(/[\u0000-\u001f\u007f"\\]/gu, "_").trim() || "file";
  const fallback = filename.replace(/[^\x20-\x7e]/gu, "_") || "file";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function chatResourcesFrom(input: CreateApiAppInput) {
  if (!input.chatResources) {
    throw new ApiError(503, "unavailable", "Chat resources are not configured.", true);
  }
  return input.chatResources;
}

function chatTitlesFrom(input: CreateApiAppInput) {
  if (!input.chatTitles) {
    throw new ApiError(503, "unavailable", "Chat title generation is not configured.", true);
  }
  return input.chatTitles;
}

function chatResourceResponse(asset: ChatResourceDownload) {
  const headers = new Headers({
    "Content-Type": asset.mediaType,
    "Content-Disposition": contentDisposition(asset.filename, asset.inline),
    "Cache-Control": asset.cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...(asset.sandbox ? { "Content-Security-Policy": "sandbox" } : {}),
  });
  if (asset.sizeBytes !== null) headers.set("Content-Length", String(asset.sizeBytes));
  return new Response(asset.stream, { status: 200, headers });
}

function apiErrorResponse(c: Context, error: unknown) {
  const requestId = requestIdFrom(c);
  const response = errorResponse(error, requestId);
  response.headers.set("X-Request-Id", requestId);
  return response;
}

function conversationDto(conversation: {
  id: string;
  title: string;
  engine: "opencompany" | "codex" | "claude_code";
  model: string;
  runtime: {
    status: "queued" | "starting" | "idle" | "running" | "failed" | "interrupted" | "closed";
    activeRunId: string | null;
    hasError: boolean;
    updatedAt: Date;
  } | null;
  activityState: "working" | "idle";
  hasUnseen: boolean;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...conversation,
    runtime: conversation.runtime
      ? { ...conversation.runtime, updatedAt: conversation.runtime.updatedAt.toISOString() }
      : null,
    pinnedAt: conversation.pinnedAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function taskDto(task: Task) {
  return {
    ...task,
    scheduledFor: task.scheduledFor?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function taskCreationDto(result: {
  task: Task;
  messageId: string;
  assistantMessageId: string;
  runId: string;
  transactionId: string;
  idempotentReplay: boolean;
}) {
  return {
    task: taskDto(result.task),
    messageId: result.messageId,
    assistantMessageId: result.assistantMessageId,
    runId: result.runId,
    transactionId: result.transactionId,
    replayed: result.idempotentReplay,
  };
}

function workflowDto(workflow: Workflow) {
  return {
    ...workflow,
    trigger:
      workflow.trigger.type === "schedule"
        ? {
            ...workflow.trigger,
            lastRunAt: workflow.trigger.lastRunAt?.toISOString() ?? null,
            nextRunAt: workflow.trigger.nextRunAt?.toISOString() ?? null,
          }
        : workflow.trigger,
    archivedAt: workflow.archivedAt?.toISOString() ?? null,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function taskScheduleDto(schedule: TaskSchedule) {
  return {
    ...schedule,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    nextRunAt: schedule.nextRunAt.toISOString(),
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

function brainFolderDto(folder: BrainFolder) {
  return {
    ...folder,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}

function brainDocumentDto(document: BrainDocument) {
  return {
    ...document,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function brainOverviewDto(overview: BrainOverview) {
  return { ...overview, windowStartedAt: overview.windowStartedAt.toISOString() };
}

function brainSourceItemDto(item: BrainSourceItem) {
  return {
    id: item.id,
    sourceProvider: item.sourceProvider,
    sourceType: item.sourceType,
    externalId: item.externalId.slice(0, 4_096),
    title: item.title?.slice(0, 512) ?? null,
    lastIngestError: item.lastIngestError?.slice(0, 2_000) ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

function wikiPageDto(page: WikiPage) {
  return {
    ...page,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

function wikiTimelineEntryDto(entry: WikiTimelineEntry) {
  return {
    ...entry,
    at: entry.at.toISOString(),
    createdAt: entry.createdAt.toISOString(),
  };
}

function skillInstallationListItemDto(installation: SkillInstallationListItem) {
  return {
    ...installation,
    archivedAt: installation.archivedAt?.toISOString() ?? null,
    updatedAt: installation.updatedAt.toISOString(),
    bundle: {
      ...installation.bundle,
      createdAt: installation.bundle.createdAt.toISOString(),
    },
  };
}

function skillInstallationDto(installation: SkillInstallation) {
  return {
    ...installation,
    archivedAt: installation.archivedAt?.toISOString() ?? null,
    createdAt: installation.createdAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString(),
    bundle: {
      ...installation.bundle,
      createdAt: installation.bundle.createdAt.toISOString(),
    },
  };
}

function legacyTaskDto(task: LegacyTask) {
  return {
    ...task,
    scheduledFor: task.scheduledFor?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function legacyTaskHistoryDto(history: LegacyTaskHistory) {
  return {
    task: legacyTaskDto(history.task),
    messages: history.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
      completedAt: message.completedAt?.toISOString() ?? null,
    })),
    events: history.events.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

async function authorizeConversationRead(
  input: Pick<CreateApiAppInput, "chat" | "tasks">,
  actor: Actor,
  conversationId: string,
) {
  await getConversationOrTask(input, actor, conversationId, { includeArchived: true });
}

async function getConversationOrTask(
  input: Pick<CreateApiAppInput, "chat" | "tasks">,
  actor: Actor,
  conversationId: string,
  options: { includeArchived?: boolean } = {},
) {
  try {
    return await input.chat.getConversation(actor, conversationId, options);
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "not_found") throw error;
    return input.tasks.getTaskByConversation(actor, conversationId);
  }
}

function messageDto(message: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  attachments: readonly {
    id: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    kind: "image" | "document" | "audio" | "video" | "other";
  }[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...message,
    attachments: [...message.attachments],
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

function runDto(run: {
  id: string;
  conversationId: string;
  triggerMessageId: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
  engine: "opencompany" | "codex" | "claude_code";
  model: string;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...run, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString() };
}

function capabilityApprovalDto(approval: CapabilityApprovalView) {
  return {
    ...approval,
    expiresAt: approval.expiresAt?.toISOString() ?? null,
  };
}

function mcpSetupDto(status: {
  preferredClient: "claude" | "chatgpt" | "cursor" | null;
  complete: boolean;
  completedAt: Date | null;
}) {
  return {
    preferredClient: status.preferredClient,
    complete: status.complete,
    completedAt: status.completedAt?.toISOString() ?? null,
  };
}

// Env values are secret-bearing and intentionally absent from the view type;
// this DTO only ever carries key names.
function repoConfigDto(config: {
  repositoryExternalId: string;
  repositoryFullName: string;
  envKeys: string[];
  setupInstructions: string;
  updatedAt: Date;
}) {
  return {
    repositoryExternalId: config.repositoryExternalId,
    repositoryFullName: config.repositoryFullName,
    envKeys: config.envKeys,
    setupInstructions: config.setupInstructions,
    updatedAt: config.updatedAt.toISOString(),
  };
}

// The shared provider-state types include "disconnected", but state loaders
// filter those rows out; the protocol contract therefore omits it and any
// straggler collapses to "not_connected".
function integrationAccountStatusDto(
  status: AttioProviderState["status"],
): "not_connected" | "connected" | "needs_reauth" | "sync_failed" {
  return status === "disconnected" ? "not_connected" : status;
}

function attioStateDto(state: AttioProviderState) {
  return {
    provider: state.provider,
    connected: state.connected,
    status: integrationAccountStatusDto(state.status),
    integrationId: state.integrationId,
    workspaceName: state.workspaceName,
    statusReason: state.statusReason,
  };
}

function fathomStateDto(state: FathomProviderState) {
  return {
    provider: state.provider,
    connected: state.connected,
    status: integrationAccountStatusDto(state.status),
    integrationId: state.integrationId,
    accountEmail: state.accountEmail,
    accountName: state.accountName,
    statusReason: state.statusReason,
  };
}

function granolaStateDto(state: GranolaProviderState) {
  return {
    provider: state.provider,
    connected: state.connected,
    status: integrationAccountStatusDto(state.status),
    integrationId: state.integrationId,
    accountEmail: state.accountEmail,
    accountName: state.accountName,
    statusReason: state.statusReason,
  };
}

function imessageStateDto(state: ImessageProviderState) {
  return {
    provider: state.provider,
    connected: state.connected,
    status: integrationAccountStatusDto(state.status),
    integrationId: state.integrationId,
    phoneE164: state.phoneE164,
    statusReason: state.statusReason,
  };
}

function stripeStateDto(state: StripeProviderState) {
  return {
    provider: state.provider,
    connected: state.connected,
    status: integrationAccountStatusDto(state.status),
    integrationId: state.integrationId,
    accountName: state.accountName,
    livemode: state.livemode,
    statusReason: state.statusReason,
  };
}

function runEventDto(event: RunEvent) {
  return RunEventSchema.parse({
    id: event.id,
    runId: event.runId,
    attemptId: event.attemptId,
    cursor: encodeEventCursor(event.sequence),
    schemaVersion: 1,
    type: event.type,
    payload: event.payload,
    occurredAt: event.createdAt.toISOString(),
  });
}

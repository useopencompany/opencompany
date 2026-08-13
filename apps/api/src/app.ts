import { randomUUID } from "node:crypto";
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
  type RunEvent,
  type Skill,
  type SkillImportApplicationService,
  type SkillListItem,
  type Task,
  type TaskApplicationService,
  type TaskSchedule,
  type TaskScheduleApplicationService,
  type WikiPage,
  type WikiTimelineEntry,
  type Workflow,
  type WorkflowApplicationService,
} from "@opencompany/core";
import {
  AutoModelRoutingError,
  type AutoModelRoutingResolution,
} from "@opencompany/goat-agent/application/auto-model-routing";
import type { GoatBrainImportApplicationService } from "@opencompany/goat-agent/brain-imports";
import type { GoatBrainSourceApplicationService } from "@opencompany/goat-agent/brain-sources";
import type { GoatBrowserProfileApplicationService } from "@opencompany/goat-agent/browser-profiles/service";
import { GOAT_SPANS, withGoatSpan } from "@opencompany/goat-observability";
import { captureException, createLogger } from "@opencompany/observability";
import {
  createOpenApiDocument,
  createV1Router,
  decodeEventCursor,
  decodePresentationCursor,
  encodeEventCursor,
  encodePresentationCursor,
  PROTOCOL_VERSION,
  PresentationDeltaEventSchema,
  RunEventSchema,
  type V1RouteHandlers,
} from "@opencompany/protocol";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { stream as streamResponse } from "hono/streaming";
import type { AttachmentUploadService } from "./attachments";
import type { ApiAuthenticator } from "./auth";
import type { BrainAssetService } from "./brain-assets";
import type { ReadModelService } from "./electric-read-models";
import { ApiError, errorResponse } from "./errors";
import { type ApiRateLimiter, InMemoryApiRateLimiter } from "./rate-limit";
import { PollingRunEventNotifier, type RunEventNotifier } from "./run-event-notifier";

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
const CORS_ALLOW_HEADERS = ["Accept", "Content-Type", "Idempotency-Key", "Last-Event-ID"];
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

export type CreateApiAppInput = {
  chat: ChatApplicationService;
  tasks: TaskApplicationService;
  workflows: WorkflowApplicationService;
  schedules: TaskScheduleApplicationService;
  knowledge: KnowledgeApplicationService;
  brainSources: Pick<GoatBrainSourceApplicationService, "list" | "set" | "remove" | "listOptions">;
  brainImports: Pick<GoatBrainImportApplicationService, "start" | "confirm" | "cancel" | "retry">;
  browserProfiles: Pick<
    GoatBrowserProfileApplicationService,
    | "list"
    | "create"
    | "remove"
    | "createLoginSession"
    | "completeLoginSession"
    | "resolveLiveViewUrl"
  >;
  skillImports: SkillImportApplicationService;
  brainAssets: BrainAssetService;
  attachments: AttachmentUploadService;
  authenticate: ApiAuthenticator;
  browserOrigins?: readonly string[];
  notifier?: RunEventNotifier;
  presentation?: ChatPresentationReader;
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
        process.env.GOAT_DEFAULT_CHAT_MODEL ??
        "moonshotai/kimi-k3";
      let autoResolution: AutoModelRoutingResolution | null = null;
      if (requestedModel === "auto") {
        if (body.engine !== "opencompany") {
          throw new ApiError(
            400,
            "invalid_request",
            "Auto model routing is available only for OpenCompany Tasks.",
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
        c.req.valid("param").slug,
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
        slug: c.req.valid("param").slug,
        ...c.req.valid("json"),
      });
      return c.json({ data: result, meta }, 200);
    },
    addWikiTimelineEntry: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const result = await input.knowledge.addWikiTimelineEntry(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        slug: c.req.valid("param").slug,
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
    listSkills: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const skills = await input.knowledge.listSkills(actor);
      return c.json({ data: skills.map(skillListItemDto), meta }, 200);
    },
    createSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const skill = await input.knowledge.createSkill(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json({ data: skillDto(skill), meta }, 201);
    },
    previewSkillImport: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const preview = await input.skillImports.preview(actor, c.req.valid("json"));
      return c.json(
        {
          data:
            preview.status === "resolved"
              ? {
                  status: preview.status,
                  proposedSlug: preview.proposedSlug,
                  name: preview.name,
                  description: preview.description,
                  instructions: preview.instructions,
                  extraFiles: preview.extraFiles,
                  resolvedCommit: preview.resolvedCommit,
                  integrity: preview.integrity,
                }
              : {
                  status: preview.status,
                  candidates: preview.candidates,
                },
          meta,
        },
        200,
      );
    },
    importSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 10);
      const result = await input.skillImports.import(actor, {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        ...c.req.valid("json"),
      });
      return c.json(
        {
          data: { skill: skillDto(result.skill), replayed: result.idempotentReplay },
          meta,
        },
        201,
      );
    },
    listSkillCatalog: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      return c.json({ data: await input.knowledge.listSkillCatalog(actor), meta }, 200);
    },
    getSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "read", 300);
      const skill = await input.knowledge.getSkill(actor, c.req.valid("param").slug);
      return c.json({ data: skillDto(skill), meta }, 200);
    },
    updateSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const skill = await input.knowledge.updateSkill(
        actor,
        c.req.valid("param").slug,
        c.req.valid("json"),
      );
      return c.json({ data: skillDto(skill), meta }, 200);
    },
    archiveSkill: async (c) => {
      const actor = actorFrom(c);
      await enforceRateLimit(rateLimiter, actor, "write", 60);
      const slug = c.req.valid("param").slug;
      await input.knowledge.archiveSkill(actor, slug);
      return c.json({ data: { slug }, meta }, 200);
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
      const idempotencyKey = c.req.valid("header")["idempotency-key"];
      const requestedModel =
        body.model ??
        input.defaultModel ??
        process.env.GOAT_DEFAULT_CHAT_MODEL ??
        "moonshotai/kimi-k3";
      let autoResolution: AutoModelRoutingResolution | null = null;
      if (requestedModel === "auto") {
        if (body.engine !== "opencompany") {
          throw new ApiError(
            400,
            "invalid_request",
            "Auto model routing is available only for OpenCompany Chat.",
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
      const result = await input.chat.createMessage(actor, {
        ...body,
        idempotencyKey,
        model: autoResolution?.model ?? requestedModel,
      });
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
        let lastHeartbeatAt = now().getTime();
        let nextDurablePollAt = 0;
        let durableWake = true;
        let currentAttemptNumber = initialRun.attemptCount;
        try {
          while (!stream.aborted) {
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
              signal: c.req.raw.signal,
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
      if (params.readModel.startsWith("brain-")) {
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
        requestUrl: new URL(c.req.url),
      }) as never;
    },
  };

  const app = createV1Router(handlers, {
    beforeRoutes(router) {
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
        return withGoatSpan(
          GOAT_SPANS.apiRequest,
          { "goat.http_method": c.req.method, "goat.http_route": c.req.path },
          async (span) => {
            try {
              enforceCookieMutationOrigin(c.req.raw, browserOrigins);
              const authentication = await input.authenticate(c.req.raw);
              setContextValue(c, "actor", authentication.actor);
              if (authentication.refreshedSessionCookie) {
                c.header("Set-Cookie", authentication.refreshedSessionCookie);
              }
              await next();
              span.setAttributes({ "goat.http_status_code": c.res.status });
              return c.res;
            } catch (error) {
              c.res = apiErrorResponse(c, error);
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
      return apiErrorResponse(
        c,
        new ApiError(400, "invalid_request", "Request validation failed."),
      );
    },
  });

  app.onError((error, c) => {
    captureException(error, {
      event: "opencompany.api_request_failed",
      request_id: requestIdFrom(c),
    });
    return apiErrorResponse(c, error);
  });
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "opencompany-api",
      environment: process.env.OBSERVABILITY_ENV ?? process.env.NODE_ENV ?? "development",
      release:
        process.env.RENDER_GIT_COMMIT ??
        process.env.OBSERVABILITY_RELEASE ??
        process.env.GITHUB_SHA ??
        null,
      renderGitCommit: process.env.RENDER_GIT_COMMIT ?? null,
    }),
  );
  app.get("/openapi.json", (c) => c.json(createOpenApiDocument()));
  app.notFound((c) => apiErrorResponse(c, new ApiError(404, "not_found", "Route not found.")));
  return app;
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

function actorFrom(c: Context): Actor {
  const actor = getContextValue(c, "actor");
  if (!actor) throw new ApiError(401, "authentication_required", "Authentication required.");
  return actor as Actor;
}

function setContextValue(c: Context, key: string, value: unknown) {
  (c as unknown as { set(name: string, value: unknown): void }).set(key, value);
}

function getContextValue(c: Context, key: string) {
  return (c as unknown as { get(name: string): unknown }).get(key);
}

function requestIdFrom(c: Context) {
  return (getContextValue(c, "requestId") as string | undefined) ?? `request_${randomUUID()}`;
}

function contentDisposition(value: string) {
  const filename = value.replace(/[\r\n"\\]/gu, "_").trim() || "file";
  const fallback = filename.replace(/[^\x20-\x7e]/gu, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...conversation,
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
      workflow.trigger.type === "manual"
        ? workflow.trigger
        : {
            ...workflow.trigger,
            lastRunAt: workflow.trigger.lastRunAt?.toISOString() ?? null,
            nextRunAt: workflow.trigger.nextRunAt?.toISOString() ?? null,
          },
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

function skillDto(skill: Skill) {
  return {
    ...skill,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

function skillListItemDto(skill: SkillListItem) {
  return { ...skill, updatedAt: skill.updatedAt.toISOString() };
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
  try {
    await input.chat.getConversation(actor, conversationId, { includeArchived: true });
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "not_found") throw error;
    await input.tasks.getTaskByConversation(actor, conversationId);
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

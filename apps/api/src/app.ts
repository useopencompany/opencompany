import { randomUUID } from "node:crypto";
import {
  CHAT_PRESENTATION_READ_LIMIT,
  type ChatPresentationReader,
} from "@opencompany/chat-presentation";
import {
  type Actor,
  CHAT_ATTACHMENT_MAX_BYTES,
  type ChatApplicationService,
  type RunEvent,
} from "@opencompany/core";
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
import { streamSSE } from "hono/streaming";
import type { AttachmentUploadService } from "./attachments";
import type { ApiAuthenticator } from "./auth";
import type { ChatReadModelService } from "./electric-read-models";
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
  attachments: AttachmentUploadService;
  authenticate: ApiAuthenticator;
  browserOrigins?: readonly string[];
  notifier?: RunEventNotifier;
  presentation?: ChatPresentationReader;
  rateLimiter?: ApiRateLimiter;
  defaultModel?: string;
  now?: () => Date;
  readModels?: ChatReadModelService;
};

export function createApiApp(input: CreateApiAppInput) {
  const notifier: RunEventNotifier = input.notifier ?? new PollingRunEventNotifier();
  const rateLimiter = input.rateLimiter ?? new InMemoryApiRateLimiter();
  const now = input.now ?? (() => new Date());
  const browserOrigins = [...(input.browserOrigins ?? [])];
  const handlers: V1RouteHandlers = {
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
      const result = await input.chat.createMessage(actor, {
        ...body,
        idempotencyKey: c.req.valid("header")["idempotency-key"],
        model:
          body.model ??
          input.defaultModel ??
          process.env.GOAT_DEFAULT_CHAT_MODEL ??
          "moonshotai/kimi-k3",
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
      return streamSSE(c, async (stream) => {
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
                await stream.writeSSE({
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
                await stream.writeSSE({ event: dto.type, data: JSON.stringify(dto) });
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
      if (params.readModel !== "chat-conversations-v1") {
        if (!query.conversationId) {
          throw new ApiError(
            400,
            "invalid_request",
            "conversationId is required for this read model.",
          );
        }
        await input.chat.getConversation(actor, query.conversationId);
      } else if (query.conversationId) {
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
          allowMethods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
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

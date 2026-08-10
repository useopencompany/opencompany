import { randomUUID } from "node:crypto";
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
  encodeEventCursor,
  PROTOCOL_VERSION,
  RunEventSchema,
  type V1RouteHandlers,
} from "@opencompany/protocol";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import type { AttachmentUploadService } from "./attachments";
import type { ApiAuthenticator } from "./auth";
import { ApiError, errorResponse } from "./errors";
import { type ApiRateLimiter, InMemoryApiRateLimiter } from "./rate-limit";
import { PollingRunEventNotifier, type RunEventNotifier } from "./run-event-notifier";

const logger = createLogger({ service: "opencompany-api", runtime: "hono" });
const meta = { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION } as const;
const EVENT_BATCH_SIZE = 100;
const EVENT_POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled"]);
const MULTIPART_ENVELOPE_BYTES = 64 * 1024;

export type CreateApiAppInput = {
  chat: ChatApplicationService;
  attachments: AttachmentUploadService;
  authenticate: ApiAuthenticator;
  notifier?: RunEventNotifier;
  rateLimiter?: ApiRateLimiter;
  defaultModel?: string;
  now?: () => Date;
};

export function createApiApp(input: CreateApiAppInput) {
  const notifier: RunEventNotifier = input.notifier ?? new PollingRunEventNotifier();
  const rateLimiter = input.rateLimiter ?? new InMemoryApiRateLimiter();
  const now = input.now ?? (() => new Date());
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
      const headerCursor = c.req.valid("header")["last-event-id"];
      if (queryCursor && headerCursor && queryCursor !== headerCursor) {
        throw new ApiError(400, "invalid_request", "Conflicting event cursors were provided.");
      }
      let sequence: number;
      try {
        sequence = decodeEventCursor(queryCursor ?? headerCursor);
      } catch {
        throw new ApiError(400, "invalid_request", "The event cursor is invalid.");
      }
      await input.chat.getRun(actor, runId);
      return streamSSE(c, async (stream) => {
        let lastHeartbeatAt = now().getTime();
        try {
          while (!stream.aborted) {
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
            if (page.events.length >= EVENT_BATCH_SIZE) continue;
            const run = await input.chat.getRun(actor, runId);
            if (TERMINAL_RUN_STATUSES.has(run.status)) return;
            const currentTime = now().getTime();
            if (currentTime - lastHeartbeatAt >= HEARTBEAT_MS) {
              await stream.write(": keep-alive\n\n");
              lastHeartbeatAt = currentTime;
            }
            await notifier.wait({
              runId,
              signal: c.req.raw.signal,
              timeoutMs: EVENT_POLL_MS,
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
  };

  const app = createV1Router(handlers, {
    beforeRoutes(router) {
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
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/openapi.json", (c) => c.json(createOpenApiDocument()));
  app.notFound((c) => apiErrorResponse(c, new ApiError(404, "not_found", "Route not found.")));
  return app;
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

import { createRoute, OpenAPIHono, type RouteHandler, z } from "@hono/zod-openapi";
import { RunEventSchema } from "./events";
import {
  AttachmentUploadBodySchema,
  AttachmentUploadEnvelopeSchema,
  CancelRunEnvelopeSchema,
  ConversationEnvelopeSchema,
  ConversationPageSchema,
  CreateMessageBodySchema,
  CreateMessageEnvelopeSchema,
  CursorSchema,
  ErrorEnvelopeSchema,
  MessagePageSchema,
  ResolveApprovalBodySchema,
  ResolveApprovalEnvelopeSchema,
  ResourceIdSchema,
  RunEnvelopeSchema,
} from "./schemas";
import { OPENAPI_DOCUMENT_VERSION, PROTOCOL_VERSION } from "./version";

const actorSecurity = [{ bearerAuth: [] }, { sessionCookie: [] }];
const errorResponse = {
  description: "A structured protocol error.",
  content: { "application/json": { schema: ErrorEnvelopeSchema } },
} as const;

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
    query: z.object({ cursor: CursorSchema.optional() }),
  },
  responses: {
    200: {
      description: "Typed semantic events. Each SSE data field is a RunEvent JSON object.",
      content: { "text/event-stream": { schema: RunEventSchema } },
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

export type V1RouteHandlers = {
  listConversations: RouteHandler<typeof listConversationsRoute>;
  getConversation: RouteHandler<typeof getConversationRoute>;
  listMessages: RouteHandler<typeof listMessagesRoute>;
  createMessage: RouteHandler<typeof createMessageRoute>;
  uploadAttachment: RouteHandler<typeof uploadAttachmentRoute>;
  getRun: RouteHandler<typeof getRunRoute>;
  streamRunEvents: RouteHandler<typeof streamRunEventsRoute>;
  cancelRun: RouteHandler<typeof cancelRunRoute>;
  resolveApproval: RouteHandler<typeof resolveApprovalRoute>;
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
    .openapi(listConversationsRoute, handlers.listConversations)
    .openapi(getConversationRoute, handlers.getConversation)
    .openapi(listMessagesRoute, handlers.listMessages)
    .openapi(createMessageRoute, handlers.createMessage)
    .openapi(uploadAttachmentRoute, handlers.uploadAttachment)
    .openapi(getRunRoute, handlers.getRun)
    .openapi(streamRunEventsRoute, handlers.streamRunEvents)
    .openapi(cancelRunRoute, handlers.cancelRun)
    .openapi(resolveApprovalRoute, handlers.resolveApproval);
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

const contractDocumentHandlers: V1RouteHandlers = {
  listConversations: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  getConversation: (c) => c.json({ data: placeholderConversation, meta }, 200),
  listMessages: (c) => c.json({ data: [], nextCursor: null, meta }, 200),
  createMessage: (c) =>
    c.json(
      {
        data: {
          conversationId: "conversation_contract",
          messageId: "message_contract",
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
};

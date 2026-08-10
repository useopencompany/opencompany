import {
  type Actor,
  ChatApplicationService,
  type ChatRepository,
  type CreateMessageCommand,
} from "@opencompany/core";
import { describe, expect, it } from "vitest";
import { createApiApp } from "./app";
import type { AttachmentUploadService } from "./attachments";
import { ApiError } from "./errors";
import type { ApiRateLimiter } from "./rate-limit";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session",
};
const createdAt = new Date("2026-08-10T20:00:00.000Z");

describe("canonical Hono API", () => {
  it("returns versioned structured authentication and validation errors", async () => {
    const repository = fakeRepository();
    const unauthenticated = createApiApp({
      chat: new ChatApplicationService(repository),
      attachments: fakeAttachments(),
      authenticate: async () => {
        throw new ApiError(401, "authentication_required", "Authentication required.");
      },
    });
    const unauthorized = await unauthenticated.request("/v1/conversations", {
      headers: { "X-Request-Id": "request_test" },
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: "authentication_required", requestId: "request_test" },
      meta: { apiVersion: "v1" },
    });

    const app = testApp(repository);
    const invalid = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "send_1" },
      body: JSON.stringify({ content: "", engine: "opencompany" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_request", retryable: false },
      meta: { apiVersion: "v1" },
    });
  });

  it("accepts an idempotent Message command and applies the server model default", async () => {
    const repository = fakeRepository();
    const app = testApp(repository);
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "send_1" },
      body: JSON.stringify({ content: "Hello", engine: "opencompany" }),
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        conversationId: "conversation_1",
        messageId: "message_user_1",
        runId: "run_1",
        transactionId: "42",
        replayed: false,
      },
    });
    expect(repository.lastCommand).toMatchObject({
      idempotencyKey: "send_1",
      model: "provider/default",
    });
  });

  it("streams only events after Last-Event-ID and terminates after a durable terminal Run", async () => {
    const repository = fakeRepository();
    const app = testApp(repository);
    const response = await app.request("/v1/runs/run_1/events", {
      headers: { "Last-Event-ID": "v1:1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).not.toContain("v1:1");
    expect(body).toContain("id: v1:2");
    expect(body).toContain("event: message.content_updated");
    expect(body).toContain('"complete":true');
    expect(body).toContain("id: v1:3");
    expect(body).toContain("event: run.completed");

    const conflict = await app.request("/v1/runs/run_1/events?cursor=v1:1", {
      headers: { "Last-Event-ID": "v1:2" },
    });
    expect(conflict.status).toBe(400);
  });

  it("uploads a private attachment through the typed multipart operation", async () => {
    const uploaded: File[] = [];
    const attachments: AttachmentUploadService = {
      async upload({ file }) {
        uploaded.push(file);
        return {
          id: "attachment_1",
          format: "pdf",
          filename: file.name,
          mediaType: file.type,
          sizeBytes: file.size,
          expiresAt: new Date("2026-08-11T20:00:00.000Z"),
        };
      },
    };
    const app = testApp(fakeRepository(), { attachments });
    const form = new FormData();
    form.set("file", new File(["pdf"], "brief.pdf", { type: "application/pdf" }));
    const response = await app.request("/v1/attachments", { method: "POST", body: form });
    expect(response.status).toBe(201);
    expect(uploaded).toHaveLength(1);
    const json = await response.json();
    expect(json).toMatchObject({
      data: {
        attachment: {
          id: "attachment_1",
          filename: "brief.pdf",
          kind: "document",
        },
      },
    });
    expect(JSON.stringify(json)).not.toMatch(/blob|pathname|url/iu);
  });

  it("rejects oversized multipart bodies before buffering the upload", async () => {
    let uploadCalled = false;
    const app = testApp(fakeRepository(), {
      attachments: {
        async upload() {
          uploadCalled = true;
          throw new Error("Oversized uploads must not reach storage.");
        },
      },
    });
    const response = await app.request("/v1/attachments", {
      method: "POST",
      headers: {
        "Content-Length": String(21 * 1024 * 1024),
        "Content-Type": "multipart/form-data; boundary=test",
        "X-Request-Id": "request_oversized",
      },
      body: "--test--\r\n",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request", requestId: "request_oversized", retryable: false },
      meta: { apiVersion: "v1" },
    });
    expect(uploadCalled).toBe(false);
  });

  it("enforces rate limits without making them a durability dependency", async () => {
    const limiter: ApiRateLimiter = {
      consume: () => ({ allowed: false, retryAfterSeconds: 7 }),
    };
    const app = testApp(fakeRepository(), { rateLimiter: limiter });
    const response = await app.request("/v1/conversations");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
  });
});

function testApp(
  repository: FakeRepository,
  overrides: Partial<Parameters<typeof createApiApp>[0]> = {},
) {
  return createApiApp({
    chat: new ChatApplicationService(repository),
    attachments: fakeAttachments(),
    authenticate: async () => ({ actor }),
    defaultModel: "provider/default",
    ...overrides,
  });
}

function fakeAttachments(): AttachmentUploadService {
  return {
    upload: async () => {
      throw new Error("Unexpected attachment upload.");
    },
  };
}

type FakeRepository = ChatRepository & { lastCommand: CreateMessageCommand | null };

function fakeRepository(): FakeRepository {
  const repository: FakeRepository = {
    lastCommand: null,
    listConversations: async () => ({
      conversations: [
        {
          id: "conversation_1",
          title: "Chat",
          engine: "opencompany",
          model: "provider/default",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      nextCursor: null,
    }),
    getConversation: async () => ({
      id: "conversation_1",
      title: "Chat",
      engine: "opencompany",
      model: "provider/default",
      createdAt,
      updatedAt: createdAt,
    }),
    listMessages: async () => ({ messages: [], nextCursor: null }),
    createMessageAndRun: async ({ command }) => {
      repository.lastCommand = command;
      return {
        conversationId: "conversation_1",
        messageId: "message_user_1",
        runId: "run_1",
        transactionId: "42",
        idempotentReplay: false,
      };
    },
    getRun: async () => ({
      id: "run_1",
      conversationId: "conversation_1",
      triggerMessageId: "message_user_1",
      status: "completed",
      engine: "opencompany",
      model: "provider/default",
      attemptCount: 1,
      createdAt,
      updatedAt: createdAt,
    }),
    listRunEvents: async ({ afterSequence }) => {
      const events = [
        {
          id: "event_1",
          runId: "run_1",
          attemptId: null,
          sequence: 1,
          type: "run.queued" as const,
          payload: { conversationId: "conversation_1", triggerMessageId: "message_user_1" },
          createdAt,
        },
        {
          id: "event_2",
          runId: "run_1",
          attemptId: "attempt_1",
          sequence: 2,
          type: "message.content_updated" as const,
          payload: { messageId: "message_assistant_1", content: "Done", complete: true },
          createdAt,
        },
        {
          id: "event_3",
          runId: "run_1",
          attemptId: "attempt_1",
          sequence: 3,
          type: "run.completed" as const,
          payload: { messageId: "message_assistant_1" },
          createdAt,
        },
      ];
      const filtered = events.filter((event) => event.sequence > afterSequence);
      return { events: filtered, nextSequence: filtered.at(-1)?.sequence ?? afterSequence };
    },
    cancelRun: async ({ runId }) => ({
      runId,
      status: "canceled",
      idempotentReplay: false,
    }),
    resolveApproval: async ({ command }) => ({
      approvalId: command.approvalId,
      runId: command.runId,
      resolution: command.resolution,
      idempotentReplay: false,
    }),
  };
  return repository;
}

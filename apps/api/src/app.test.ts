import { once } from "node:events";
import { request as requestHttp } from "node:http";
import { serve } from "@hono/node-server";
import type { ChatPresentationReader } from "@opencompany/chat-presentation";
import {
  type Actor,
  ChatApplicationService,
  type ChatRepository,
  type CreateMessageCommand,
  type CreateTaskCommand,
  type Task,
  TaskApplicationService,
  type TaskRepository,
} from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app";
import type { AttachmentUploadService } from "./attachments";
import { ApiError } from "./errors";
import type { ApiRateLimiter } from "./rate-limit";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["chat:read", "chat:write", "task:read", "task:write"],
  authenticationMethod: "session",
};
const createdAt = new Date("2026-08-10T20:00:00.000Z");

describe("canonical Hono API", () => {
  it("reports the deployed API release for expected-SHA health gates", async () => {
    const previousRelease = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT = "api-release-sha";
    try {
      const response = await testApp(fakeRepository()).request("/healthz");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "opencompany-api",
        release: "api-release-sha",
        renderGitCommit: "api-release-sha",
      });
    } finally {
      if (previousRelease === undefined) {
        delete process.env.RENDER_GIT_COMMIT;
      } else {
        process.env.RENDER_GIT_COMMIT = previousRelease;
      }
    }
  });

  it("returns versioned structured authentication and validation errors", async () => {
    const repository = fakeRepository();
    const unauthenticated = createApiApp({
      chat: new ChatApplicationService(repository),
      tasks: new TaskApplicationService(fakeTaskRepository()),
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

  it("serves the canonical Task contract without exposing persistence vocabulary", async () => {
    const tasks = fakeTaskRepository();
    const app = testApp(fakeRepository(), {
      tasks: new TaskApplicationService(tasks),
      defaultModel: "moonshotai/kimi-k3",
    });
    const created = await app.request("/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "task-create-1" },
      body: JSON.stringify({ goal: "Prepare a launch brief", engine: "opencompany" }),
    });

    expect(created.status).toBe(202);
    await expect(created.json()).resolves.toMatchObject({
      data: {
        task: {
          id: "task_1",
          conversationId: "conversation_task_1",
          status: "queued",
          source: "manual",
        },
        messageId: "message_task_user_1",
        runId: "run_task_1",
        transactionId: "43",
        replayed: false,
      },
      meta: { apiVersion: "v1" },
    });
    expect(tasks.lastCommand).toMatchObject({
      idempotencyKey: "task-create-1",
      goal: "Prepare a launch brief",
      engine: "opencompany",
      model: "moonshotai/kimi-k3",
      source: "manual",
    });

    const listed = await app.request("/v1/tasks?archived=false");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toMatch(
      /workos|session_id|harness|lease|goat_/iu,
    );
    const archived = await app.request("/v1/tasks/task_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({
      data: { task: { id: "task_1", status: "archived" }, transactionId: "44" },
    });
  });

  it("allows credentialed browser preflight only for configured origins", async () => {
    const app = testApp(fakeRepository(), {
      browserOrigins: ["https://my.opencompany.chat"],
    });
    const allowed = await app.request("/v1/messages", {
      method: "OPTIONS",
      headers: {
        Origin: "https://my.opencompany.chat",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://my.opencompany.chat");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");

    const disallowed = await app.request("/v1/messages", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(disallowed.status).toBe(204);
    expect(disallowed.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("rejects cookie mutations without an allowed Origin while preserving bearer clients", async () => {
    const repository = fakeRepository();
    const app = testApp(repository, {
      browserOrigins: ["https://my.opencompany.chat"],
    });
    const body = JSON.stringify({ content: "Hello", engine: "opencompany" });
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "send_1" };

    for (const origin of [undefined, "https://attacker.example"]) {
      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: { ...headers, ...(origin ? { Origin: origin } : {}) },
        body,
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    }

    const allowed = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...headers, Origin: "https://my.opencompany.chat" },
      body,
    });
    expect(allowed.status).toBe(202);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://my.opencompany.chat");

    const bearer = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer native-token" },
      body,
    });
    expect(bearer.status).toBe(202);
  });

  it("exposes durable cursor and Electric headers to the configured browser origin", async () => {
    const app = testApp(fakeRepository(), {
      browserOrigins: ["https://my.opencompany.chat"],
    });
    const response = await app.request("/v1/runs/run_1/events", {
      headers: { Origin: "https://my.opencompany.chat" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "X-OpenCompany-Run-Status",
    );
    expect(response.headers.get("access-control-expose-headers")).toContain("Electric-Handle");
    expect(response.headers.get("access-control-expose-headers")).toContain("Electric-Up-To-Date");
    await response.body?.cancel();
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
        assistantMessageId: "message_assistant_1",
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

  it("resolves Auto inside the authenticated command boundary", async () => {
    const repository = fakeRepository();
    const resolveAutoModel = vi.fn(async () => ({
      model: "moonshotai/kimi-k2.6",
      source: "idempotency_replay" as const,
    }));
    const app = testApp(repository, { resolveAutoModel });
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "send_auto_1" },
      body: JSON.stringify({
        clientConversationId: "conversation_auto",
        clientMessageId: "message_auto",
        content: "Route this",
        engine: "opencompany",
        model: "auto",
        attachmentIds: ["attachment_1"],
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: { model: "moonshotai/kimi-k2.6", replayed: false },
    });
    expect(resolveAutoModel).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      idempotencyKey: "send_auto_1",
      clientMessageId: "message_auto",
      prompt: "Route this",
      attachmentIds: ["attachment_1"],
    });
    expect(repository.lastCommand).toMatchObject({
      idempotencyKey: "send_auto_1",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("fails closed when Auto is not composed into the API", async () => {
    const response = await testApp(fakeRepository()).request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "send_auto_2" },
      body: JSON.stringify({ content: "Route this", engine: "opencompany", model: "auto" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unavailable", retryable: true },
    });
  });

  it("rejects Auto for cloud-coding engine commands", async () => {
    const resolveAutoModel = vi.fn();
    const response = await testApp(fakeRepository(), { resolveAutoModel }).request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "send_auto_3" },
      body: JSON.stringify({ content: "Route this", engine: "claude_code", model: "auto" }),
    });

    expect(response.status).toBe(400);
    expect(resolveAutoModel).not.toHaveBeenCalled();
  });

  it("streams only events after Last-Event-ID and terminates after a durable terminal Run", async () => {
    const repository = fakeRepository();
    const app = testApp(repository);
    const response = await app.request("/v1/runs/run_1/events", {
      headers: { "Last-Event-ID": "v1:1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-opencompany-run-status")).toBe("completed");
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

  it("leaves hop-by-hop SSE framing to the Node server adapter", async () => {
    const app = testApp(fakeRepository());
    const directResponse = await app.request("/v1/runs/run_1/events");
    expect(directResponse.headers.get("connection")).toBeNull();
    expect(directResponse.headers.get("transfer-encoding")).toBeNull();
    expect(directResponse.headers.get("cache-control")).toBe("private, no-store, no-transform");
    await directResponse.body?.cancel();

    const server = serve({ fetch: app.fetch, port: 0 });
    if (!server.listening) await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
      const response = await rawHttpResponse(address.port, "/v1/runs/run_1/events");
      const transferEncodingHeaderCount = response.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === "transfer-encoding",
      ).length;

      expect(response.statusCode).toBe(200);
      expect(transferEncodingHeaderCount).toBe(1);
      expect(response.body).toContain("event: run.completed");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("closes the SSE response at a durable approval boundary", async () => {
    const repository = fakeRepository();
    repository.getRun = async () => ({
      id: "run_1",
      conversationId: "conversation_1",
      triggerMessageId: "message_user_1",
      status: "paused",
      engine: "opencompany",
      model: "provider/default",
      attemptCount: 1,
      createdAt,
      updatedAt: createdAt,
    });
    repository.listRunEvents = async ({ afterSequence }) => ({
      events:
        afterSequence > 0
          ? []
          : [
              {
                id: "event_paused",
                runId: "run_1",
                attemptId: "attempt_1",
                sequence: 1,
                type: "run.paused",
                payload: { reason: "approval_required" },
                createdAt,
              },
            ],
      nextSequence: 1,
    });
    const response = await testApp(repository).request("/v1/runs/run_1/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-opencompany-run-status")).toBe("paused");
    await expect(response.text()).resolves.toContain("event: run.paused");
  });

  it("fans one Redis hot stream out through multiple API instances", async () => {
    const presentation = presentationReader(({ afterStreamId }) =>
      afterStreamId ? [] : [presentationEntry("1786449600000-0", "Hello")],
    );
    const first = streamingFixture({ presentation });
    const second = streamingFixture({ presentation });

    const [firstBody, secondBody] = await Promise.all([
      responseBody(first.app.request("/v1/runs/run_1/events")),
      responseBody(second.app.request("/v1/runs/run_1/events")),
    ]);

    for (const body of [firstBody, secondBody]) {
      expect(body).toContain("event: message.presentation_delta");
      expect(body).toContain('"delta":"Hello"');
      expect(body).not.toContain("id: p1:");
      expect(body.indexOf('"complete":true')).toBeLessThan(body.indexOf("event: run.completed"));
    }
  });

  it("resumes transient replay independently from the durable cursor", async () => {
    const read = vi.fn(async ({ afterStreamId }: { afterStreamId?: string }) => ({
      status: "available" as const,
      entries: [presentationEntry("1786449600050-0", " world", 5)],
      nextStreamId: "1786449600050-0",
    }));
    const fixture = streamingFixture({ presentation: { read } });
    const response = await fixture.app.request(
      "/v1/runs/run_1/events?cursor=v1:1&presentationCursor=p1:1786449600000-0",
    );
    const body = await response.text();

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ afterStreamId: "1786449600000-0" }),
    );
    expect(body).toContain('"presentationCursor":"p1:1786449600050-0"');
    expect(body).toContain("id: v1:2");
  });

  it("falls back to durable terminal output when the hot window expired", async () => {
    const fixture = streamingFixture({ presentation: presentationReader(() => []) });
    const body = await responseBody(fixture.app.request("/v1/runs/run_1/events"));

    expect(body).not.toContain("message.presentation_delta");
    expect(body).toContain('"content":"Durable final"');
    expect(body).toContain("event: run.completed");
  });

  it("keeps streaming durably when Redis fails mid-stream", async () => {
    let reads = 0;
    const presentation: ChatPresentationReader = {
      async read() {
        reads += 1;
        return reads === 1
          ? {
              status: "available",
              entries: [presentationEntry("1786449600000-0", "Hot")],
              nextStreamId: "1786449600000-0",
            }
          : { status: "unavailable", entries: [], nextStreamId: "1786449600000-0" };
      },
    };
    const fixture = streamingFixture({ presentation, waitsBeforeTerminal: 2 });
    const body = await responseBody(fixture.app.request("/v1/runs/run_1/events"));

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(body).toContain('"delta":"Hot"');
    expect(body).toContain('"content":"Durable final"');
    expect(body).toContain("event: run.completed");
  });

  it("drops stale recovered-Attempt frames and presents only the current Attempt", async () => {
    const presentation = presentationReader(() => [
      presentationEntry("1786449600000-0", "stale", 0, 1),
      presentationEntry("1786449600050-0", "current", 0, 2),
    ]);
    const fixture = streamingFixture({ presentation, attemptCount: 2 });
    const body = await responseBody(fixture.app.request("/v1/runs/run_1/events"));

    expect(body).not.toContain('"delta":"stale"');
    expect(body).toContain('"delta":"current"');
  });

  it("batches bounded hot replay for a slow consumer before durable completion", async () => {
    const allEntries = Array.from({ length: 105 }, (_, index) =>
      presentationEntry(`${1786449600000 + index}-0`, "x", index),
    );
    const limits: number[] = [];
    const presentation: ChatPresentationReader = {
      async read({ afterStreamId, limit = 100 }) {
        limits.push(limit);
        const start = afterStreamId
          ? allEntries.findIndex((entry) => entry.streamId === afterStreamId) + 1
          : 0;
        const entries = allEntries.slice(start, start + limit);
        return {
          status: "available",
          entries,
          nextStreamId: entries.at(-1)?.streamId ?? afterStreamId ?? null,
        };
      },
    };
    const fixture = streamingFixture({ presentation });
    const body = await responseBody(fixture.app.request("/v1/runs/run_1/events"));

    expect(body.match(/event: message\.presentation_delta/gu)).toHaveLength(105);
    expect(limits.every((limit) => limit === 100)).toBe(true);
    expect(body).toContain("event: run.completed");
  });

  it("orders the final complete Message before durable cancellation", async () => {
    const fixture = streamingFixture({ finalStatus: "canceled" });
    const body = await responseBody(fixture.app.request("/v1/runs/run_1/events"));

    expect(body.indexOf('"complete":true')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('"complete":true')).toBeLessThan(body.indexOf("event: run.canceled"));
  });

  it("updates Conversation state through the canonical command boundary", async () => {
    const repository = fakeRepository();
    const app = testApp(repository);
    const response = await app.request("/v1/conversations/conversation_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { conversationId: "conversation_1", transactionId: "42" },
    });

    const invalid = await app.request("/v1/conversations/conversation_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
  });

  it("authorizes a child read model, including archived Conversations, before contacting Electric", async () => {
    const repository = fakeRepository();
    const getConversation = vi.fn(async () => null);
    repository.getConversation = getConversation;
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(repository, { readModels: { stream } });
    const response = await app.request(
      "/v1/read-models/chat-messages-v1?conversationId=conversation_other",
    );
    expect(response.status).toBe(404);
    expect(getConversation).toHaveBeenCalledWith({
      actor,
      conversationId: "conversation_other",
      includeArchived: true,
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it("authorizes canonical Message and Run read models through their owning Task", async () => {
    const repository = fakeRepository();
    repository.getConversation = vi.fn(async () => null);
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(repository, { readModels: { stream } });

    const response = await app.request(
      "/v1/read-models/chat-messages-v1?conversationId=conversation_task_1",
    );

    expect(response.status).toBe(200);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        readModel: "chat-messages-v1",
        conversationId: "conversation_task_1",
      }),
    );
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
    tasks: new TaskApplicationService(fakeTaskRepository()),
    attachments: fakeAttachments(),
    authenticate: async () => ({ actor }),
    defaultModel: "provider/default",
    ...overrides,
  });
}

async function responseBody(response: Response | Promise<Response>) {
  return (await response).text();
}

function rawHttpResponse(port: number, path: string) {
  return new Promise<{ body: string; rawHeaders: string[]; statusCode: number | undefined }>(
    (resolve, reject) => {
      const request = requestHttp({ host: "127.0.0.1", port, path }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            rawHeaders: response.rawHeaders,
            statusCode: response.statusCode,
          }),
        );
      });
      request.on("error", reject);
      request.end();
    },
  );
}

function fakeAttachments(): AttachmentUploadService {
  return {
    upload: async () => {
      throw new Error("Unexpected attachment upload.");
    },
  };
}

type FakeRepository = ChatRepository & { lastCommand: CreateMessageCommand | null };

type FakeTaskRepository = TaskRepository & { lastCommand: CreateTaskCommand | null };

function fakeTaskRepository(): FakeTaskRepository {
  const repository: FakeTaskRepository = {
    lastCommand: null,
    listTasks: async () => ({ tasks: [fakeTask()], nextCursor: null }),
    getTask: async ({ taskId }) => (taskId === "task_1" ? fakeTask() : null),
    getTaskByConversation: async ({ conversationId }) =>
      conversationId === "conversation_task_1" ? fakeTask() : null,
    createTaskAndRun: async ({ command }) => {
      repository.lastCommand = command;
      return {
        task: fakeTask({
          name: command.name ?? "Task",
          goal: command.goal,
          source: command.source,
          engine: command.engine,
          model: command.model,
        }),
        messageId: "message_task_user_1",
        assistantMessageId: "message_task_assistant_1",
        runId: "run_task_1",
        transactionId: "43",
        idempotentReplay: false,
      };
    },
    updateTask: async () => ({ task: fakeTask({ status: "archived" }), transactionId: "44" }),
  };
  return repository;
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    displayId: "TASK-1",
    name: "Prepare the launch",
    goal: "Prepare a launch brief",
    conversationId: "conversation_task_1",
    status: "queued" as const,
    source: "manual" as const,
    engine: "opencompany" as const,
    model: "provider/default",
    workflowId: null,
    scheduleId: null,
    scheduledFor: null,
    outcome: { result: null, error: null, reportedStatus: null, comment: null },
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

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
    updateConversation: async ({ conversationId }) => ({
      conversationId,
      transactionId: "42",
    }),
    listMessages: async () => ({ messages: [], nextCursor: null }),
    createMessageAndRun: async ({ command }) => {
      repository.lastCommand = command;
      return {
        conversationId: "conversation_1",
        messageId: "message_user_1",
        assistantMessageId: "message_assistant_1",
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

function presentationEntry(streamId: string, delta: string, startOffset = 0, attemptNumber = 1) {
  return {
    streamId,
    frame: {
      runId: "run_1",
      attemptNumber,
      schemaVersion: 1 as const,
      occurredAt: "2026-08-11T10:00:00.000Z",
      type: "message.presentation_delta" as const,
      payload: {
        messageId: "message_assistant_1",
        startOffset,
        endOffset: startOffset + delta.length,
        delta,
      },
    },
  };
}

function presentationReader(
  entries: (input: { afterStreamId?: string }) => ReturnType<typeof presentationEntry>[],
): ChatPresentationReader {
  return {
    async read(input) {
      const values = entries(input);
      return {
        status: "available",
        entries: values,
        nextStreamId: values.at(-1)?.streamId ?? input.afterStreamId ?? null,
      };
    },
  };
}

function streamingFixture(options: {
  presentation?: ChatPresentationReader;
  attemptCount?: number;
  waitsBeforeTerminal?: number;
  finalStatus?: "completed" | "canceled";
}) {
  const repository = fakeRepository();
  const attemptCount = options.attemptCount ?? 1;
  const finalStatus = options.finalStatus ?? "completed";
  let terminal = false;
  let waits = 0;
  repository.getRun = async () => ({
    id: "run_1",
    conversationId: "conversation_1",
    triggerMessageId: "message_user_1",
    status: terminal ? finalStatus : "running",
    engine: "opencompany",
    model: "provider/default",
    attemptCount,
    createdAt,
    updatedAt: createdAt,
  });
  repository.listRunEvents = async ({ afterSequence }) => {
    const terminalEvent =
      finalStatus === "completed"
        ? {
            id: "event_3",
            runId: "run_1",
            attemptId: `attempt_${attemptCount}`,
            sequence: 3,
            type: "run.completed" as const,
            payload: { messageId: "message_assistant_1" },
            createdAt,
          }
        : {
            id: "event_3",
            runId: "run_1",
            attemptId: `attempt_${attemptCount}`,
            sequence: 3,
            type: "run.canceled" as const,
            payload: { by: "user" as const },
            createdAt,
          };
    const events = [
      {
        id: "event_1",
        runId: "run_1",
        attemptId: `attempt_${attemptCount}`,
        sequence: 1,
        type: "run.started" as const,
        payload: { attemptNumber: attemptCount },
        createdAt,
      },
      ...(terminal
        ? [
            {
              id: "event_2",
              runId: "run_1",
              attemptId: `attempt_${attemptCount}`,
              sequence: 2,
              type: "message.content_updated" as const,
              payload: {
                messageId: "message_assistant_1",
                content: "Durable final",
                complete: true,
              },
              createdAt,
            },
            terminalEvent,
          ]
        : []),
    ].filter((event) => event.sequence > afterSequence);
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence };
  };
  const app = testApp(repository, {
    ...(options.presentation ? { presentation: options.presentation } : {}),
    notifier: {
      async wait() {
        waits += 1;
        if (waits >= (options.waitsBeforeTerminal ?? 1)) {
          terminal = true;
          return true;
        }
        return false;
      },
    },
  });
  return { app };
}

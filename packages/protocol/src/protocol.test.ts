import { describe, expect, it } from "vitest";
import { createOpenCompanyClient } from "./client";
import { decodeEventCursor, encodeEventCursor, RunEventSchema } from "./events";
import { createOpenApiDocument } from "./routes";
import {
  ChatReadModelSchema,
  CreateMessageBodySchema,
  CreateTaskBodySchema,
  MessageReadModelSchema,
  ResolveApprovalBodySchema,
} from "./schemas";

describe("headless protocol", () => {
  it("publishes every canonical /v1 operation in OpenAPI", () => {
    const document = createOpenApiDocument();
    expect(Object.keys(document.paths ?? {})).toEqual([
      "/v1/tasks",
      "/v1/tasks/{taskId}",
      "/v1/tasks/{taskId}/summary",
      "/v1/compatibility/tasks",
      "/v1/compatibility/tasks/{taskId}/history",
      "/v1/conversations",
      "/v1/conversations/{conversationId}",
      "/v1/conversations/{conversationId}/messages",
      "/v1/messages",
      "/v1/attachments",
      "/v1/runs/{runId}",
      "/v1/runs/{runId}/events",
      "/v1/runs/{runId}/cancel",
      "/v1/runs/{runId}/approvals/{approvalId}",
      "/v1/read-models/{readModel}",
    ]);
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("rejects adapter and physical persistence names from client commands", () => {
    expect(
      CreateMessageBodySchema.safeParse({
        content: "Hello",
        engine: "opencompany",
        model: "provider/model",
        workspaceId: "workspace_1",
        sessionId: "goat_chat_1",
        turnId: "goat_codex_chat_turn_1",
        workosUserId: "user_1",
      }).success,
    ).toBe(false);
    expect(
      CreateTaskBodySchema.safeParse({
        goal: "Research the market",
        engine: "opencompany",
        workspaceId: "workspace_1",
        sessionId: "goat_chat_1",
        harnessSpec: {},
      }).success,
    ).toBe(false);
  });

  it("validates skill mentions and keeps physical read-model fields server-side", () => {
    expect(
      CreateMessageBodySchema.safeParse({
        content: "Use the sales skill",
        engine: "opencompany",
        mentions: [{ kind: "skill", id: "sales" }],
      }).success,
    ).toBe(true);
    expect(ChatReadModelSchema.safeParse("goat.chat_messages").success).toBe(false);
    expect(
      MessageReadModelSchema.safeParse({
        id: "message_1",
        conversationId: "conversation_1",
        role: "assistant",
        content: "Done",
        taskId: null,
        presentation: null,
        attachments: null,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        actor_id: "must-not-cross",
      }).success,
    ).toBe(false);
  });

  it("round-trips opaque versioned event cursors", () => {
    expect(encodeEventCursor(42)).toBe("v1:42");
    expect(decodeEventCursor("v1:42")).toBe(42);
    expect(() => decodeEventCursor("42")).toThrow(/cursor/i);
  });

  it("validates semantic event payloads without raw provider events", () => {
    expect(
      RunEventSchema.safeParse({
        id: "event_1",
        runId: "run_1",
        attemptId: "attempt_1",
        cursor: "v1:1",
        schemaVersion: 1,
        occurredAt: "2026-08-10T00:00:00.000Z",
        type: "tool.started",
        payload: { toolCallId: "tool_1", name: "brain.query", rawEvent: {} },
      }).success,
    ).toBe(false);
  });

  it("keeps approval answers exclusive to answered resolutions", () => {
    expect(
      ResolveApprovalBodySchema.safeParse({ resolution: "answered", answer: "continue" }).success,
    ).toBe(true);
    expect(
      ResolveApprovalBodySchema.safeParse({ resolution: "answered", answer: "   " }).success,
    ).toBe(false);
    expect(
      ResolveApprovalBodySchema.safeParse({ resolution: "approved", answer: "unexpected" }).success,
    ).toBe(false);
  });

  it("exposes an inferred Hono client rooted at the canonical version", () => {
    const client = createOpenCompanyClient("https://api.example.test");
    expect(client.v1.messages.$url().pathname).toBe("/v1/messages");
    expect(client.v1.tasks[":taskId"].$url({ param: { taskId: "task_1" } }).pathname).toBe(
      "/v1/tasks/task_1",
    );
    expect(client.v1.runs[":runId"].events.$url({ param: { runId: "run_1" } }).pathname).toBe(
      "/v1/runs/run_1/events",
    );
  });
});

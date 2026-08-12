import { describe, expect, it } from "vitest";
import { createOpenCompanyClient } from "./client";
import { decodeEventCursor, encodeEventCursor, RunEventSchema } from "./events";
import { createOpenApiDocument } from "./routes";
import {
  ChatReadModelSchema,
  CreateMessageBodySchema,
  CreateTaskBodySchema,
  InvokeWorkflowBodySchema,
  MessageReadModelSchema,
  ReadModelSchema,
  ResolveApprovalBodySchema,
  UpdateWorkflowBodySchema,
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
      "/v1/workflows",
      "/v1/workflows/{workflowId}",
      "/v1/workflows/{workflowId}/archive",
      "/v1/workflows/{workflowId}/invoke",
      "/v1/workflows/{workflowId}/run-now",
      "/v1/schedules",
      "/v1/schedules/{scheduleId}",
      "/v1/schedules/{scheduleId}/archive",
      "/v1/schedules/{scheduleId}/run-now",
      "/v1/brains/{brainId}",
      "/v1/brains/{brainId}/overview",
      "/v1/brains/{brainId}/source-items",
      "/v1/brains/{brainId}/sources",
      "/v1/brains/{brainId}/sources/{integrationId}",
      "/v1/integrations/{integrationId}/brain-source-options",
      "/v1/brains/{brainId}/documents",
      "/v1/brains/{brainId}/assets",
      "/v1/brains/{brainId}/assets/{documentId}/replace",
      "/v1/brain-assets/{documentId}",
      "/v1/brains/{brainId}/documents/{documentId}",
      "/v1/brains/{brainId}/documents/{documentId}/rename",
      "/v1/brains/{brainId}/documents/{documentId}/delete",
      "/v1/brains/{brainId}/folders",
      "/v1/brains/{brainId}/folders/rename",
      "/v1/brains/{brainId}/folders/delete",
      "/v1/wiki/pages",
      "/v1/wiki/pages/{slug}",
      "/v1/wiki/pages/{slug}/delete",
      "/v1/wiki/pages/{slug}/timeline",
      "/v1/skills",
      "/v1/skills/imports/preview",
      "/v1/skills/imports",
      "/v1/skills/catalog",
      "/v1/skills/{slug}",
      "/v1/skills/{slug}/archive",
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
    expect(ReadModelSchema.safeParse("workflows-v1").success).toBe(true);
    expect(ReadModelSchema.safeParse("workflow-schedules-v1").success).toBe(true);
    expect(ReadModelSchema.safeParse("task-schedules-v1").success).toBe(true);
    expect(ReadModelSchema.safeParse("goat.workflow_read_model_v1").success).toBe(false);
  });

  it("requires optimistic versions without accepting tenancy or planner state", () => {
    const command = {
      expectedVersion: 2,
      name: "Weekly research",
      description: "Track changes",
      steps: [
        {
          id: "step_1",
          title: "Research",
          model: "provider/model",
          instructions: "Find material changes.",
        },
      ],
      status: "active",
      trigger: { type: "manual" },
    };
    expect(UpdateWorkflowBodySchema.safeParse(command).success).toBe(true);
    expect(
      UpdateWorkflowBodySchema.safeParse({
        ...command,
        workspaceId: "workspace_1",
        scheduleHarnessSpec: { secret: true },
      }).success,
    ).toBe(false);
  });

  it("accepts opaque skill references on Workflow invocation without persistence fields", () => {
    expect(
      InvokeWorkflowBodySchema.safeParse({
        description: "Focus on competitors.",
        attachmentIds: ["attachment_1"],
        skillIds: ["market-research"],
      }).success,
    ).toBe(true);
    expect(
      InvokeWorkflowBodySchema.safeParse({
        description: "Focus on competitors.",
        skillIds: ["market-research"],
        workspaceId: "workspace_1",
      }).success,
    ).toBe(false);
    expect(
      InvokeWorkflowBodySchema.safeParse({
        description: "Focus on competitors.",
        skillIds: Array.from({ length: 17 }, (_, index) => `skill-${index + 1}`),
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

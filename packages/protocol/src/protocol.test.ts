import { describe, expect, it } from "vitest";
import { createApiClient } from "./client";
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
      "/v1/browser-profiles",
      "/v1/browser-profiles/{profileId}",
      "/v1/browser-profiles/{profileId}/login-sessions",
      "/v1/browser-profiles/{profileId}/login-sessions/{sessionId}/complete",
      "/v1/browser-profiles/{profileId}/live-view",
      "/v1/capabilities",
      "/v1/capabilities/session-budget",
      "/v1/capabilities/{source}",
      "/v1/capability-approvals/by-tool-call/{toolCallId}",
      "/v1/capability-approvals/{runId}",
      "/v1/brains",
      "/v1/brains/{brainId}/switch",
      "/v1/brains/{brainId}/access",
      "/v1/brains/{brainId}/enrichment",
      "/v1/brains/{brainId}/intelligence",
      "/v1/identity",
      "/v1/identity/sync",
      "/v1/workspace",
      "/v1/workspace/invitations",
      "/v1/workspace/invitations/{invitationId}",
      "/v1/workspace/members/{userId}",
      "/v1/workspaces",
      "/v1/workspaces/{workspaceId}/switch",
      "/v1/onboarding",
      "/v1/onboarding/workspace-slug/check",
      "/v1/onboarding/profile",
      "/v1/onboarding/workspace",
      "/v1/onboarding/complete",
      "/v1/integrations/{integrationId}/brain-source-options",
      "/v1/brains/{brainId}/imports",
      "/v1/brains/{brainId}/imports/{importRunId}/confirm",
      "/v1/brains/{brainId}/imports/{importRunId}/cancel",
      "/v1/brains/{brainId}/imports/{importRunId}/retry",
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
      "/v1/wiki/pages/{id}",
      "/v1/wiki/pages/{id}/delete",
      "/v1/wiki/pages/{id}/timeline",
      "/v1/wiki/sources",
      "/v1/wiki/sources/activity",
      "/v1/wiki/sources/{sourceId}",
      "/v1/skills",
      "/v1/skills/imports/preview",
      "/v1/skills/imports",
      "/v1/skills/catalog",
      "/v1/skills/{slug}",
      "/v1/skills/{slug}/archive",
      "/v1/skills/{slug}/enable",
      "/v1/skills/{slug}/disable",
      "/v1/skills/{slug}/replace",
      "/v1/skills/{slug}/files/read",
      "/v1/conversations",
      "/v1/conversations/{conversationId}",
      "/v1/conversations/{conversationId}/share",
      "/v1/conversations/{conversationId}/title",
      "/v1/conversations/{conversationId}/messages",
      "/v1/messages",
      "/v1/attachments",
      "/v1/chat-artifacts/{artifactId}",
      "/v1/chat-artifacts/{artifactId}/versions/{versionId}",
      "/v1/chat-attachments/{messageId}/{attachmentId}",
      "/v1/chat-screenshots/{conversationId}/{filename}",
      "/public/chat-shares/{shareId}",
      "/public/chat-shares/{shareId}/metadata",
      "/public/chat-shares/{shareId}/attachments/{messageId}/{attachmentId}",
      "/public/chat-shares/{shareId}/artifacts/{artifactId}/versions/{versionId}",
      "/v1/conversations/{conversationId}/engine-session/runtime",
      "/v1/conversations/{conversationId}/engine-session/runtime-access",
      "/v1/runs/{runId}",
      "/v1/runs/{runId}/events",
      "/v1/runs/{runId}/cancel",
      "/v1/runs/{runId}/approvals/{approvalId}",
      "/v1/read-models/{readModel}",
      "/v1/me/preferences",
      "/v1/me/mcp-setup",
      "/v1/feedback",
      "/v1/repo-configs",
      "/v1/repo-configs/{repositoryExternalId}/env",
      "/v1/repo-configs/{repositoryExternalId}/setup",
      "/v1/repo-configs/{repositoryExternalId}",
      "/v1/integration-accounts/attio",
      "/v1/integration-accounts/attio/{integrationId}",
      "/v1/integration-accounts/fathom",
      "/v1/integration-accounts/granola",
      "/v1/integration-accounts/imessage/pairing",
      "/v1/integration-accounts/imessage/pairing/confirm",
      "/v1/integration-accounts/stripe",
      "/v1/integration-accounts/jamie/webhook-endpoint",
      "/v1/integration-accounts/jamie/api-key",
      "/v1/integration-accounts",
      "/v1/workspace/slack-bot",
      "/v1/brains/{brainId}/slack-bot",
      "/v1/brains/{brainId}/slack-bot/channels",
      "/v1/integration-accounts/{integrationId}/usage",
      "/v1/integration-accounts/{integrationId}/capability-modes/{capabilityId}",
      "/v1/actions/{actionId}/permissions/always-allow",
      "/v1/integration-accounts/{integrationId}",
      "/v1/engine-auth/claude-code",
      "/v1/engine-auth/codex",
      "/v1/engine-auth/codex/device",
      "/v1/engine-auth/codex/device/{flowId}/poll",
      "/v1/engine-auth/infisical",
      "/v1/engine-auth/infisical/start",
      "/v1/engine-auth/infisical/{flowId}/complete",
      "/v1/billing",
      "/v1/billing/usage",
      "/v1/billing/balance",
      "/v1/billing/top-ups",
      "/v1/billing/subscription-checkouts",
      "/v1/billing/portal-sessions",
      "/v1/billing/auto-refill",
      "/v1/plugins",
      "/v1/plugins/imports/preview",
      "/v1/plugins/imports",
      "/v1/plugins/{name}",
      "/v1/plugins/{name}/archive",
      "/v1/plugins/{name}/enable",
      "/v1/plugins/{name}/disable",
      "/v1/plugins/{name}/mcp/approve",
      "/v1/plugins/{name}/mcp/revoke",
      "/v1/plugins/{name}/data/delete",
    ]);
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("rejects adapter and physical persistence names from client commands", () => {
    expect(
      CreateMessageBodySchema.safeParse({
        content: "Hello",
        engine: { type: "opencompany", schemaVersion: 1 },
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
        engine: { type: "opencompany", schemaVersion: 1 },
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
    expect(ReadModelSchema.safeParse("integration-accounts-v1").success).toBe(true);
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

  it("accepts enriched and legacy tool event payloads", () => {
    const base = {
      id: "event_1",
      runId: "run_1",
      attemptId: "attempt_1",
      cursor: "v1:1",
      schemaVersion: 1,
      occurredAt: "2026-08-10T00:00:00.000Z",
      type: "tool.started" as const,
    };

    expect(
      RunEventSchema.safeParse({
        ...base,
        payload: { toolCallId: "tool_1", name: "codex_command" },
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({
        ...base,
        payload: {
          toolCallId: "tool_2",
          name: "codex_command",
          label: "Run tests",
          detail: "bun test",
          kind: "execute",
          parentToolCallId: "subagent_1",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts sanitized approval inputs while preserving legacy approvals", () => {
    const base = {
      id: "event_1",
      runId: "run_1",
      attemptId: "attempt_1",
      cursor: "v1:1",
      schemaVersion: 1 as const,
      occurredAt: "2026-08-10T00:00:00.000Z",
      type: "approval.requested" as const,
    };

    expect(
      RunEventSchema.safeParse({
        ...base,
        payload: {
          approvalId: "approval_1",
          kind: "use_action",
          prompt: "Approve?",
        },
      }).success,
    ).toBe(true);
    expect(
      RunEventSchema.safeParse({
        ...base,
        payload: {
          approvalId: "approval_2",
          toolCallId: "tool_2",
          kind: "use_action",
          prompt: "Approve gmail.send?",
          action: "gmail.send",
          input: {
            action: "gmail.send",
            params: { to: "customer@example.com", subject: "Hello" },
          },
        },
      }).success,
    ).toBe(true);
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
    const client = createApiClient("https://api.example.test");
    expect(client.v1.messages.$url().pathname).toBe("/v1/messages");
    expect(client.v1.tasks[":taskId"].$url({ param: { taskId: "task_1" } }).pathname).toBe(
      "/v1/tasks/task_1",
    );
    expect(client.v1.runs[":runId"].events.$url({ param: { runId: "run_1" } }).pathname).toBe(
      "/v1/runs/run_1/events",
    );
  });
});

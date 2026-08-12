import { once } from "node:events";
import { request as requestHttp } from "node:http";
import { serve } from "@hono/node-server";
import type { ChatPresentationReader } from "@opencompany/chat-presentation";
import {
  type Actor,
  ChatApplicationService,
  type ChatRepository,
  CoreError,
  type CreateMessageCommand,
  type CreateTaskCommand,
  KnowledgeApplicationService,
  type KnowledgeRepository,
  type Skill,
  SkillImportApplicationService,
  type SkillImportRepository,
  type SkillImportResolver,
  type Task,
  TaskApplicationService,
  type TaskRepository,
  type TaskSchedule,
  TaskScheduleApplicationService,
  type TaskScheduleRepository,
  type Workflow,
  WorkflowApplicationService,
  type WorkflowRepository,
} from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app";
import type { AttachmentUploadService } from "./attachments";
import type { BrainAssetService } from "./brain-assets";
import { ApiError } from "./errors";
import type { ApiRateLimiter } from "./rate-limit";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [
    "chat:read",
    "chat:write",
    "task:read",
    "task:write",
    "workflow:read",
    "workflow:write",
    "schedule:read",
    "schedule:write",
    "brain:read",
    "brain:write",
    "wiki:read",
    "wiki:write",
    "skill:read",
    "skill:write",
  ],
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
      ...fakeAutomationServices(),
      knowledge: fakeKnowledgeService(),
      brainSources: fakeBrainSources(),
      skillImports: fakeSkillImportService(),
      brainAssets: fakeBrainAssets(),
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

    const summary = await app.request("/v1/tasks/task_1/summary");
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toEqual({
      data: {
        cost: { hasRecordedCosts: true, totalCostUsdMicros: 12_300 },
        durationMs: 45_000,
      },
      meta: { apiVersion: "v1", protocolVersion: expect.any(String) },
    });
  });

  it("serves canonical Workflow and Recurring Task contracts through Core services", async () => {
    const automations = populatedAutomationServices();
    const app = testApp(fakeRepository(), automations);

    const createdWorkflow = await app.request("/v1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "workflow-create-1" },
      body: JSON.stringify({ name: "Weekly research", description: "Track changes" }),
    });
    expect(createdWorkflow.status).toBe(201);
    await expect(createdWorkflow.json()).resolves.toMatchObject({
      data: {
        workflow: {
          id: "workflow_1",
          slug: "weekly-research",
          trigger: { type: "manual" },
          version: 1,
        },
        transactionId: "51",
        replayed: false,
      },
    });

    const updatedWorkflow = await app.request("/v1/workflows/workflow_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
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
      }),
    });
    expect(updatedWorkflow.status).toBe(200);
    await expect(updatedWorkflow.json()).resolves.toMatchObject({
      data: { workflow: { version: 2 }, transactionId: "52" },
    });

    const invoked = await app.request("/v1/workflows/workflow_1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "workflow-invoke-1" },
      body: JSON.stringify({
        description: "Focus on competitors.",
        skillIds: ["market-research"],
      }),
    });
    expect(invoked.status).toBe(202);
    await expect(invoked.json()).resolves.toMatchObject({
      data: { task: { id: "task_automation", source: "workflow" }, runId: "run_automation" },
    });
    expect(automations.prepareWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ skillIds: ["market-research"] }),
    );

    const createdSchedule = await app.request("/v1/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "schedule-create-1" },
      body: JSON.stringify({
        name: "Daily research",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Research market changes.",
      }),
    });
    expect(createdSchedule.status).toBe(201);
    const scheduleBody = await createdSchedule.json();
    expect(scheduleBody).toMatchObject({
      data: {
        schedule: { id: "schedule_1", name: "Daily research", version: 1 },
        transactionId: "61",
        replayed: false,
      },
    });
    expect(JSON.stringify(scheduleBody)).not.toMatch(/workos|workspace_id|harness|goat_/iu);
  });

  it("serves Brain, Wiki, and Skill resources through the typed Knowledge boundary", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const updateWikiPage = vi.fn(async ({ slug }: { slug: string }) => ({
      page: fakeWikiPage({ slug, path: `projects/${slug}` }),
      transactionIds: [71],
    }));
    const createSkill = vi.fn(async () => fakeSkill());
    const listSkillCatalog = vi.fn(async () => [
      { id: "research", name: "Research", description: "Find primary sources." },
    ]);
    const listBrainSourceItems = vi.fn(async () => [
      {
        id: "source_item_1",
        sourceProvider: "goat-chat",
        sourceType: "capture",
        externalId: "project-alpha",
        title: "Alpha",
        lastIngestError: "x".repeat(2_001),
        createdAt,
      },
    ]);
    const knowledge = knowledgeService({
      assertBrainAccess,
      getBrainSnapshot: async () => ({
        folders: [
          {
            id: "folder_1",
            path: "projects",
            source: "custom",
            createdAt,
            updatedAt: createdAt,
          },
        ],
        documents: [fakeBrainDocument()],
      }),
      updateWikiPage,
      createSkill,
      listSkillCatalog,
      listBrainSourceItems,
    });
    const app = testApp(fakeRepository(), { knowledge });

    const brain = await app.request("/v1/brains/brain_1");
    expect(brain.status).toBe(200);
    const brainBody = await brain.json();
    expect(brainBody).toMatchObject({
      data: {
        documents: [
          {
            id: "document_1",
            brainId: "project-alpha",
            path: "projects/project-alpha.md",
            body: "# Alpha",
          },
        ],
      },
    });
    expect(JSON.stringify(brainBody)).not.toMatch(/brain_ref|workspace_id|asset_storage/iu);
    expect(assertBrainAccess).toHaveBeenCalledWith({ actor, brainId: "brain_1" });

    const sourceItems = await app.request(
      "/v1/brains/brain_1/source-items?ids=source_item_1,source_item_1",
    );
    expect(sourceItems.status).toBe(200);
    const sourceItemsBody = await sourceItems.json();
    expect(sourceItemsBody).toMatchObject({
      data: [
        {
          id: "source_item_1",
          sourceProvider: "goat-chat",
          externalId: "project-alpha",
        },
      ],
    });
    expect(sourceItemsBody.data[0].lastIngestError).toHaveLength(2_000);
    expect(listBrainSourceItems).toHaveBeenCalledWith({
      actor,
      brainId: "brain_1",
      ids: ["source_item_1"],
    });
    expect(JSON.stringify(sourceItemsBody)).not.toMatch(
      /userWorkosId|brainRef|rawPayload|normalizedPayload|occurredAt|capturedAt|updatedAt/iu,
    );
    const tooManySourceItems = await app.request(
      `/v1/brains/brain_1/source-items?ids=${Array.from(
        { length: 101 },
        (_, index) => `source_item_${index}`,
      ).join(",")}`,
    );
    expect(tooManySourceItems.status).toBe(400);
    expect(listBrainSourceItems).toHaveBeenCalledTimes(1);

    const wiki = await app.request("/v1/wiki/pages/project-alpha", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "# Updated", kind: "project", title: "Alpha" }),
    });
    expect(wiki.status).toBe(200);
    await expect(wiki.json()).resolves.toMatchObject({
      data: { page: { slug: "project-alpha", body: "" }, transactionIds: [71] },
    });
    expect(updateWikiPage).toHaveBeenCalledWith(
      expect.objectContaining({ actor, slug: "project-alpha", body: "# Updated" }),
    );

    const skill = await app.request("/v1/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "skill-create-1" },
      body: JSON.stringify({ name: "Research", description: "Find primary sources." }),
    });
    expect(skill.status).toBe(201);
    await expect(skill.json()).resolves.toMatchObject({
      data: { slug: "research", status: "draft", source: null },
    });
    expect(createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        idempotencyKey: "skill-create-1",
        name: "Research",
      }),
    );

    const catalog = await app.request("/v1/skills/catalog");
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toMatchObject({
      data: [{ id: "research", name: "Research" }],
    });
    expect(listSkillCatalog).toHaveBeenCalledWith({ actor });
  });

  it("previews and idempotently imports an external Skill through the API boundary", async () => {
    const resolvedCommit = "a".repeat(40);
    const integrity = `sha256:${"b".repeat(64)}`;
    const source = {
      type: "github" as const,
      url: "https://github.com/o/r",
      ref: "main",
      path: "",
    };
    const resolve = vi.fn(async () => ({
      status: "resolved" as const,
      proposedSlug: "imported-skill",
      name: "Imported skill",
      description: "Imported instructions.",
      instructions: "Use this when imported.",
      source,
      resolvedCommit,
      integrity,
      extraFiles: ["references/notes.md"],
    }));
    const importSkill = vi.fn(async () => ({
      skill: fakeSkill({
        id: "skill_imported",
        slug: "imported-skill",
        name: "Imported skill",
        description: "Imported instructions.",
        instructions: "Use this when imported.",
        status: "active" as const,
        source: { ...source, resolvedCommit },
      }),
      idempotentReplay: false,
    }));
    const app = testApp(fakeRepository(), {
      skillImports: fakeSkillImportService({ importSkill }, { resolve }),
    });

    const preview = await app.request("/v1/skills/imports/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "github.com/o/r" }),
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      data: {
        status: "resolved",
        proposedSlug: "imported-skill",
        instructions: "Use this when imported.",
        resolvedCommit,
        integrity,
      },
      meta: { apiVersion: "v1" },
    });

    const imported = await app.request("/v1/skills/imports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "skill-import-1",
      },
      body: JSON.stringify({
        url: "github.com/o/r",
        expectedResolvedCommit: resolvedCommit,
        expectedIntegrity: integrity,
      }),
    });
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({
      data: { skill: { slug: "imported-skill" }, replayed: false },
    });
    expect(importSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        idempotencyKey: "skill-import-1",
        source,
        resolvedCommit,
        integrity,
      }),
    );
  });

  it("serves and mutates Brain sources through the authenticated provider boundary", async () => {
    const list = vi.fn(async () => brainSourceDetails());
    const set = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const listOptions = vi.fn(async () => ({
      provider: "github" as const,
      repos: [{ id: "repo_1", fullName: "acme/api", private: true }],
    }));
    const app = testApp(fakeRepository(), {
      brainSources: brainSourceService({ list, set, remove, listOptions }),
    });

    const listed = await app.request("/v1/brains/brain_1/sources");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      data: { viewer: { actorId: actor.userId, isAdmin: true }, sources: [] },
    });
    expect(JSON.stringify(listedBody)).not.toMatch(/workos|workspace_id|credential|access_token/iu);
    expect(list).toHaveBeenCalledWith(actor, "brain_1");

    const updated = await app.request("/v1/brains/brain_1/sources/integration_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "configure",
        provider: "github",
        enabled: true,
        repos: [{ id: "repo_1", fullName: "acme/api" }],
        events: ["pull_request_merged"],
      }),
    });
    expect(updated.status).toBe(200);
    expect(set).toHaveBeenCalledWith(
      actor,
      "brain_1",
      "integration_1",
      expect.objectContaining({ provider: "github", enabled: true }),
    );

    const options = await app.request("/v1/integrations/integration_1/brain-source-options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "github" }),
    });
    expect(options.status).toBe(200);
    await expect(options.json()).resolves.toMatchObject({
      data: { provider: "github", repos: [{ fullName: "acme/api", private: true }] },
    });
    expect(listOptions).toHaveBeenCalledWith(actor, "integration_1", { provider: "github" });

    const removed = await app.request("/v1/brains/brain_1/sources/integration_1", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(actor, "brain_1", "integration_1");
  });

  it("rejects invalid source configuration before invoking provider logic", async () => {
    const set = vi.fn(async () => undefined);
    const listOptions = vi.fn(async () => ({ provider: "github" as const, repos: [] }));
    const app = testApp(fakeRepository(), {
      brainSources: brainSourceService({ set, listOptions }),
    });

    const invalidMutation = await app.request("/v1/brains/brain_1/sources/integration_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "configure",
        provider: "google_drive",
        enabled: true,
        resourceIds: Array.from({ length: 101 }, (_, index) => `file_${index}`),
      }),
    });
    expect(invalidMutation.status).toBe(400);
    expect(set).not.toHaveBeenCalled();

    const invalidOptions = await app.request(
      "/v1/integrations/integration_1/brain-source-options",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google_drive", query: "x".repeat(201) }),
      },
    );
    expect(invalidOptions.status).toBe(400);
    expect(listOptions).not.toHaveBeenCalled();
  });

  it("maps Brain source capability denial to a typed forbidden response", async () => {
    const app = testApp(fakeRepository(), {
      brainSources: brainSourceService({
        remove: async () => {
          throw new CoreError("forbidden", "Only the source owner may remove this source.");
        },
      }),
    });
    const response = await app.request("/v1/brains/brain_1/sources/integration_1", {
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("returns a retryable typed error when external Skill resolution is unavailable", async () => {
    const app = testApp(fakeRepository(), {
      skillImports: fakeSkillImportService(
        {},
        {
          resolve: async () => {
            throw new CoreError("unavailable", "Couldn't read that skill right now.");
          },
        },
      ),
    });

    const response = await app.request("/v1/skills/imports/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "github.com/o/r" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unavailable", retryable: true },
      meta: { apiVersion: "v1" },
    });
  });

  it("serves sessionless history only through actor-scoped read-only compatibility resources", async () => {
    const tasks = fakeTaskRepository();
    const { conversationId: _, ...legacyTask } = fakeTask({
      id: "task_legacy",
      displayId: "TASK-OLD",
    });
    tasks.listLegacyTasks = vi.fn(async () => [legacyTask]);
    tasks.getLegacyTaskHistory = vi.fn(async ({ taskId }) =>
      taskId === "task_legacy"
        ? {
            task: legacyTask,
            messages: [
              {
                id: "legacy_message_1",
                role: "assistant" as const,
                status: "completed" as const,
                content: "Legacy result",
                toolName: null,
                toolCallId: null,
                createdAt,
                updatedAt: createdAt,
                completedAt: createdAt,
              },
            ],
            events: [
              {
                id: 1,
                messageId: "legacy_message_1",
                type: "message.completed",
                payload: { status: "completed" },
                createdAt,
              },
            ],
          }
        : null,
    );
    const app = testApp(fakeRepository(), { tasks: new TaskApplicationService(tasks) });

    const listed = await app.request("/v1/compatibility/tasks");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{ id: "task_legacy", displayId: "TASK-OLD" }],
    });
    expect(tasks.listLegacyTasks).toHaveBeenCalledWith({ actor, limit: 100 });

    const history = await app.request("/v1/compatibility/tasks/task_legacy/history");
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      data: {
        task: { id: "task_legacy" },
        messages: [{ content: "Legacy result" }],
        events: [{ type: "message.completed" }],
      },
    });
    expect(tasks.getLegacyTaskHistory).toHaveBeenCalledWith({ actor, taskId: "task_legacy" });

    const missing = await app.request("/v1/compatibility/tasks/another_actor_task/history");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "not_found" } });
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
    expect(allowed.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(allowed.headers.get("access-control-allow-methods")).toContain("DELETE");

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

  it("authorizes Brain read models before forwarding the fixed Brain scope", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(fakeRepository(), {
      knowledge: knowledgeService({ assertBrainAccess }),
      readModels: { stream },
    });

    const response = await app.request(
      "/v1/read-models/brain-ingest-jobs-v1?brainId=brain_1&table=goat.users&where=true",
    );

    expect(response.status).toBe(200);
    expect(assertBrainAccess).toHaveBeenCalledWith({ actor, brainId: "brain_1" });
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        readModel: "brain-ingest-jobs-v1",
        brainId: "brain_1",
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

  it("uploads and replaces private Brain assets through typed multipart operations", async () => {
    const upload = vi.fn(async () => ({
      document: fakeBrainDocument(),
      quotaPaused: true,
      replayed: false,
    }));
    const replace = vi.fn(async () => ({
      document: fakeBrainDocument(),
      quotaPaused: false,
      replayed: true,
    }));
    const app = testApp(fakeRepository(), {
      brainAssets: brainAssetService({ upload, replace }),
    });
    const file = new File(["private bytes"], "plan.pdf", { type: "application/pdf" });
    const createForm = new FormData();
    createForm.set("folderPath", "projects");
    createForm.set("file", file);

    const created = await app.request("/v1/brains/brain_1/assets", {
      method: "POST",
      headers: { "Idempotency-Key": "asset-create-1" },
      body: createForm,
    });

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: { document: { id: "document_1" }, quotaPaused: true, replayed: false },
    });
    expect(upload).toHaveBeenCalledWith({
      actor,
      brainId: "brain_1",
      folderPath: "projects",
      idempotencyKey: "asset-create-1",
      file,
    });

    const replaceForm = new FormData();
    replaceForm.set("file", file);
    const replaced = await app.request("/v1/brains/brain_1/assets/document_1/replace", {
      method: "POST",
      headers: { "Idempotency-Key": "asset-replace-1" },
      body: replaceForm,
    });

    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      data: { document: { id: "document_1" }, quotaPaused: false, replayed: true },
    });
    expect(replace).toHaveBeenCalledWith({
      actor,
      brainId: "brain_1",
      documentId: "document_1",
      idempotencyKey: "asset-replace-1",
      file,
    });
  });

  it("streams authorized Brain asset bytes without exposing a storage locator", async () => {
    const download = vi.fn(async () => ({
      stream: new Response("private bytes").body as ReadableStream<Uint8Array>,
      mediaType: "application/pdf",
      filename: 'plan "final".pdf',
      sizeBytes: 13,
    }));
    const app = testApp(fakeRepository(), {
      brainAssets: brainAssetService({ download }),
    });

    const response = await app.request("/v1/brain-assets/document_1");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private bytes");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="plan _final_.pdf"; filename*=UTF-8''plan%20_final_.pdf`,
    );
    expect(download).toHaveBeenCalledWith({ actor, documentId: "document_1" });
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

  it("rejects oversized Brain assets before the canonical service buffers them", async () => {
    const upload = vi.fn();
    const app = testApp(fakeRepository(), {
      brainAssets: brainAssetService({ upload }),
    });
    const response = await app.request("/v1/brains/brain_1/assets", {
      method: "POST",
      headers: {
        "Content-Length": String(21 * 1024 * 1024),
        "Content-Type": "multipart/form-data; boundary=test",
        "Idempotency-Key": "oversized-asset-1",
      },
      body: "--test--\r\n",
    });

    expect(response.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
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
    ...fakeAutomationServices(),
    knowledge: fakeKnowledgeService(),
    brainSources: fakeBrainSources(),
    skillImports: fakeSkillImportService(),
    brainAssets: fakeBrainAssets(),
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

function fakeBrainAssets(): BrainAssetService {
  return {
    upload: async () => {
      throw new Error("Unexpected Brain asset upload.");
    },
    replace: async () => {
      throw new Error("Unexpected Brain asset replacement.");
    },
    download: async () => {
      throw new Error("Unexpected Brain asset download.");
    },
  };
}

function fakeBrainSources(): Parameters<typeof createApiApp>[0]["brainSources"] {
  return {
    list: async () => {
      throw new Error("Unexpected Brain source list.");
    },
    set: async () => {
      throw new Error("Unexpected Brain source mutation.");
    },
    remove: async () => {
      throw new Error("Unexpected Brain source removal.");
    },
    listOptions: async () => {
      throw new Error("Unexpected Brain source option list.");
    },
  };
}

function brainSourceService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["brainSources"]>,
): Parameters<typeof createApiApp>[0]["brainSources"] {
  return { ...fakeBrainSources(), ...overrides };
}

function brainSourceDetails() {
  const unavailableBase = {
    connected: false,
    status: "not_connected" as const,
    integrationId: null,
    statusReason: null,
  };
  return {
    viewer: { actorId: actor.userId, isAdmin: true },
    sources: [],
    ownAccounts: {
      slack: [],
      linear: [],
      gmail: [],
      google_drive: [],
      hubspot: [],
      granola: [],
      fathom: [],
      attio: [],
    },
    jamie: {
      integration: {
        ...unavailableBase,
        provider: "jamie" as const,
        accountName: null,
        webhookUrl: null,
        apiKeyConfigured: false,
      },
      legacyDefaultDelivery: false,
      isDefaultBrain: false,
    },
    slack: {
      integration: {
        ...unavailableBase,
        provider: "slack" as const,
        accountName: null,
        teamName: null,
      },
    },
    linear: {
      integration: {
        ...unavailableBase,
        provider: "linear" as const,
        accountName: null,
        organizationName: null,
      },
    },
    github: {
      integration: { ...unavailableBase, provider: "github" as const, accountName: null },
    },
    gmail: {
      integration: { ...unavailableBase, provider: "gmail" as const, accountEmail: null },
    },
    googleDrive: {
      integration: {
        ...unavailableBase,
        provider: "google_drive" as const,
        accountEmail: null,
      },
    },
    hubspot: {
      integration: {
        ...unavailableBase,
        provider: "hubspot" as const,
        accountEmail: null,
        hubDomain: null,
      },
    },
    granola: {
      integration: {
        ...unavailableBase,
        provider: "granola" as const,
        accountEmail: null,
        accountName: null,
      },
    },
    fathom: {
      integration: {
        ...unavailableBase,
        provider: "fathom" as const,
        accountEmail: null,
        accountName: null,
      },
    },
    attio: {
      integration: {
        ...unavailableBase,
        provider: "attio" as const,
        workspaceName: null,
      },
    },
  };
}

function brainAssetService(overrides: Partial<BrainAssetService>): BrainAssetService {
  return { ...fakeBrainAssets(), ...overrides };
}

function fakeKnowledgeService() {
  return knowledgeService({});
}

function fakeSkillImportService(
  repositoryOverrides: Partial<SkillImportRepository> = {},
  resolverOverrides: Partial<SkillImportResolver> = {},
) {
  const repository: SkillImportRepository = {
    importSkill: async () => {
      throw new Error("Unexpected Skill import.");
    },
    ...repositoryOverrides,
  };
  const resolver: SkillImportResolver = {
    resolve: async () => {
      throw new Error("Unexpected Skill import preview.");
    },
    ...resolverOverrides,
  };
  return new SkillImportApplicationService(repository, resolver);
}

function knowledgeService(overrides: Partial<KnowledgeRepository>) {
  const repository = new Proxy(overrides, {
    get(target, operation) {
      if (operation in target) return target[operation as keyof typeof target];
      return async () => {
        throw new Error(`Unexpected knowledge operation: ${String(operation)}.`);
      };
    },
  }) as KnowledgeRepository;
  return new KnowledgeApplicationService(repository);
}

function fakeBrainDocument() {
  return {
    id: "document_1",
    brainId: "project-alpha",
    folderPath: "projects",
    path: "projects/project-alpha.md",
    title: "Alpha",
    content: "---\nid: project-alpha\n---\n# Alpha",
    body: "# Alpha",
    timeline: [],
    format: "markdown" as const,
    mimeType: "text/markdown",
    originalFileName: null,
    assetSizeBytes: null,
    relations: [],
    sources: [],
    kind: "page" as const,
    type: "project" as const,
    status: "draft" as const,
    aliases: [],
    contentHash: "a".repeat(64),
    sizeBytes: 8,
    createdByActorId: "user_1",
    createdAt,
    updatedAt: createdAt,
  };
}

function fakeWikiPage(overrides: Partial<ReturnType<typeof baseWikiPage>> = {}) {
  return { ...baseWikiPage(), ...overrides };
}

function baseWikiPage() {
  return {
    id: "wiki_page_1",
    slug: "project-alpha",
    path: "projects/project-alpha",
    title: "Alpha",
    kind: "project" as const,
    body: "",
    contentHash: "b".repeat(64),
    sizeBytes: 0,
    format: "markdown",
    mimeType: "text/markdown",
    originalFileName: null,
    assetSizeBytes: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return { ...baseSkill(), ...overrides };
}

function baseSkill(): Skill {
  return {
    id: "skill_1",
    slug: "research",
    name: "Research",
    description: "Find primary sources.",
    instructions: "",
    status: "draft" as const,
    source: null,
    createdAt,
    updatedAt: createdAt,
  };
}

type FakeRepository = ChatRepository & { lastCommand: CreateMessageCommand | null };

type FakeTaskRepository = TaskRepository & { lastCommand: CreateTaskCommand | null };

function fakeAutomationServices() {
  const workflowRepository: WorkflowRepository = {
    listWorkflows: async () => ({ workflows: [], nextCursor: null }),
    getWorkflow: async () => null,
    createWorkflow: async () => {
      throw new Error("Unexpected Workflow creation.");
    },
    updateWorkflow: async () => ({ status: "not_found" }),
    archiveWorkflow: async () => ({ status: "not_found" }),
    recordRunNow: async () => undefined,
  };
  const scheduleRepository: TaskScheduleRepository = {
    assertTaskScheduleWriteAllowed: async () => undefined,
    replayTaskScheduleCreate: async () => null,
    listTaskSchedules: async () => ({ schedules: [], nextCursor: null }),
    getTaskSchedule: async () => null,
    createTaskSchedule: async () => {
      throw new Error("Unexpected Task schedule creation.");
    },
    updateTaskSchedule: async () => ({ status: "not_found" }),
    setTaskScheduleEnabled: async () => ({ status: "not_found" }),
    archiveTaskSchedule: async () => ({ status: "not_found" }),
    loadTaskScheduleExecution: async () => null,
    recordRunNow: async () => undefined,
  };
  const options = {
    scheduleRules: {
      normalize: ({
        cron,
        timezone,
        now,
      }: {
        cron: string;
        timezone?: string | null;
        now: Date;
      }) => ({
        cron,
        timezone: timezone ?? "UTC",
        nextRunAt: now,
      }),
    },
    planner: {
      prepareWorkflow: async () => {
        throw new Error("Unexpected Workflow planning.");
      },
      prepareTaskSchedule: async () => {
        throw new Error("Unexpected Task schedule planning.");
      },
    },
    taskCreator: {
      create: async () => {
        throw new Error("Unexpected automation Task creation.");
      },
    },
  };
  return {
    workflows: new WorkflowApplicationService(workflowRepository, options),
    schedules: new TaskScheduleApplicationService(scheduleRepository, options),
  };
}

function populatedAutomationServices() {
  let workflow: Workflow = {
    id: "workflow_1",
    slug: "weekly-research",
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
    version: 1,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const schedule: TaskSchedule = {
    id: "schedule_1",
    name: "Daily research",
    sourceDescription: "",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Research market changes.",
    enabled: true,
    lastRunAt: null,
    nextRunAt: createdAt,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const workflowRepository: WorkflowRepository = {
    listWorkflows: async () => ({ workflows: [workflow], nextCursor: null }),
    getWorkflow: async ({ workflowId }) =>
      workflowId === workflow.id || workflowId === workflow.slug ? workflow : null,
    createWorkflow: async () => ({
      workflow,
      transactionId: "51",
      idempotentReplay: false,
    }),
    updateWorkflow: async (input) => {
      workflow = {
        ...workflow,
        name: input.name,
        description: input.description,
        steps: input.steps,
        status: input.status,
        trigger:
          input.trigger.type === "manual"
            ? { type: "manual" }
            : {
                type: "schedule",
                cron: input.schedule?.definition.cron ?? input.trigger.cron,
                timezone: input.schedule?.definition.timezone ?? input.trigger.timezone ?? "UTC",
                prompt: input.trigger.prompt ?? "Run this workflow.",
                enabled: input.trigger.enabled ?? true,
                lastRunAt: null,
                nextRunAt: input.schedule?.definition.nextRunAt ?? null,
              },
        version: 2,
      };
      return { status: "updated", value: workflow, transactionId: "52" };
    },
    archiveWorkflow: async () => ({
      status: "updated",
      value: { workflowId: workflow.id, version: workflow.version + 1 },
      transactionId: "53",
    }),
    recordRunNow: async () => undefined,
  };
  const scheduleRepository: TaskScheduleRepository = {
    assertTaskScheduleWriteAllowed: async () => undefined,
    replayTaskScheduleCreate: async () => null,
    listTaskSchedules: async () => ({ schedules: [schedule], nextCursor: null }),
    getTaskSchedule: async ({ scheduleId }) => (scheduleId === schedule.id ? schedule : null),
    createTaskSchedule: async () => ({
      schedule,
      transactionId: "61",
      idempotentReplay: false,
    }),
    updateTaskSchedule: async () => ({
      status: "updated",
      value: { ...schedule, version: 2 },
      transactionId: "62",
    }),
    setTaskScheduleEnabled: async ({ enabled }) => ({
      status: "updated",
      value: { ...schedule, enabled, version: 2 },
      transactionId: "63",
    }),
    archiveTaskSchedule: async () => ({
      status: "updated",
      value: { scheduleId: schedule.id, version: 2 },
      transactionId: "64",
    }),
    loadTaskScheduleExecution: async ({ scheduleId }) =>
      scheduleId === schedule.id
        ? {
            schedule,
            execution: {
              engine: "opencompany",
              model: "provider/model",
              payload: { engine: "opencompany", model: "provider/model" },
            },
          }
        : null,
    recordRunNow: async () => undefined,
  };
  const prepareWorkflow = vi.fn(async () => ({
    engine: "opencompany" as const,
    model: "provider/model",
    payload: { engine: "opencompany", model: "provider/model" },
  }));
  const options = {
    scheduleRules: {
      normalize: ({ cron, timezone }: { cron: string; timezone?: string | null }) => ({
        cron: cron.trim(),
        timezone: timezone?.trim() || "UTC",
        nextRunAt: createdAt,
      }),
    },
    planner: {
      prepareWorkflow,
      prepareTaskSchedule: async () => ({
        engine: "opencompany" as const,
        model: "provider/model",
        payload: { engine: "opencompany", model: "provider/model" },
      }),
    },
    taskCreator: {
      create: async ({ source }: { source: "workflow" | "schedule" }) => ({
        task: fakeTask({
          id: "task_automation",
          source,
          conversationId: "conversation_automation",
        }),
        messageId: "message_automation_user",
        assistantMessageId: "message_automation_assistant",
        runId: "run_automation",
        transactionId: "71",
        idempotentReplay: false,
      }),
    },
  };
  return {
    workflows: new WorkflowApplicationService(workflowRepository, options),
    schedules: new TaskScheduleApplicationService(scheduleRepository, options),
    prepareWorkflow,
  };
}

function fakeTaskRepository(): FakeTaskRepository {
  const repository: FakeTaskRepository = {
    lastCommand: null,
    listTasks: async () => ({ tasks: [fakeTask()], nextCursor: null }),
    getTask: async ({ taskId }) => (taskId === "task_1" ? fakeTask() : null),
    getTaskSummary: async ({ taskId }) =>
      taskId === "task_1"
        ? {
            cost: { hasRecordedCosts: true, totalCostUsdMicros: 12_300 },
            durationMs: 45_000,
          }
        : null,
    listLegacyTasks: async () => [],
    getLegacyTaskHistory: async () => null,
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

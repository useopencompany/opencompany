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
  type PluginGatewayLifecycle,
  PluginImportApplicationService,
  type PluginImportResolver,
  type PluginInstallation,
  type PluginInstallationListItem,
  type PluginRepository,
  type ResolvedPluginPackage,
  type SkillBundleAuthor,
  type SkillBundleRepository,
  SkillImportApplicationService,
  type SkillImportResolver,
  type SkillInstallation,
  type SkillInstallationListItem,
  type Task,
  TaskApplicationService,
  type TaskRepository,
  type TaskSchedule,
  TaskScheduleApplicationService,
  type TaskScheduleRepository,
  WikiCommandApplicationService,
  type WikiCommandRepository,
  type Workflow,
  WorkflowApplicationService,
  type WorkflowRepository,
} from "@opencompany/core";
import { setExceptionReporter } from "@opencompany/observability";
import {
  PROTOCOL_UPDATE_REQUIRED_MESSAGE,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  V1_BROWSER_REQUEST_HEADERS,
} from "@opencompany/protocol";
import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app";
import type { AttachmentUploadService } from "./attachments";
import { createWorkOsApiAuthenticator } from "./auth";
import type { BrainAssetService } from "./brain-assets";
import type { ChatResourceService } from "./chat-resources";
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

function messageHeaders(idempotencyKey: string) {
  return {
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
    [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
  };
}

describe("canonical Hono API", () => {
  it("mounts the first-party Gmail MCP at its package endpoint", async () => {
    const handle = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const app = testApp(fakeRepository(), { gmailMcp: { handle } });
    const response = await app.request("/mcp/plugins/gmail", {
      method: "POST",
      headers: { authorization: "Bearer narrow-ticket" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0].headers.get("authorization")).toBe("Bearer narrow-ticket");
    expect((await app.request("/mcp/plugins/gmail", { method: "GET" })).status).toBe(404);
  });

  it("mounts the first-party Google Calendar MCP at its package endpoint", async () => {
    const handle = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const app = testApp(fakeRepository(), { googleCalendarMcp: { handle } });
    const response = await app.request("/mcp/plugins/google-calendar", {
      method: "POST",
      headers: { authorization: "Bearer narrow-ticket" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0].headers.get("authorization")).toBe("Bearer narrow-ticket");
    expect((await app.request("/mcp/plugins/google-calendar", { method: "GET" })).status).toBe(404);
  });

  it("reports the deployed API release for expected-SHA health gates", async () => {
    const previousRelease = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT = "api-release-sha";
    try {
      const response = await testApp(fakeRepository()).request("/healthz");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "opencompany-api",
        protocolVersion: PROTOCOL_VERSION,
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
      wikiCommands: fakeWikiCommandsService(),
      resolveWikiServiceActor: async () => actor,
      wikiSources: fakeWikiSources(),
      brainSources: fakeBrainSources(),
      brainImports: fakeBrainImports(),
      wikiImports: fakeWikiImports(),
      browserProfiles: fakeBrowserProfiles(),
      skillImports: fakeSkillImportService(),
      pluginImports: fakePluginImportService(),
      brainAssets: fakeBrainAssets(),
      brainControl: fakeBrainControl(),
      attachments: fakeAttachments(),
      userSettings: fakeUserSettings(),
      feedback: fakeFeedback(),
      repoConfigs: fakeRepoConfigs(),
      integrationAccounts: fakeIntegrationAccounts(),
      slackBotSettings: fakeSlackBotSettings(),
      engineAuth: fakeEngineAuth(),
      engineSessions: fakeEngineSessions(),
      billing: fakeBilling(),
      workspaceCapabilities: fakeWorkspaceCapabilities(),
      workspaceControl: fakeWorkspaceControl(),
      identity: fakeIdentity(),
      onboarding: fakeOnboarding(),
      onboardingEmails: fakeOnboardingEmails(),
      authenticate: async () => {
        throw new ApiError(401, "authentication_required", "Authentication required.");
      },
      identify: async () => {
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
    const onboardingUnauthorized = await unauthenticated.request("/v1/onboarding", {
      headers: { "X-Request-Id": "request_onboarding_test" },
    });
    expect(onboardingUnauthorized.status).toBe(401);
    await expect(onboardingUnauthorized.json()).resolves.toMatchObject({
      error: { code: "authentication_required", requestId: "request_onboarding_test" },
      meta: { apiVersion: "v1" },
    });

    const app = testApp(repository);
    const invalid = await app.request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("send_1"),
      body: JSON.stringify({
        content: "",
        engine: { type: "opencompany", schemaVersion: 1 },
      }),
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

  it("serves Brain and Wiki resources alongside the immutable Skill catalog", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const updateWikiPage = vi.fn(async ({ id }: { id: string }) => ({
      page: fakeWikiPage({ id }),
      transactionIds: [71],
    }));
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
      listBrainSourceItems,
    });
    const app = testApp(fakeRepository(), {
      knowledge,
      skillImports: fakeSkillImportService({ listCatalog: listSkillCatalog }),
    });

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
      body: JSON.stringify({
        body: "# Updated",
        kind: "project",
        slug: "alpha",
        title: "Alpha",
      }),
    });
    expect(wiki.status).toBe(200);
    await expect(wiki.json()).resolves.toMatchObject({
      data: { page: { slug: "project-alpha", body: "" }, transactionIds: [71] },
    });
    expect(updateWikiPage).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        id: "project-alpha",
        body: "# Updated",
        slug: "alpha",
      }),
    );

    const catalog = await app.request("/v1/skills/catalog");
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toMatchObject({
      data: [{ id: "research", name: "Research" }],
    });
    expect(listSkillCatalog).toHaveBeenCalledWith({ actor });
  });

  it("previews metadata only and installs an immutable Skill through the API boundary", async () => {
    const resolvedCommit = "a".repeat(40);
    const integrity = `sha256:${"b".repeat(64)}`;
    const source = {
      type: "github" as const,
      url: "https://github.com/o/r",
      ref: "main",
      path: "imported-skill",
      resolvedCommit,
    };
    const fileContent = new TextEncoder().encode("private bundle bytes");
    const bundle = {
      name: "imported-skill",
      description: "Imported instructions.",
      body: "Use this when imported.",
      source,
      integrity,
      files: [{ path: "SKILL.md", content: fileContent, executable: false }],
      fileCount: 1,
      totalBytes: fileContent.length,
    };
    const resolve = vi.fn(async () => ({
      status: "resolved" as const,
      bundle,
      warnings: [],
    }));
    const install = vi.fn(async () => ({
      installation: fakeSkillInstallation(),
      idempotentReplay: false,
    }));
    const app = testApp(fakeRepository(), {
      skillImports: fakeSkillImportService({ install }, { resolve }),
    });

    const preview = await app.request("/v1/skills/imports/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "github.com/o/r" }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody).toMatchObject({
      data: {
        status: "resolved",
        name: "imported-skill",
        files: [{ path: "SKILL.md", sizeBytes: fileContent.length }],
        source: { resolvedCommit },
        integrity,
      },
      meta: { apiVersion: "v1" },
    });
    expect(JSON.stringify(previewBody)).not.toContain("private bundle bytes");
    expect(previewBody.data).not.toHaveProperty("body");
    expect(Object.keys(previewBody.data.files[0]).sort()).toEqual(["path", "sizeBytes"]);

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
      data: { installation: { name: "imported-skill" }, replayed: false },
    });
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        idempotencyKey: "skill-import-1",
        bundle,
      }),
    );
  });

  it("creates and edits a workspace-authored Skill through the API boundary", async () => {
    const createdInstallation: SkillInstallation = {
      ...fakeSkillInstallation(),
      name: "investigate-bug",
      bundle: {
        ...fakeSkillInstallation().bundle,
        name: "investigate-bug",
        description: "Reproduce and diagnose bugs.",
        body: "Reproduce the issue first.",
        source: { type: "workspace" },
      },
    };
    const updatedInstallation: SkillInstallation = {
      ...createdInstallation,
      bundle: {
        ...createdInstallation.bundle,
        id: "skill_bundle_2",
        body: "Reproduce, isolate, and explain the issue.",
      },
    };
    const authoredBundle = {
      name: "investigate-bug",
      description: "Reproduce and diagnose bugs.",
      body: "Reproduce the issue first.",
      source: { type: "workspace" as const },
      integrity: `sha256:${"c".repeat(64)}`,
      files: [
        {
          path: "SKILL.md",
          content: new TextEncoder().encode("Reproduce the issue first."),
          executable: false,
        },
      ],
      fileCount: 1,
      totalBytes: 26,
    };
    const install = vi.fn(async () => ({
      installation: createdInstallation,
      idempotentReplay: false,
    }));
    const replace = vi.fn(async () => updatedInstallation);
    const create = vi.fn(async () => authoredBundle);
    const app = testApp(fakeRepository(), {
      skillImports: fakeSkillImportService({ install, replace }, {}, { create }),
    });

    const created = await app.request("/v1/skills", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "workspace-skill-1",
      },
      body: JSON.stringify({
        name: "investigate-bug",
        description: "Reproduce and diagnose bugs.",
        instructions: "Reproduce the issue first.",
      }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: {
        installation: {
          name: "investigate-bug",
          bundle: { source: { type: "workspace" } },
        },
        replayed: false,
      },
    });

    const updated = await app.request("/v1/skills/investigate-bug", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Reproduce and diagnose bugs.",
        instructions: "Reproduce, isolate, and explain the issue.",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { bundle: { id: "skill_bundle_2", source: { type: "workspace" } } },
    });
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        idempotencyKey: "workspace-skill-1",
        bundle: authoredBundle,
      }),
    );
    expect(replace).toHaveBeenCalledWith({
      actor,
      name: "investigate-bug",
      bundle: authoredBundle,
    });
    expect(create).toHaveBeenNthCalledWith(1, {
      name: "investigate-bug",
      description: "Reproduce and diagnose bugs.",
      instructions: "Reproduce the issue first.",
    });
    expect(create).toHaveBeenNthCalledWith(2, {
      name: "investigate-bug",
      description: "Reproduce and diagnose bugs.",
      instructions: "Reproduce, isolate, and explain the issue.",
    });
  });

  it("rejects invalid workspace Skill slugs and NUL text at the API boundary", async () => {
    const create = vi.fn(async () => {
      throw new Error("Workspace Skill authoring should not run for invalid input.");
    });
    const app = testApp(fakeRepository(), {
      skillImports: fakeSkillImportService({}, {}, { create }),
    });
    const updateBody = {
      description: "Reproduce and diagnose bugs.",
      instructions: "Reproduce the issue first.",
    };

    const invalidSlug = await app.request("/v1/skills/Invalid-Name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateBody),
    });
    const invalidDescription = await app.request("/v1/skills", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "workspace-skill-invalid-description",
      },
      body: JSON.stringify({
        name: "investigate-bug",
        ...updateBody,
        description: "Contains a NUL: \0",
      }),
    });
    const invalidInstructions = await app.request("/v1/skills/investigate-bug", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updateBody, instructions: "Contains a NUL: \0" }),
    });

    expect([invalidSlug.status, invalidDescription.status, invalidInstructions.status]).toEqual([
      400, 400, 400,
    ]);
    await expect(invalidSlug.json()).resolves.toMatchObject({
      error: { code: "invalid_request", retryable: false },
    });
    await expect(invalidDescription.json()).resolves.toMatchObject({
      error: { code: "invalid_request", retryable: false },
    });
    await expect(invalidInstructions.json()).resolves.toMatchObject({
      error: { code: "invalid_request", retryable: false },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("serves and mutates workspace-scoped Wiki sources through typed routes", async () => {
    const list = vi.fn(async () => [wikiSourceView()]);
    const listActivity = vi.fn(async () => ({
      items: [wikiActivityItem()],
      nextCursor: "cursor_2",
    }));
    const upsert = vi.fn(async () => wikiSourceView());
    const setEnabled = vi.fn(async () => wikiSourceView({ enabled: false }));
    const remove = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      wikiSources: wikiSourceService({ list, listActivity, upsert, setEnabled, remove }),
    });

    const listed = await app.request("/v1/wiki/sources");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      data: [{ id: "gwscfg_1", provider: "gmail", enabled: true, canToggle: true }],
    });
    expect(JSON.stringify(listedBody)).not.toMatch(/userWorkosId|workspaceId|credential|token/iu);
    expect(list).toHaveBeenCalledWith(actor);

    const activity = await app.request("/v1/wiki/sources/activity?limit=10&cursor=cursor_1");
    expect(activity.status).toBe(200);
    await expect(activity.json()).resolves.toMatchObject({
      data: {
        items: [
          {
            id: "gwjob_1",
            provider: "gmail",
            outcome: "succeeded",
            pages: [{ path: "projects/launch", action: "updated" }],
          },
        ],
        nextCursor: "cursor_2",
      },
    });
    expect(listActivity).toHaveBeenCalledWith(actor, { limit: 10, cursor: "cursor_1" });

    const configured = await app.request("/v1/wiki/sources", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        integrationId: "integration_1",
        provider: "gmail",
        enabled: true,
        config: { instructions: "Only customer mail" },
      }),
    });
    expect(configured.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(actor, {
      integrationId: "integration_1",
      provider: "gmail",
      enabled: true,
      config: { instructions: "Only customer mail" },
    });

    const disabled = await app.request("/v1/wiki/sources/gwscfg_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({ data: { enabled: false } });
    expect(setEnabled).toHaveBeenCalledWith(actor, "gwscfg_1", false);

    const removed = await app.request("/v1/wiki/sources/gwscfg_1", { method: "DELETE" });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      data: { sourceId: "gwscfg_1", deleted: true },
    });
    expect(remove).toHaveBeenCalledWith(actor, "gwscfg_1");
  });

  it("rejects unsupported Wiki source providers before invoking source logic", async () => {
    const upsert = vi.fn(async () => wikiSourceView());
    const app = testApp(fakeRepository(), {
      wikiSources: wikiSourceService({ upsert }),
    });
    const response = await app.request("/v1/wiki/sources", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        integrationId: "integration_1",
        provider: "google_drive",
        enabled: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects the retired hand-authored Skill payload instead of reviving its data model", async () => {
    const app = testApp(fakeRepository());

    const create = await app.request("/v1/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "legacy-create" },
      body: JSON.stringify({ name: "Legacy Skill" }),
    });
    const update = await app.request("/v1/skills/imported-skill", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Legacy Skill",
        description: "Retired.",
        instructions: "Do the thing.",
        status: "active",
      }),
    });

    expect(create.status).toBe(400);
    expect(update.status).toBe(400);
  });

  it("lists, inspects, reads, replaces, disables, and archives Skill installations", async () => {
    const installation = fakeSkillInstallation();
    const { createdAt: _createdAt, bundle, ...installationFields } = installation;
    const { body: _body, files: _files, ...bundleSummary } = bundle;
    const listItem: SkillInstallationListItem = {
      ...installationFields,
      bundle: bundleSummary,
    };
    const list = vi.fn(async () => [listItem]);
    const get = vi.fn(async () => installation);
    const readFile = vi.fn(async () => ({
      path: "references/data.bin",
      content: Uint8Array.of(0, 255, 1, 2),
      executable: false,
      sizeBytes: 4,
    }));
    const setEnabled = vi.fn(async () => ({ ...installation, enabled: false }));
    const replace = vi.fn(async () => installation);
    const archive = vi.fn(async () => undefined);
    if (bundle.source.type === "workspace") {
      throw new Error("Expected the fixture to use an external Skill source.");
    }
    const resolvedBundle = {
      name: installation.name,
      description: bundle.description,
      body: bundle.body,
      source: bundle.source,
      integrity: bundle.integrity,
      files: [
        {
          path: "SKILL.md",
          content: new TextEncoder().encode("private bytes"),
          executable: false,
        },
      ],
      fileCount: 1,
      totalBytes: 13,
    };
    const app = testApp(fakeRepository(), {
      skillImports: fakeSkillImportService(
        { list, get, readFile, setEnabled, replace, archive },
        {
          resolve: vi.fn(async () => ({
            status: "resolved" as const,
            bundle: resolvedBundle,
            warnings: [],
          })),
        },
      ),
    });

    const listResponse = await app.request("/v1/skills");
    await expect(listResponse.json()).resolves.toMatchObject({
      data: [{ name: "imported-skill", bundle: { integrity: bundle.integrity } }],
    });
    const inspectResponse = await app.request("/v1/skills/imported-skill");
    await expect(inspectResponse.json()).resolves.toMatchObject({
      data: { bundle: { body: bundle.body, files: bundle.files } },
    });
    const readResponse = await app.request(
      "/v1/skills/imported-skill/files/read?path=references%2Fdata.bin&maxBytes=4",
    );
    await expect(readResponse.json()).resolves.toMatchObject({
      data: { encoding: "base64", content: Buffer.from([0, 255, 1, 2]).toString("base64") },
    });
    await expect(
      app.request("/v1/skills/imported-skill/disable", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/skills/imported-skill/replace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: bundle.source.url,
          expectedResolvedCommit: bundle.source.resolvedCommit,
          expectedIntegrity: bundle.integrity,
        }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/skills/imported-skill/archive", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });

    expect(readFile).toHaveBeenCalledWith({
      actor,
      name: "imported-skill",
      path: "references/data.bin",
    });
    expect(setEnabled).toHaveBeenCalledWith({ actor, name: "imported-skill", enabled: false });
    expect(replace).toHaveBeenCalledWith({
      actor,
      name: "imported-skill",
      bundle: resolvedBundle,
    });
    expect(archive).toHaveBeenCalledWith({ actor, name: "imported-skill" });
  });

  it("previews and manages Plugins without exposing package bytes or MCP environment values", async () => {
    const installation = fakePluginInstallation();
    const packageBytes = new TextEncoder().encode("private plugin package");
    const resolved: ResolvedPluginPackage = {
      manifest: installation.manifest,
      source: installation.source,
      integrity: installation.integrity,
      files: [{ path: "plugin.json", content: packageBytes, executable: false }],
      fileCount: 1,
      totalBytes: packageBytes.length,
      skills: [],
      stdioServers: installation.stdioServers,
      remoteServers: [
        {
          name: "remote",
          type: "streamable-http",
          url: "https://mcp.example.test",
          headers: { Authorization: "Bearer secret-value" },
        },
      ],
      capabilities: [
        { id: "read", label: "Read tools", defaultMode: "on", tools: ["list_issues"] },
      ],
      report: {
        ignoredManifestFields: [],
        skills: [],
        mcp: installation.installReport.mcp,
      },
    };
    const install = vi.fn(async () => ({ plugin: installation, idempotentReplay: false }));
    const {
      stdioServers: _stdioServers,
      remoteMcpServers: _remoteMcpServers,
      files: _pluginFiles,
      skills: _pluginSkills,
      ...pluginListFields
    } = installation;
    const listItem: PluginInstallationListItem = {
      ...pluginListFields,
      fileCount: 1,
      skillCount: 0,
      stdioServerCount: 1,
    };
    const list = vi.fn(async () => [listItem]);
    const get = vi.fn(async () => installation);
    const setStatus = vi.fn(async () => ({ ...installation, status: "disabled" as const }));
    const approveMcp = vi.fn(async () => ({
      ...installation,
      mcpApprovedIntegrity: installation.integrity,
    }));
    const revokeMcp = vi.fn(async () => ({ ...installation, mcpApprovedIntegrity: null }));
    const archive = vi.fn(async () => undefined);
    const deleteData = vi.fn(async () => ({ deleted: true }));
    const refresh = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      pluginImports: fakePluginImportService(
        { install, list, get, setStatus, approveMcp, revokeMcp, archive, deleteData },
        { resolve: vi.fn(async () => resolved) },
        { refresh },
      ),
    });

    const preview = await app.request("/v1/plugins/imports/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "github.com/example/plugins" }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody).toMatchObject({
      data: {
        manifest: { name: "quality-tools" },
        files: [{ path: "plugin.json", sizeBytes: packageBytes.length }],
        stdioServers: [{ name: "local", envKeys: ["PRIVATE_TOKEN"] }],
        remoteMcpServers: [
          {
            name: "remote",
            type: "streamable-http",
            connectionProvider: "quality-tools",
            capabilities: [{ id: "read", tools: ["list_issues"] }],
          },
        ],
      },
    });
    expect(JSON.stringify(previewBody)).not.toContain("private plugin package");
    expect(JSON.stringify(previewBody)).not.toContain("secret-value");
    expect(JSON.stringify(previewBody)).not.toContain("https://mcp.example.test");

    const imported = await app.request("/v1/plugins/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "plugin-import-1" },
      body: JSON.stringify({
        url: "github.com/example/plugins",
        expectedResolvedCommit: installation.source.resolvedCommit,
        expectedIntegrity: installation.integrity,
      }),
    });
    expect(imported.status).toBe(201);
    const importedBody = await imported.json();
    expect(importedBody).toMatchObject({
      data: { plugin: { name: "quality-tools", stdioServers: [{ envKeys: ["PRIVATE_TOKEN"] }] } },
    });
    expect(JSON.stringify(importedBody)).not.toContain("secret-value");

    await expect(app.request("/v1/plugins")).resolves.toMatchObject({ status: 200 });
    const inspected = await app.request("/v1/plugins/quality-tools");
    expect(inspected.status).toBe(200);
    await expect(inspected.json()).resolves.toMatchObject({
      data: {
        remoteMcpServers: [
          {
            name: "remote",
            discoveryStatus: "stale",
            tools: [{ name: "list_issues" }],
            lastDiscoveryError: "Provider discovery timed out.",
          },
        ],
      },
    });
    await expect(
      app.request("/v1/plugins/quality-tools/mcp/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrity: installation.integrity }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/plugins/quality-tools/mcp/revoke", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/plugins/quality-tools/mcp/refresh", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/plugins/quality-tools/disable", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/plugins/quality-tools/data/delete", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("/v1/plugins/quality-tools/archive", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });

    expect(setStatus).toHaveBeenCalledWith({ actor, name: "quality-tools", status: "disabled" });
    expect(approveMcp).toHaveBeenCalledWith({
      actor,
      name: "quality-tools",
      integrity: installation.integrity,
    });
    expect(revokeMcp).toHaveBeenCalledWith({ actor, name: "quality-tools" });
    expect(refresh).toHaveBeenLastCalledWith({
      actor,
      pluginName: "quality-tools",
      reason: "explicit",
    });
    expect(deleteData).toHaveBeenCalledWith({ actor, name: "quality-tools" });
    expect(archive).toHaveBeenCalledWith({ actor, name: "quality-tools" });
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

  it("drives the company-context import lifecycle through typed commands", async () => {
    const start = vi.fn(async () => ({
      importRunId: "gbimp_1",
      status: "discovering" as const,
      replayed: false,
    }));
    const confirm = vi.fn(async () => ({
      importRunId: "gbimp_1",
      status: "ingesting" as const,
      replayed: false,
    }));
    const cancel = vi.fn(async () => ({
      importRunId: "gbimp_1",
      status: "canceled" as const,
      replayed: false,
    }));
    const retry = vi.fn(async () => ({
      importRunId: "gbimp_1",
      status: "discovering" as const,
      replayed: false,
    }));
    const app = testApp(fakeRepository(), {
      brainImports: brainImportService({ start, confirm, cancel, retry }),
      wikiImports: fakeWikiImports(),
    });

    const started = await app.request("/v1/brains/brain_1/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "import-key-1" },
      body: JSON.stringify({
        companyUrl: "acme.com",
        focus: "Product architecture",
        sourceSelection: {
          public_web: { enabled: true },
          github: {
            enabled: true,
            integrationId: "integration_1",
            config: { repos: [{ id: "repo_1", fullName: "acme/api" }] },
          },
        },
      }),
    });
    expect(started.status).toBe(201);
    await expect(started.json()).resolves.toMatchObject({
      data: { importRunId: "gbimp_1", status: "discovering", replayed: false },
    });
    expect(start).toHaveBeenCalledWith(actor, "brain_1", {
      idempotencyKey: "import-key-1",
      companyUrl: "acme.com",
      focus: "Product architecture",
      sourceSelection: {
        public_web: { enabled: true },
        github: {
          enabled: true,
          integrationId: "integration_1",
          config: { repos: [{ id: "repo_1", fullName: "acme/api" }] },
        },
      },
    });

    const confirmed = await app.request("/v1/brains/brain_1/imports/gbimp_1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledProviders: ["public_web", "github"] }),
    });
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      data: { importRunId: "gbimp_1", status: "ingesting" },
    });
    expect(confirm).toHaveBeenCalledWith(actor, "brain_1", "gbimp_1", ["public_web", "github"]);

    const canceled = await app.request("/v1/brains/brain_1/imports/gbimp_1/cancel", {
      method: "POST",
    });
    expect(canceled.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith(actor, "brain_1", "gbimp_1");

    const retried = await app.request("/v1/brains/brain_1/imports/gbimp_1/retry", {
      method: "POST",
    });
    expect(retried.status).toBe(200);
    expect(retry).toHaveBeenCalledWith(actor, "brain_1", "gbimp_1");
  });

  it("requires an Idempotency-Key and a valid selection to start an import", async () => {
    const start = vi.fn(async () => ({
      importRunId: "gbimp_1",
      status: "discovering" as const,
      replayed: false,
    }));
    const app = testApp(fakeRepository(), {
      brainImports: brainImportService({ start }),
      wikiImports: fakeWikiImports(),
    });

    const missingKey = await app.request("/v1/brains/brain_1/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyUrl: "acme.com", sourceSelection: {} }),
    });
    expect(missingKey.status).toBe(400);

    const unknownConfig = await app.request("/v1/brains/brain_1/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "import-key-2" },
      body: JSON.stringify({
        companyUrl: "acme.com",
        sourceSelection: {
          slack: { enabled: true, integrationId: "integration_2", config: { channels: [] } },
        },
      }),
    });
    expect(unknownConfig.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("drives the workspace Wiki import lifecycle without a Brain parameter", async () => {
    const start = vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "discovering" as const,
      replayed: false,
    }));
    const confirm = vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "ingesting" as const,
      replayed: false,
    }));
    const cancel = vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "canceled" as const,
      replayed: false,
    }));
    const retry = vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "discovering" as const,
      replayed: false,
    }));
    const app = testApp(fakeRepository(), {
      wikiImports: wikiImportService({ start, confirm, cancel, retry }),
    });

    const started = await app.request("/v1/wiki/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "wiki-import-1" },
      body: JSON.stringify({
        companyUrl: "acme.com",
        sourceSelection: { public_web: { enabled: true } },
      }),
    });
    expect(started.status).toBe(201);
    expect(start).toHaveBeenCalledWith(actor, {
      idempotencyKey: "wiki-import-1",
      companyUrl: "acme.com",
      sourceSelection: { public_web: { enabled: true } },
    });

    await app.request("/v1/wiki/imports/gbimp_wiki/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledProviders: ["public_web"] }),
    });
    expect(confirm).toHaveBeenCalledWith(actor, "gbimp_wiki", ["public_web"]);
    await app.request("/v1/wiki/imports/gbimp_wiki/cancel", { method: "POST" });
    expect(cancel).toHaveBeenCalledWith(actor, "gbimp_wiki");
    await app.request("/v1/wiki/imports/gbimp_wiki/retry", { method: "POST" });
    expect(retry).toHaveBeenCalledWith(actor, "gbimp_wiki");
  });

  it("maps import state conflicts to typed conflict responses", async () => {
    const app = testApp(fakeRepository(), {
      brainImports: brainImportService({
        confirm: async () => {
          throw new CoreError(
            "conflict",
            "This company-context scan is no longer awaiting confirmation.",
          );
        },
      }),
      wikiImports: fakeWikiImports(),
    });
    const response = await app.request("/v1/brains/brain_1/imports/gbimp_1/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledProviders: [] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
  });

  it("returns a retryable typed error when external Skill resolution is unavailable", async () => {
    const upstreamError = Object.assign(new Error("GitHub artifact request was rate limited."), {
      upstreamService: "github",
      upstreamOperation: "resolve_commit",
      upstreamStatus: 403,
      failureKind: "rate_limit",
      rateLimitRemaining: 0,
    });
    const failure = new CoreError("unavailable", "Couldn't read that skill right now.", {
      cause: upstreamError,
    });
    const captureException = vi.fn();
    setExceptionReporter({ captureException });
    try {
      const app = testApp(fakeRepository(), {
        skillImports: fakeSkillImportService(
          {},
          {
            resolve: async () => {
              throw failure;
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
      expect(captureException).toHaveBeenCalledWith(
        failure,
        expect.objectContaining({
          event: "opencompany.api_request_failed",
          method: "POST",
          path: "/v1/skills/imports/preview",
          request_id: expect.stringMatching(/^request_/u),
        }),
      );
    } finally {
      setExceptionReporter(undefined);
    }
  });

  it("serves and mutates browser profiles through the authenticated owner boundary", async () => {
    const profile = {
      id: "3e4f8f0a-1af5-4a5e-9d68-0a4a3f6f8a01",
      name: "Notion",
      siteHost: "notion.so",
      allowedHosts: ["notion.so"],
      status: "pending_login" as const,
      active: false,
      lastUsedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const list = vi.fn(async () => [profile]);
    const create = vi.fn(async () => profile);
    const remove = vi.fn(async () => undefined);
    const createLoginSession = vi.fn(async () => ({
      sessionId: "bb_session_1",
      liveViewUrl: "https://live.browserbase.com/session/bb_session_1",
    }));
    const completeLoginSession = vi.fn(async () => undefined);
    const resolveLiveViewUrl = vi.fn(
      async () => "https://live.browserbase.com/session/bb_session_1",
    );
    const app = testApp(fakeRepository(), {
      browserProfiles: browserProfileService({
        list,
        create,
        remove,
        createLoginSession,
        completeLoginSession,
        resolveLiveViewUrl,
      }),
    });

    const listed = await app.request("/v1/browser-profiles");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({ data: [{ id: profile.id, status: "pending_login" }] });
    expect(JSON.stringify(listedBody)).not.toMatch(
      /workos|credential|context_id|browserbasecontextid/iu,
    );
    expect(list).toHaveBeenCalledWith(actor);

    const created = await app.request("/v1/browser-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Notion", url: "https://notion.so" }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ data: { id: profile.id } });
    expect(create).toHaveBeenCalledWith(actor, { name: "Notion", url: "https://notion.so" });

    const login = await app.request(`/v1/browser-profiles/${profile.id}/login-sessions`, {
      method: "POST",
    });
    expect(login.status).toBe(201);
    await expect(login.json()).resolves.toMatchObject({
      data: {
        profileId: profile.id,
        sessionId: "bb_session_1",
        liveViewUrl: "https://live.browserbase.com/session/bb_session_1",
      },
    });
    expect(createLoginSession).toHaveBeenCalledWith(actor, profile.id);

    const completed = await app.request(
      `/v1/browser-profiles/${profile.id}/login-sessions/bb_session_1/complete`,
      { method: "POST" },
    );
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      data: { profileId: profile.id, sessionId: "bb_session_1", completed: true },
    });
    expect(completeLoginSession).toHaveBeenCalledWith(actor, profile.id, "bb_session_1");

    const liveView = await app.request(
      `/v1/browser-profiles/${profile.id}/live-view?sessionId=bb_session_1`,
    );
    expect(liveView.status).toBe(200);
    await expect(liveView.json()).resolves.toMatchObject({
      data: { url: "https://live.browserbase.com/session/bb_session_1" },
    });
    expect(resolveLiveViewUrl).toHaveBeenCalledWith(actor, profile.id, "bb_session_1");

    const removed = await app.request(`/v1/browser-profiles/${profile.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      data: { profileId: profile.id, deleted: true },
    });
    expect(remove).toHaveBeenCalledWith(actor, profile.id);
  });

  it("maps browser profile domain failures to typed protocol errors", async () => {
    const app = testApp(fakeRepository(), {
      browserProfiles: browserProfileService({
        create: async () => {
          throw new CoreError("unavailable", "Browser profiles are not enabled.");
        },
        createLoginSession: async () => {
          throw new CoreError("conflict", "This browser profile already has an active session.");
        },
        resolveLiveViewUrl: async () => {
          throw new CoreError("not_found", "This browser session is not active.");
        },
      }),
    });

    const unavailable = await app.request("/v1/browser-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Notion", url: "https://notion.so" }),
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "unavailable", retryable: true },
    });

    const conflicted = await app.request("/v1/browser-profiles/profile_1/login-sessions", {
      method: "POST",
    });
    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toMatchObject({ error: { code: "conflict" } });

    const missing = await app.request("/v1/browser-profiles/profile_1/live-view?sessionId=s1");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "not_found" } });

    const invalid = await app.request("/v1/browser-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", url: "" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
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

  it("binds every provider ingress route to its service outside the /v1 middleware", async () => {
    const record =
      (name: string, calls: string[]) =>
      async (...args: unknown[]) => {
        calls.push(`${name}:${args.length}`);
        return Response.json({ ok: true, service: name });
      };
    // The remote-MCP ingress dispatches on a provider key; echo it back so the
    // route table below proves each path binds its own provider.
    const recordMcp =
      (name: string, calls: string[]) => async (provider: string, _request: Request) => {
        calls.push(`${name}:${provider}`);
        return Response.json({ ok: true, service: `${name}.${provider}` });
      };
    const calls: string[] = [];
    const app = testApp(fakeRepository(), {
      githubIngress: {
        start: record("github.start", calls),
        callback: record("github.callback", calls),
        webhook: record("github.webhook", calls),
      },
      githubUserIngress: {
        start: record("github-user.start", calls),
        callback: record("github-user.callback", calls),
        installations: record("github-user.installations", calls),
      },
      googleIngress: {
        start: record("google.start", calls),
        callback: record("google.callback", calls),
        driveWebhook: record("google.driveWebhook", calls),
      },
      slackIngress: {
        start: record("slack.start", calls),
        callback: record("slack.callback", calls),
      },
      linearIngress: {
        start: record("linear.start", calls),
        callback: record("linear.callback", calls),
        webhook: record("linear.webhook", calls),
      },
      hubspotIngress: {
        start: record("hubspot.start", calls),
        callback: record("hubspot.callback", calls),
        webhook: record("hubspot.webhook", calls),
      },
      attioIngress: {
        webhook: record("attio.webhook", calls),
      },
      jamieIngress: {
        webhook: record("jamie.webhook", calls),
        webhookForIntegration: record("jamie.webhookForIntegration", calls),
      },
      mcpOAuthIngress: {
        start: recordMcp("mcp.start", calls),
        callback: recordMcp("mcp.callback", calls),
      },
      xAccountIngress: {
        start: record("x-account.start", calls),
        callback: record("x-account.callback", calls),
      },
      slackBotIngress: {
        start: record("slack-bot.start", calls),
        callback: record("slack-bot.callback", calls),
        webhook: record("slack-bot.webhook", calls),
      },
    });

    const routes: Array<[string, string, string]> = [
      ["GET", "/integrations/github/start", "github.start"],
      ["GET", "/integrations/github/callback", "github.callback"],
      ["POST", "/webhooks/github/events", "github.webhook"],
      ["GET", "/integrations/github-user/start", "github-user.start"],
      ["GET", "/integrations/github-user/callback", "github-user.callback"],
      ["GET", "/integrations/github-user/installations", "github-user.installations"],
      ["POST", "/integrations/github-user/installations", "github-user.installations"],
      ["GET", "/integrations/gmail/start", "google.start"],
      ["GET", "/integrations/gmail/callback", "google.callback"],
      ["GET", "/integrations/google-calendar/start", "google.start"],
      ["GET", "/integrations/google-calendar/callback", "google.callback"],
      ["GET", "/integrations/google-drive/start", "google.start"],
      ["GET", "/integrations/google-drive/callback", "google.callback"],
      ["POST", "/webhooks/google-drive", "google.driveWebhook"],
      ["GET", "/integrations/slack/start", "slack.start"],
      ["GET", "/integrations/slack/callback", "slack.callback"],
      ["GET", "/integrations/linear-ingest/start", "linear.start"],
      ["GET", "/integrations/linear-ingest/callback", "linear.callback"],
      ["POST", "/webhooks/linear/events", "linear.webhook"],
      ["GET", "/integrations/hubspot/start", "hubspot.start"],
      ["GET", "/integrations/hubspot/callback", "hubspot.callback"],
      ["POST", "/webhooks/hubspot/events", "hubspot.webhook"],
      ["POST", "/webhooks/attio/events", "attio.webhook"],
      ["POST", "/webhooks/jamie", "jamie.webhook"],
      ["POST", "/webhooks/jamie/gint_1", "jamie.webhookForIntegration"],
      ["GET", "/integrations/linear/start", "mcp.start.linear"],
      ["GET", "/integrations/linear/callback", "mcp.callback.linear"],
      ["GET", "/integrations/posthog/start", "mcp.start.posthog"],
      ["GET", "/integrations/posthog/callback", "mcp.callback.posthog"],
      ["GET", "/integrations/neon/start", "mcp.start.neon"],
      ["GET", "/integrations/neon/callback", "mcp.callback.neon"],
      ["GET", "/integrations/latitude/start", "mcp.start.latitude"],
      ["GET", "/integrations/latitude/callback", "mcp.callback.latitude"],
      ["GET", "/integrations/signoz/start", "mcp.start.signoz"],
      ["GET", "/integrations/signoz/callback", "mcp.callback.signoz"],
      ["GET", "/integrations/x-account/start", "x-account.start"],
      ["GET", "/integrations/x-account/callback", "x-account.callback"],
      ["GET", "/integrations/slack-bot/start", "slack-bot.start"],
      ["GET", "/integrations/slack-bot/callback", "slack-bot.callback"],
      ["POST", "/webhooks/slack-bot/events", "slack-bot.webhook"],
    ];
    for (const [method, path, service] of routes) {
      const response = await app.request(path, { method, body: method === "POST" ? "{}" : null });
      expect(response.status, `${method} ${path}`).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, service });
    }
    expect(
      (await app.request("/webhooks/slack/events", { method: "POST", body: "{}" })).status,
    ).toBe(404);
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
        "Access-Control-Request-Headers":
          "content-type,idempotency-key,x-opencompany-protocol-version",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://my.opencompany.chat");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    const allowedHeaders = allowed.headers.get("access-control-allow-headers")?.toLowerCase();
    expect(allowedHeaders).toContain("idempotency-key");
    expect(allowedHeaders).toContain("x-opencompany-protocol-version");
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

  it("allows conditional cross-origin Message presentation reads", async () => {
    const app = testApp(fakeRepository(), {
      browserOrigins: ["https://my.opencompany.chat"],
    });
    const response = await app.request(
      "/v1/conversations/conversation_1/messages/message_assistant_1/presentation",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://my.opencompany.chat",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "if-none-match",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://my.opencompany.chat");
    expect(response.headers.get("access-control-allow-headers")?.split(",")).toEqual(
      expect.arrayContaining([...V1_BROWSER_REQUEST_HEADERS]),
    );
  });

  it("rejects cookie mutations without an allowed Origin while preserving bearer clients", async () => {
    const repository = fakeRepository();
    const app = testApp(repository, {
      browserOrigins: ["https://my.opencompany.chat"],
    });
    const body = JSON.stringify({
      content: "Hello",
      engine: { type: "opencompany", schemaVersion: 1 },
    });
    const headers = messageHeaders("send_1");

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

  it.each([undefined, "0.9.0"])(
    "rejects stale Message clients with an actionable refresh error (%s)",
    async (protocolVersion) => {
      const repository = fakeRepository();
      const response = await testApp(repository).request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "send_stale_1",
          ...(protocolVersion ? { [PROTOCOL_VERSION_HEADER]: protocolVersion } : {}),
        },
        body: JSON.stringify({
          content: "Hello",
          engine: "opencompany",
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_request",
          message: PROTOCOL_UPDATE_REQUIRED_MESSAGE,
          retryable: false,
        },
        meta: { protocolVersion: PROTOCOL_VERSION },
      });
      expect(repository.lastCommand).toBeNull();
    },
  );

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
      headers: messageHeaders("send_1"),
      body: JSON.stringify({
        content: "Hello",
        engine: { type: "opencompany", schemaVersion: 1 },
      }),
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

  it("admits Codex through the canonical Message command with versioned engine settings", async () => {
    const repository = fakeRepository();
    const getCodexStatus = vi.fn(async () => ({
      status: "connected" as const,
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
      workspaceEngine: null,
    }));
    const app = testApp(repository, {
      engineAuth: engineAuthService({ getCodexStatus }),
    });
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("send_codex_1"),
      body: JSON.stringify({
        clientConversationId: "conversation_codex_1",
        content: "Build the feature",
        engine: {
          type: "codex",
          schemaVersion: 1,
          settings: {
            reasoningEffort: "xhigh",
            planModeEnabled: true,
            goalMode: { objective: "Ship it", tokenBudget: 12_000 },
          },
        },
        model: "openai/gpt-5.6-sol",
      }),
    });

    expect(response.status).toBe(202);
    expect(getCodexStatus).toHaveBeenCalledWith(actor);
    expect(repository.lastCommand).toMatchObject({
      engine: "codex",
      model: "openai/gpt-5.6-sol",
      runtimeModel: "gpt-5.6-sol",
      settings: {
        reasoningEffort: "xhigh",
        planModeReasoningEffort: "high",
        goalMode: { objective: "Ship it", tokenBudget: 12_000 },
      },
    });
  });

  it("fails closed when a coding-engine credential is disconnected", async () => {
    const response = await testApp(fakeRepository(), {
      engineAuth: engineAuthService({
        getClaudeCodeStatus: async () => ({
          status: null,
          statusReason: null,
          lastValidatedAt: null,
          lastRotatedAt: null,
        }),
      }),
    }).request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("send_claude_1"),
      body: JSON.stringify({
        content: "Build the feature",
        engine: {
          type: "claude_code",
          schemaVersion: 1,
          settings: { reasoningEffort: "high" },
        },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
  });

  it("rejects a follow-up that tries to switch Conversation engines", async () => {
    const response = await testApp(fakeRepository()).request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("send_switch_1"),
      body: JSON.stringify({
        conversationId: "conversation_1",
        content: "Continue",
        engine: {
          type: "codex",
          schemaVersion: 1,
          settings: { reasoningEffort: "high" },
        },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
  });

  it("continues a completed workflow Task through its Conversation", async () => {
    const repository = fakeRepository();
    repository.getConversation = async () => null;
    repository.createMessageAndRun = async ({ command }) => {
      repository.lastCommand = command;
      return {
        conversationId: command.conversationId ?? "conversation_unexpected",
        messageId: "message_task_follow_up_user",
        assistantMessageId: "message_task_follow_up_assistant",
        runId: "run_task_follow_up",
        transactionId: "43",
        idempotentReplay: false,
      };
    };
    const tasks = fakeTaskRepository();
    tasks.getTaskByConversation = async ({ conversationId }) =>
      conversationId === "conversation_task_1"
        ? fakeTask({
            status: "succeeded",
            source: "workflow",
            model: "provider/task-model",
          })
        : null;
    const generate = vi.fn(async () => ({
      conversationId: "conversation_task_1",
      title: "Workflow task",
      generated: true,
    }));

    const response = await testApp(repository, {
      tasks: new TaskApplicationService(tasks),
      chatTitles: { generate },
    }).request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("send_task_follow_up_1"),
      body: JSON.stringify({
        conversationId: "conversation_task_1",
        content: "Please check the afternoon too",
        engine: { type: "opencompany", schemaVersion: 1 },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        conversationId: "conversation_task_1",
        runId: "run_task_follow_up",
      },
    });
    expect(repository.lastCommand).toMatchObject({
      conversationId: "conversation_task_1",
      engine: "opencompany",
      model: "provider/task-model",
    });
    expect(generate).not.toHaveBeenCalled();
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
      headers: messageHeaders("send_auto_1"),
      body: JSON.stringify({
        clientConversationId: "conversation_auto",
        clientMessageId: "message_auto",
        content: "Route this",
        engine: { type: "opencompany", schemaVersion: 1 },
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
      headers: messageHeaders("send_auto_2"),
      body: JSON.stringify({
        content: "Route this",
        engine: { type: "opencompany", schemaVersion: 1 },
        model: "auto",
      }),
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
      headers: messageHeaders("send_auto_3"),
      body: JSON.stringify({
        content: "Route this",
        engine: {
          type: "claude_code",
          schemaVersion: 1,
          settings: { reasoningEffort: "high" },
        },
        model: "auto",
      }),
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

  it("ends active Run streams during shutdown without polling Postgres again", async () => {
    const shutdown = new AbortController();
    const repository = fakeRepository();
    repository.getRun = vi.fn(async () => ({
      id: "run_1",
      conversationId: "conversation_1",
      triggerMessageId: "message_user_1",
      status: "running" as const,
      engine: "opencompany" as const,
      model: "provider/default",
      attemptCount: 1,
      createdAt,
      updatedAt: createdAt,
    }));
    repository.listRunEvents = vi.fn(async ({ afterSequence }) => ({
      events: [],
      nextSequence: afterSequence,
    }));
    let notifyWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      notifyWaitStarted = resolve;
    });
    const wait = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      notifyWaitStarted?.();
      if (signal.aborted) return false;
      return new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    const app = testApp(repository, {
      shutdownSignal: shutdown.signal,
      notifier: { wait },
    });

    const response = await app.request("/v1/runs/run_1/events");
    const body = response.text();
    await waitStarted;
    shutdown.abort();

    await expect(body).resolves.toBe("");
    expect(repository.getRun).toHaveBeenCalledTimes(2);
    expect(repository.listRunEvents).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
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

  it("returns the same runtime summary from Conversation list and detail REST routes", async () => {
    const app = testApp(fakeRepository());

    const list = await app.request("/v1/conversations");
    const detail = await app.request("/v1/conversations/conversation_1");

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: [
        {
          runtime: {
            status: "running",
            activeRunId: "run_1",
            hasError: false,
            updatedAt: createdAt.toISOString(),
          },
        },
      ],
    });
    await expect(detail.json()).resolves.toMatchObject({
      data: {
        runtime: {
          status: "running",
          activeRunId: "run_1",
          hasError: false,
          updatedAt: createdAt.toISOString(),
        },
      },
    });
  });

  it("lets an org-bound mobile AuthKit session use the existing workspace-scoped conversation list", async () => {
    const execute = vi.fn(async () => ({
      rows: [
        {
          workspaceId: actor.workspaceId,
          role: actor.role,
          taskSpawningEnabled: true,
          legacyBrainEnabled: true,
        },
      ],
    }));
    const authenticate = createWorkOsApiAuthenticator(execute, {
      mobileClientId: "client_mobile",
      verifyJwt: vi.fn(async () => ({
        payload: {
          sub: actor.userId,
          sid: "session_mobile",
          client_id: "client_mobile",
          org_id: "org_workspace_1",
        },
        protectedHeader: { alg: "RS256" },
      })) as never,
    });
    const app = testApp(fakeRepository(), { authenticate });

    const response = await app.request("/v1/conversations", {
      headers: {
        Authorization: `Bearer ${compactJwt({ client_id: "client_mobile" })}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{ id: "conversation_1" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("serves an authorized full Message presentation with ETag revalidation", async () => {
    const get = vi.fn(async () => ({
      presentation: {
        schemaVersion: "opencompany.chat.debug.v1",
        uiMessageParts: [
          {
            type: "tool-search",
            state: "output-available",
            input: { query: "launch" },
            output: { detail: "Full provider result" },
          },
        ],
      },
      updatedAt: "2026-08-10T20:00:01.000Z",
    }));
    const app = testApp(fakeRepository(), { messagePresentations: { get } });

    const response = await app.request(
      "/v1/conversations/conversation_1/messages/message_assistant_1/presentation",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("etag")).toMatch(/^W\//u);
    expect(get).toHaveBeenCalledWith({
      actor,
      conversationId: "conversation_1",
      messageId: "message_assistant_1",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        presentation: {
          uiMessageParts: [{ output: { detail: "Full provider result" } }],
        },
        updatedAt: "2026-08-10T20:00:01.000Z",
      },
    });

    const notModified = await app.request(
      "/v1/conversations/conversation_1/messages/message_assistant_1/presentation",
      { headers: { "If-None-Match": response.headers.get("etag")! } },
    );
    expect(notModified.status).toBe(304);
    await expect(notModified.text()).resolves.toBe("");
  });

  it("authorizes Task presentations through the canonical Task conversation boundary", async () => {
    const repository = fakeRepository();
    repository.getConversation = vi.fn(async () => null);
    const get = vi.fn(async () => ({
      presentation: null,
      updatedAt: "2026-08-10T20:00:01.000Z",
    }));
    const app = testApp(repository, { messagePresentations: { get } });

    const response = await app.request(
      "/v1/conversations/conversation_task_1/messages/message_task_1/presentation",
    );

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith({
      actor,
      conversationId: "conversation_task_1",
      messageId: "message_task_1",
    });
  });

  it("authorizes a conversation-scoped v2 summary before contacting Electric", async () => {
    const repository = fakeRepository();
    const getConversation = vi.fn(repository.getConversation);
    repository.getConversation = getConversation;
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(repository, { readModels: { stream } });

    const response = await app.request(
      "/v1/read-models/chat-conversations-v2?conversationId=conversation_1",
    );

    expect(response.status).toBe(200);
    expect(getConversation).toHaveBeenCalledWith({
      actor,
      conversationId: "conversation_1",
    });
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        readModel: "chat-conversations-v2",
        conversationId: "conversation_1",
      }),
    );

    getConversation.mockResolvedValueOnce(null);
    const denied = await app.request(
      "/v1/read-models/chat-conversations-v2?conversationId=conversation_other",
    );
    expect(denied.status).toBe(404);
    expect(stream).toHaveBeenCalledTimes(1);
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

  it("uses the authorized Conversation epoch instead of a client-selected Message shape epoch", async () => {
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(fakeRepository(), { readModels: { stream } });

    const response = await app.request(
      "/v1/read-models/chat-messages-v2?conversationId=conversation_1&messageShapeEpoch=999",
    );

    expect(response.status).toBe(200);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        readModel: "chat-messages-v2",
        conversationId: "conversation_1",
        messageShapeEpoch: 4,
      }),
    );
  });

  it("authorizes canonical Message and Run read models through their owning Task", async () => {
    const repository = fakeRepository();
    repository.getConversation = vi.fn(async () => null);
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(repository, { readModels: { stream } });

    const response = await app.request(
      "/v1/read-models/chat-messages-v2?conversationId=conversation_task_1",
    );

    expect(response.status).toBe(200);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        readModel: "chat-messages-v2",
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

  it("streams the authenticated integration-account read model without client-selected scope", async () => {
    const stream = vi.fn(async () => Response.json([]));
    const app = testApp(fakeRepository(), { readModels: { stream } });

    const response = await app.request(
      "/v1/read-models/integration-accounts-v1?table=goat.integration_credentials&where=true",
    );

    expect(response.status).toBe(200);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ actor, readModel: "integration-accounts-v1" }),
    );

    const invalid = await app.request(
      "/v1/read-models/integration-accounts-v1?conversationId=conversation_1",
    );
    expect(invalid.status).toBe(400);
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

  it("owns authenticated Conversation shares behind the canonical resource", async () => {
    const findShare = vi.fn(async () => null);
    const ensureShare = vi.fn(async () => "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd");
    const revokeShare = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      chatResources: chatResourceService({ findShare, ensureShare, revokeShare }),
    });

    const current = await app.request("/v1/conversations/conversation_1/share");
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      data: { conversationId: "conversation_1", shareId: null },
    });
    expect(findShare).toHaveBeenCalledWith(actor, "conversation_1");

    const created = await app.request("/v1/conversations/conversation_1/share", {
      method: "PUT",
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      data: {
        conversationId: "conversation_1",
        shareId: "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd",
      },
    });
    expect(ensureShare).toHaveBeenCalledWith(actor, "conversation_1");

    const revoked = await app.request("/v1/conversations/conversation_1/share", {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      data: { conversationId: "conversation_1", shareId: null },
    });
    expect(revokeShare).toHaveBeenCalledWith(actor, "conversation_1");
  });

  it("owns Conversation title generation and Message analytics in the API runtime", async () => {
    const generate = vi.fn(async () => ({
      conversationId: "conversation_1",
      title: "Launch plan",
      generated: true,
    }));
    const captureChatMessage = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      chatTitles: { generate },
      captureChatMessage,
    });

    const title = await app.request("/v1/conversations/conversation_1/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "message_user_1" }),
    });
    expect(title.status).toBe(200);
    await expect(title.json()).resolves.toMatchObject({
      data: { conversationId: "conversation_1", title: "Launch plan", generated: true },
    });
    expect(generate).toHaveBeenCalledWith(actor, "conversation_1", "message_user_1");

    const message = await app.request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("message-title-1"),
      body: JSON.stringify({
        content: "Prepare a launch plan",
        engine: { type: "opencompany", schemaVersion: 1 },
      }),
    });
    expect(message.status).toBe(202);
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledWith(actor, "conversation_1", "message_user_1");
      expect(captureChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          actor,
          conversationId: "conversation_1",
          firstMessage: true,
          engine: "opencompany",
          messageLength: 21,
          selectionMode: "manual",
        }),
      );
    });
  });

  it("does not repeat title or analytics side effects for an idempotent Message replay", async () => {
    const repository = fakeRepository();
    repository.createMessageAndRun = async ({ command }) => {
      repository.lastCommand = command;
      return {
        conversationId: "conversation_1",
        messageId: "message_user_1",
        assistantMessageId: "message_assistant_1",
        runId: "run_1",
        transactionId: "42",
        idempotentReplay: true,
      };
    };
    const generate = vi.fn(async () => ({
      conversationId: "conversation_1",
      title: "Launch plan",
      generated: true,
    }));
    const captureChatMessage = vi.fn(async () => undefined);
    const app = testApp(repository, {
      chatTitles: { generate },
      captureChatMessage,
    });

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: messageHeaders("message-replay-1"),
      body: JSON.stringify({
        content: "Prepare a launch plan",
        engine: { type: "opencompany", schemaVersion: 1 },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ data: { replayed: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(captureChatMessage).not.toHaveBeenCalled();
  });

  it("serves public Chat presentation without actor authentication or private metadata", async () => {
    const loadPublicShare = vi.fn(async () => ({
      shareId: "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd",
      title: "Shared Chat",
      kind: "chat" as const,
      engine: "codex" as const,
      messages: [{ id: "message_1", role: "assistant" as const, parts: [] }],
    }));
    const app = testApp(fakeRepository(), {
      chatResources: chatResourceService({ loadPublicShare }),
      authenticate: async () => {
        throw new Error("Public resources must not authenticate an actor.");
      },
    });

    const response = await app.request(
      "/public/chat-shares/goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    const body = await response.json();
    expect(body).toMatchObject({
      data: { title: "Shared Chat", engine: "codex", messages: [{ id: "message_1" }] },
    });
    expect(JSON.stringify(body)).not.toMatch(/sessionId|contextTokens|blob|lease|token/iu);
  });

  it("streams authorized Chat resource bytes with defensive headers", async () => {
    const downloadAttachment = vi.fn(async () => ({
      stream: new Response("private attachment").body as ReadableStream<Uint8Array>,
      mediaType: "image/png",
      filename: 'diagram\u0000 "final".png',
      sizeBytes: 18,
      inline: true,
      cacheControl: "private, max-age=86400, immutable",
      sandbox: false,
    }));
    const app = testApp(fakeRepository(), {
      chatResources: chatResourceService({ downloadAttachment }),
    });

    const response = await app.request("/v1/chat-attachments/message_1/attachment_1");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private attachment");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("content-disposition")).toContain("diagram_ _final_.png");
    expect(downloadAttachment).toHaveBeenCalledWith({
      actor,
      messageId: "message_1",
      attachmentId: "attachment_1",
    });
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
      file: expect.objectContaining({
        name: "plan.pdf",
        size: 13,
        type: "application/pdf",
      }),
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
      file: expect.objectContaining({
        name: "plan.pdf",
        size: 13,
        type: "application/pdf",
      }),
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

  it("updates user preferences through the typed settings command", async () => {
    const updatePreferences = vi.fn(async () => ({
      timezone: "Europe/Berlin",
      taskSpawningEnabled: true,
      wikiEnabled: true as const,
      taskViewMode: "list" as const,
      imessageEnabled: false,
      autoModelRoutingEnabled: true,
    }));
    const app = testApp(fakeRepository(), {
      userSettings: { ...fakeUserSettings(), updatePreferences },
    });

    const updated = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Europe/Berlin", taskSpawningEnabled: true }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { timezone: "Europe/Berlin", taskViewMode: "list", autoModelRoutingEnabled: true },
      meta: { apiVersion: "v1" },
    });
    expect(updatePreferences).toHaveBeenCalledWith(actor, {
      timezone: "Europe/Berlin",
      taskSpawningEnabled: true,
    });

    const empty = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const invalidMode = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskViewMode: "kanban" }),
    });
    expect(invalidMode.status).toBe(400);
  });

  it("requires authentication for the settings surfaces", async () => {
    const app = testApp(fakeRepository(), {
      authenticate: async () => {
        throw new ApiError(401, "authentication_required", "Authentication required.");
      },
    });
    for (const [path, method] of [
      ["/v1/me/preferences", "PATCH"],
      ["/v1/me/mcp-setup", "GET"],
      ["/v1/feedback", "POST"],
      ["/v1/repo-configs", "GET"],
      ["/v1/engine-auth/claude-code", "GET"],
      ["/v1/engine-auth/claude-code", "PUT"],
      ["/v1/engine-auth/codex", "GET"],
      ["/v1/engine-auth/codex/device", "POST"],
      ["/v1/engine-auth/infisical", "GET"],
      ["/v1/engine-auth/infisical/start", "POST"],
      ["/v1/engine-auth/infisical", "DELETE"],
    ] as const) {
      const response = await app.request(path, {
        method,
        ...(method === "GET"
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            }),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authentication_required" },
      });
    }
  });

  it("serves MCP setup status and saves the preferred client", async () => {
    const completedAt = new Date("2026-08-11T09:30:00.000Z");
    const getMcpSetup = vi.fn(async () => ({
      preferredClient: null,
      complete: true,
      completedAt,
    }));
    const setPreferredMcpClient = vi.fn(async () => ({
      preferredClient: "cursor" as const,
      complete: false,
      completedAt: null,
    }));
    const app = testApp(fakeRepository(), {
      userSettings: { ...fakeUserSettings(), getMcpSetup, setPreferredMcpClient },
    });

    const status = await app.request("/v1/me/mcp-setup");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      data: { preferredClient: null, complete: true, completedAt: completedAt.toISOString() },
    });

    const saved = await app.request("/v1/me/mcp-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredClient: "cursor" }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: { preferredClient: "cursor", complete: false, completedAt: null },
    });
    expect(setPreferredMcpClient).toHaveBeenCalledWith(actor, "cursor");

    const invalid = await app.request("/v1/me/mcp-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredClient: "vscode" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("dispatches feedback through the injected delivery service", async () => {
    const submit = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), { feedback: { submit } });

    const sent = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "bug", message: "The board drops my column order." }),
    });
    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toMatchObject({ data: { submitted: true } });
    expect(submit).toHaveBeenCalledWith(actor, {
      kind: "bug",
      message: "The board drops my column order.",
    });

    const tooShort = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "bug", message: "no" }),
    });
    expect(tooShort.status).toBe(400);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("serves repository configs without ever echoing stored env values", async () => {
    const updatedAt = new Date("2026-08-12T10:00:00.000Z");
    const configView = {
      repositoryExternalId: "123456789",
      repositoryFullName: "opencompany/app",
      envKeys: ["DATABASE_URL", "API_TOKEN"],
      setupInstructions: "Run bun install.",
      updatedAt,
    };
    const setEnv = vi.fn(async () => configView);
    const remove = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      repoConfigs: {
        ...fakeRepoConfigs(),
        list: async () => ({
          repositories: [
            {
              repositoryExternalId: "123456789",
              repositoryFullName: "opencompany/app",
              private: true,
            },
          ],
          configs: [configView],
        }),
        setEnv,
        remove,
      },
    });

    const listed = await app.request("/v1/repo-configs");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      data: {
        repositories: [{ repositoryExternalId: "123456789", private: true }],
        configs: [{ envKeys: ["DATABASE_URL", "API_TOKEN"], updatedAt: updatedAt.toISOString() }],
      },
    });

    const secretValue = ["postgres:/", "user:hunter2@db.example.test/app"].join("/");
    const saved = await app.request("/v1/repo-configs/123456789/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `DATABASE_URL=${secretValue}` }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(JSON.stringify(savedBody)).not.toContain(secretValue);
    expect(savedBody).toMatchObject({ data: { envKeys: ["DATABASE_URL", "API_TOKEN"] } });
    expect(setEnv).toHaveBeenCalledWith(actor, "123456789", `DATABASE_URL=${secretValue}`);

    const cleared = await app.request("/v1/repo-configs/123456789/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: null }),
    });
    expect(cleared.status).toBe(200);
    expect(setEnv).toHaveBeenLastCalledWith(actor, "123456789", null);

    const invalidId = await app.request("/v1/repo-configs/not-a-repo-id/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "KEY=value" }),
    });
    expect(invalidId.status).toBe(400);

    const removed = await app.request("/v1/repo-configs/123456789", { method: "DELETE" });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      data: { repositoryExternalId: "123456789", deleted: true },
    });
    expect(remove).toHaveBeenCalledWith(actor, "123456789");
  });

  it("maps repository admin gating to a structured forbidden error", async () => {
    const app = testApp(fakeRepository(), {
      repoConfigs: {
        ...fakeRepoConfigs(),
        setSetupInstructions: async () => {
          throw new ApiError(
            403,
            "forbidden",
            "Only workspace admins can configure repository environments.",
          );
        },
      },
    });
    const response = await app.request("/v1/repo-configs/123456789/setup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupInstructions: "Run bun install." }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "forbidden",
        message: "Only workspace admins can configure repository environments.",
      },
    });
  });

  it("serves the integration account control plane through typed commands", async () => {
    const list = vi.fn(async () => [
      {
        integrationId: "gint_abc123",
        provider: "gmail" as const,
        status: "connected" as const,
        connected: true,
        accountEmail: "owner@example.com",
        accountName: "Owner",
        connectionLabel: null,
        statusReason: null,
        scopes: ["gmail.readonly"],
        capabilityModes: {},
      },
    ]);
    const getUsage = vi.fn(async () => ({ affectedBrainSourceCount: 3 }));
    const disconnect = vi.fn(async () => undefined);
    const setCapabilityMode = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      integrationAccounts: integrationAccountService({
        list,
        getUsage,
        disconnect,
        setCapabilityMode,
      }),
    });

    const listed = await app.request("/v1/integration-accounts");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{ integrationId: "gint_abc123", provider: "gmail" }],
    });
    expect(list).toHaveBeenCalledWith(actor);

    const usage = await app.request("/v1/integration-accounts/gint_abc123/usage");
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toMatchObject({
      data: { affectedBrainSourceCount: 3 },
      meta: { apiVersion: "v1" },
    });
    expect(getUsage).toHaveBeenCalledWith(actor, "gint_abc123");

    const mode = await app.request("/v1/integration-accounts/gint_abc123/capability-modes/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "ask" }),
    });
    expect(mode.status).toBe(200);
    await expect(mode.json()).resolves.toMatchObject({
      data: { integrationId: "gint_abc123", capabilityId: "write", mode: "ask" },
    });
    expect(setCapabilityMode).toHaveBeenCalledWith(actor, "gint_abc123", "write", "ask");

    const removed = await app.request("/v1/integration-accounts/gint_abc123", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      data: { integrationId: "gint_abc123", deleted: true },
    });
    expect(disconnect).toHaveBeenCalledWith(actor, "gint_abc123");
  });

  it("serves authenticated Slack bot settings and destination resources", async () => {
    const getWorkspaceSettings = vi.fn(async () => ({
      isAdmin: true,
      configured: true,
      installed: true,
      status: "connected" as const,
      needsScopeUpgrade: false,
      teamName: "Acme",
      statusReason: null,
      destinationCount: 1,
    }));
    const getDestination = vi.fn(async () => ({
      installed: true,
      botConnected: true,
      isAdmin: true,
      brainVisibility: "workspace" as const,
      source: { enabled: true, channels: [{ id: "C1", name: "general" }] },
    }));
    const setDestination = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      slackBotSettings: {
        ...fakeSlackBotSettings(),
        getWorkspaceSettings,
        getDestination,
        setDestination,
      },
    });

    const workspace = await app.request("/v1/workspace/slack-bot");
    expect(workspace.status).toBe(200);
    await expect(workspace.json()).resolves.toMatchObject({
      data: { installed: true, teamName: "Acme", destinationCount: 1 },
    });

    const destination = await app.request("/v1/brains/brain_1/slack-bot");
    expect(destination.status).toBe(200);
    await expect(destination.json()).resolves.toMatchObject({
      data: { source: { channels: [{ id: "C1", name: "general" }] } },
    });

    const updated = await app.request("/v1/brains/brain_1/slack-bot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, channels: [{ id: "C2", name: "product" }] }),
    });
    expect(updated.status).toBe(200);
    expect(setDestination).toHaveBeenCalledWith(actor, "brain_1", {
      enabled: true,
      channels: [{ id: "C2", name: "product" }],
    });
  });

  it("forwards standing action permissions through the authenticated command", async () => {
    const alwaysAllowAction = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      integrationAccounts: integrationAccountService({ alwaysAllowAction }),
    });

    const response = await app.request("/v1/actions/gmail.send_email/permissions/always-allow", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { actionId: "gmail.send_email", state: "allowed" },
      meta: { apiVersion: "v1" },
    });
    expect(alwaysAllowAction).toHaveBeenCalledWith(actor, "gmail.send_email");
  });

  it("routes provider connect commands and never echoes the submitted key", async () => {
    const secretKey = "rk_test_supersecretstripekey000";
    const connectStripe = vi.fn(async () => ({
      provider: "stripe" as const,
      connected: true,
      status: "connected" as const,
      integrationId: "gint_stripe",
      accountName: "Acme",
      livemode: false,
      statusReason: null,
    }));
    const disconnectStripe = vi.fn(async () => undefined);
    const connectAttio = vi.fn(async () => ({
      provider: "attio" as const,
      connected: true,
      status: "connected" as const,
      integrationId: "gint_attio",
      workspaceName: "Acme CRM",
      statusReason: null,
    }));
    const connectRender = vi.fn(async () => ({
      provider: "render" as const,
      connected: true,
      status: "connected" as const,
      integrationId: "gint_render",
      accountName: "Acme Hosting",
      statusReason: null,
      capabilityModes: {},
      toolModes: {},
    }));
    const app = testApp(fakeRepository(), {
      integrationAccounts: integrationAccountService({
        connectStripe,
        disconnectStripe,
        connectAttio,
        connectRender,
      }),
    });

    const stripe = await app.request("/v1/integration-accounts/stripe", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: secretKey }),
    });
    expect(stripe.status).toBe(200);
    const stripeBody = await stripe.json();
    expect(JSON.stringify(stripeBody)).not.toContain(secretKey);
    expect(stripeBody).toMatchObject({
      data: { state: { provider: "stripe", connected: true, livemode: false } },
    });
    expect(connectStripe).toHaveBeenCalledWith(actor, secretKey);

    // The static provider path must win over DELETE /{integrationId}.
    const stripeRemoved = await app.request("/v1/integration-accounts/stripe", {
      method: "DELETE",
    });
    expect(stripeRemoved.status).toBe(200);
    await expect(stripeRemoved.json()).resolves.toMatchObject({ data: { deleted: true } });
    expect(disconnectStripe).toHaveBeenCalledWith(actor);

    const attio = await app.request("/v1/integration-accounts/attio", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "attio-api-key-1234567890" }),
    });
    expect(attio.status).toBe(200);
    await expect(attio.json()).resolves.toMatchObject({
      data: { state: { provider: "attio", workspaceName: "Acme CRM" } },
    });

    const renderKey = "rnd_supersecretrenderkey000";
    const render = await app.request("/v1/integration-accounts/render", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: renderKey }),
    });
    expect(render.status).toBe(200);
    const renderBody = await render.json();
    expect(JSON.stringify(renderBody)).not.toContain(renderKey);
    expect(renderBody).toMatchObject({
      data: { state: { provider: "render", connected: true, accountName: "Acme Hosting" } },
    });
    expect(connectRender).toHaveBeenCalledWith(actor, renderKey);
  });

  it("gives iMessage pairing starts their own small rate bucket", async () => {
    const startImessagePairing = vi.fn(async () => undefined);
    const buckets: string[] = [];
    const rateLimiter: ApiRateLimiter = {
      consume: async ({ bucket, limit }) => {
        buckets.push(`${bucket}:${limit}`);
        return { allowed: true };
      },
    };
    const app = testApp(fakeRepository(), {
      integrationAccounts: integrationAccountService({ startImessagePairing }),
      rateLimiter,
    });

    const started = await app.request("/v1/integration-accounts/imessage/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+14155551234" }),
    });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({ data: { started: true } });
    expect(startImessagePairing).toHaveBeenCalledWith(actor, "+14155551234");
    expect(buckets).toEqual(["imessage-pairing:5"]);
  });

  it("surfaces integration account service errors as protocol envelopes", async () => {
    const app = testApp(fakeRepository(), {
      integrationAccounts: integrationAccountService({
        disconnect: async () => {
          throw new ApiError(
            404,
            "not_found",
            "Only the connection owner can manage this account.",
          );
        },
      }),
    });
    const response = await app.request("/v1/integration-accounts/gint_other", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
        message: "Only the connection owner can manage this account.",
      },
    });
  });

  it("serves engine auth status reads with credential-free DTOs", async () => {
    const getClaudeCodeStatus = vi.fn(async () => ({
      status: "connected" as const,
      statusReason: null,
      lastValidatedAt: "2026-08-12T10:00:00.000Z",
      lastRotatedAt: "2026-08-10T10:00:00.000Z",
    }));
    const getCodexStatus = vi.fn(async () => ({
      status: null,
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
      workspaceEngine: null,
    }));
    const getInfisicalStatus = vi.fn(async () => ({
      status: "needs_reauth" as const,
      statusReason: "Session expired.",
      accountEmail: "ops@example.com",
      host: "https://app.infisical.com",
      lastValidatedAt: null,
    }));
    const app = testApp(fakeRepository(), {
      engineAuth: engineAuthService({ getClaudeCodeStatus, getCodexStatus, getInfisicalStatus }),
    });

    const claude = await app.request("/v1/engine-auth/claude-code");
    expect(claude.status).toBe(200);
    // Pinned with toEqual so credential material can never ride along in the
    // status DTO unnoticed.
    await expect(claude.json()).resolves.toEqual({
      data: {
        status: "connected",
        statusReason: null,
        lastValidatedAt: "2026-08-12T10:00:00.000Z",
        lastRotatedAt: "2026-08-10T10:00:00.000Z",
      },
      meta: { apiVersion: "v1", protocolVersion: expect.any(String) },
    });
    expect(getClaudeCodeStatus).toHaveBeenCalledWith(actor);

    const codex = await app.request("/v1/engine-auth/codex");
    expect(codex.status).toBe(200);
    await expect(codex.json()).resolves.toMatchObject({
      data: { status: null, lastValidatedAt: null },
    });

    const infisical = await app.request("/v1/engine-auth/infisical");
    expect(infisical.status).toBe(200);
    await expect(infisical.json()).resolves.toEqual({
      data: {
        status: "needs_reauth",
        statusReason: "Session expired.",
        accountEmail: "ops@example.com",
        host: "https://app.infisical.com",
        lastValidatedAt: null,
      },
      meta: { apiVersion: "v1", protocolVersion: expect.any(String) },
    });
  });

  it("serves qualified coding runtime status and access resources", async () => {
    const getRuntimeStatus = vi.fn(async () => "sleeping" as const);
    const createRuntimeAccess = vi.fn(async () => ({
      conversationId: "conversation_1",
      websocketUrl: "wss://runner.example.test/goat/runtime",
      ticket: "short-lived-ticket",
      expiresAt: 1_786_449_900,
      runtimeStatus: "running" as const,
    }));
    const app = testApp(fakeRepository(), {
      engineSessions: engineSessionService({ getRuntimeStatus, createRuntimeAccess }),
    });

    const status = await app.request("/v1/conversations/conversation_1/engine-session/runtime");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      data: { conversationId: "conversation_1", status: "sleeping" },
    });
    expect(getRuntimeStatus).toHaveBeenCalledWith(actor, "conversation_1");

    const access = await app.request(
      "/v1/conversations/conversation_1/engine-session/runtime-access",
      { method: "POST" },
    );
    expect(access.status).toBe(201);
    await expect(access.json()).resolves.toMatchObject({
      data: {
        conversationId: "conversation_1",
        websocketUrl: "wss://runner.example.test/goat/runtime",
        runtimeStatus: "running",
      },
    });
    expect(createRuntimeAccess).toHaveBeenCalledWith(actor, "conversation_1");
  });

  it("saves the Claude Code token without echoing it and disconnects engines", async () => {
    const secretToken = "sk-ant-oat01-supersecretsetuptoken000000";
    const saveClaudeCodeToken = vi.fn(async () => ({
      status: "connected" as const,
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: "2026-08-13T09:00:00.000Z",
    }));
    const disconnectClaudeCode = vi.fn(async () => undefined);
    const disconnectCodex = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      engineAuth: engineAuthService({
        saveClaudeCodeToken,
        disconnectClaudeCode,
        disconnectCodex,
      }),
    });

    const saved = await app.request("/v1/engine-auth/claude-code", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: secretToken }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(JSON.stringify(savedBody)).not.toContain(secretToken);
    expect(savedBody).toMatchObject({ data: { status: "connected" } });
    expect(saveClaudeCodeToken).toHaveBeenCalledWith(actor, secretToken);

    const claudeRemoved = await app.request("/v1/engine-auth/claude-code", { method: "DELETE" });
    expect(claudeRemoved.status).toBe(200);
    await expect(claudeRemoved.json()).resolves.toMatchObject({ data: { deleted: true } });
    expect(disconnectClaudeCode).toHaveBeenCalledWith(actor);

    const codexRemoved = await app.request("/v1/engine-auth/codex", { method: "DELETE" });
    expect(codexRemoved.status).toBe(200);
    await expect(codexRemoved.json()).resolves.toMatchObject({ data: { deleted: true } });
    expect(disconnectCodex).toHaveBeenCalledWith(actor);
  });

  it("gives engine auth flow starts their own small rate bucket", async () => {
    const startCodexDeviceAuth = vi.fn(async () => ({
      id: "gcodf_1",
      status: "code_ready" as const,
      userCode: "ABCD-1234",
      verificationUri: "https://auth.example.com/device",
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    }));
    const startInfisicalAuth = vi.fn(async () => ({
      id: "ginff_1",
      status: "link_ready" as const,
      loginUrl: "https://app.infisical.com/login?flow=1",
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    }));
    const buckets: string[] = [];
    const rateLimiter: ApiRateLimiter = {
      consume: async ({ bucket, limit }) => {
        buckets.push(`${bucket}:${limit}`);
        return { allowed: true };
      },
    };
    const app = testApp(fakeRepository(), {
      engineAuth: engineAuthService({ startCodexDeviceAuth, startInfisicalAuth }),
      rateLimiter,
    });

    const codexStarted = await app.request("/v1/engine-auth/codex/device", { method: "POST" });
    expect(codexStarted.status).toBe(201);
    await expect(codexStarted.json()).resolves.toMatchObject({
      data: { flow: { id: "gcodf_1", status: "code_ready", userCode: "ABCD-1234" } },
    });
    expect(startCodexDeviceAuth).toHaveBeenCalledWith(actor);

    const infisicalStarted = await app.request("/v1/engine-auth/infisical/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "https://app.infisical.com" }),
    });
    expect(infisicalStarted.status).toBe(201);
    await expect(infisicalStarted.json()).resolves.toMatchObject({
      data: { flow: { id: "ginff_1", status: "link_ready" } },
    });
    expect(startInfisicalAuth).toHaveBeenCalledWith(actor, "https://app.infisical.com");
    expect(buckets).toEqual(["engine-auth-start:10", "engine-auth-start:10"]);
  });

  it("polls Codex device flows through the static-before-param route", async () => {
    const pollCodexDeviceAuth = vi.fn(async () => ({
      id: "gcodf_1",
      status: "completed" as const,
      userCode: null,
      verificationUri: null,
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    }));
    const app = testApp(fakeRepository(), {
      engineAuth: engineAuthService({ pollCodexDeviceAuth }),
    });
    const polled = await app.request("/v1/engine-auth/codex/device/gcodf_1/poll", {
      method: "POST",
    });
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({
      data: { flow: { id: "gcodf_1", status: "completed" } },
    });
    expect(pollCodexDeviceAuth).toHaveBeenCalledWith(actor, "gcodf_1");
  });

  it("maps the Infisical admin gate to a structured forbidden error", async () => {
    const app = testApp(fakeRepository(), {
      engineAuth: engineAuthService({
        startInfisicalAuth: async () => {
          throw new ApiError(403, "forbidden", "Only workspace admins can manage Infisical.");
        },
      }),
    });
    const response = await app.request("/v1/engine-auth/infisical/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "https://app.infisical.com" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "forbidden", message: "Only workspace admins can manage Infisical." },
    });
  });

  it("completes Infisical flows without echoing the browser token and pins the 64 KiB cap", async () => {
    const browserToken = `infisical-browser-token-${"a".repeat(64)}`;
    const completeInfisicalAuth = vi.fn(async () => ({
      id: "ginff_1",
      status: "completed" as const,
      loginUrl: null,
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    }));
    const app = testApp(fakeRepository(), {
      engineAuth: engineAuthService({ completeInfisicalAuth }),
    });

    const completed = await app.request("/v1/engine-auth/infisical/ginff_1/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserToken }),
    });
    expect(completed.status).toBe(200);
    const completedBody = await completed.json();
    expect(JSON.stringify(completedBody)).not.toContain(browserToken);
    expect(completedBody).toMatchObject({ data: { flow: { status: "completed" } } });
    expect(completeInfisicalAuth).toHaveBeenCalledWith(actor, "ginff_1", browserToken);

    // The retired action capped browser tokens at 64 KiB; the protocol keeps
    // the same ceiling, so oversized tokens never reach the service.
    const oversized = await app.request("/v1/engine-auth/infisical/ginff_1/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserToken: "b".repeat(64 * 1024 + 1) }),
    });
    expect(oversized.status).toBe(400);
    // Boot the real Node server adapter ourselves so this pin is
    // self-contained: serve() patches global Response, and errorResponse must
    // keep producing envelopes that survive the patched class (the
    // Response.json regression this guards returned raw zod bodies in
    // production). Closing immediately is fine — the patch is the side effect
    // under test.
    const envelopeServer = serve({ fetch: app.fetch, port: 0 });
    envelopeServer.close();
    const patchedOversized = await app.request("/v1/engine-auth/infisical/ginff_1/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserToken: "b".repeat(64 * 1024 + 1) }),
    });
    await expect(patchedOversized.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(completeInfisicalAuth).toHaveBeenCalledTimes(1);
  });

  it("serves authorized billing read models without internal ledger or Stripe objects", async () => {
    const getOverview = vi.fn(async () => ({
      creditBalanceUsdMicros: 3_000_000,
      includedBalanceUsdMicros: 1_000_000,
      topUpBalanceUsdMicros: 2_000_000,
      plan: "pro" as const,
      subscriptionStatus: "active",
      seatQuantity: 2,
      includedUsagePeriodEnd: "2026-09-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      paymentNeedsAttention: false,
      proMonthlyPriceCents: 2_000,
      hobbyIncludedUsageCents: 100,
      memberCount: 2,
      memberCap: 10,
      spendThisMonthUsdMicros: 500_000,
      spendThisMonthByCategory: { chat: 500_000, ingestion: 0, capabilities: 0 },
      recentActivity: [
        {
          activityId: "billing_activity_safe",
          source: "chat_model_usage",
          amountUsdMicros: -500_000,
          providerCostUsdMicros: 500_000,
          platformFeeUsdMicros: 0,
          capabilityAction: null,
          isAutoRefill: false,
          createdAt: "2026-08-13T12:00:00.000Z",
        },
      ],
      lowBalanceWarnUsdMicros: 1_000_000,
      includedUsagePerSeatCents: 2_000,
      topUpAmountsCents: [1_000],
      defaultTopUpCents: 1_000,
      minTopUpCents: 500,
      maxTopUpCents: 50_000,
      autoRefillMonthlyMaxCents: 50_000,
      autoRefill: {
        enabled: true,
        amountCents: 1_000,
        hasPaymentMethod: true,
        lastError: null,
      },
      isAdmin: true,
    }));
    const app = testApp(fakeRepository(), {
      billing: { ...fakeBilling(), getOverview },
    });

    const response = await app.request("/v1/billing");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.data).toMatchObject({
      plan: "pro",
      creditBalanceUsdMicros: 3_000_000,
      recentActivity: [{ activityId: "billing_activity_safe" }],
    });
    expect(JSON.stringify(body)).not.toMatch(/stripeCustomerId|paymentMethodId|ledgerId/u);
    expect(getOverview).toHaveBeenCalledWith(actor);
  });

  it("reports unexpected request failures with correlation context", async () => {
    const failure = new Error("database pool is closed");
    const captureException = vi.fn();
    setExceptionReporter({ captureException });
    try {
      const app = testApp(fakeRepository(), {
        authenticate: async () => {
          throw failure;
        },
      });

      const response = await app.request("/v1/billing/balance");

      expect(response.status).toBe(500);
      expect(captureException).toHaveBeenCalledWith(
        failure,
        expect.objectContaining({
          event: "opencompany.api_request_failed",
          method: "GET",
          path: "/v1/billing/balance",
          request_id: expect.stringMatching(/^request_/u),
        }),
      );
    } finally {
      setExceptionReporter(undefined);
    }
  });

  it("correlates Message command failures with the actor and target without logging content", async () => {
    const failure = new Error("Failed query", {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "tasks_pkey",
      }),
    });
    const repository = fakeRepository();
    repository.createMessageAndRun = async () => {
      throw failure;
    };
    const captureException = vi.fn();
    setExceptionReporter({ captureException });
    try {
      const app = testApp(repository);
      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: messageHeaders("message-failure-1"),
        body: JSON.stringify({
          conversationId: "conversation_1",
          content: "private prompt that must not enter telemetry",
          engine: { type: "opencompany", schemaVersion: 1 },
        }),
      });

      expect(response.status).toBe(500);
      expect(captureException).toHaveBeenCalledWith(
        failure,
        expect.objectContaining({
          event: "opencompany.api_request_failed",
          method: "POST",
          path: "/v1/messages",
          operation: "message.create",
          message_target: "existing",
          target_resource: "chat",
          engine: "opencompany",
          conversation_id: "conversation_1",
          user_id: "user_1",
          workspace_id: "workspace_1",
          request_id: expect.stringMatching(/^request_/u),
        }),
      );
      expect(JSON.stringify(captureException.mock.calls)).not.toContain(
        "private prompt that must not enter telemetry",
      );
    } finally {
      setExceptionReporter(undefined);
    }
  });

  it("forwards the required idempotency key to billing commands", async () => {
    const createCreditTopUp = vi.fn(async () => ({
      redirectUrl: "https://checkout.stripe.test/session",
    }));
    const app = testApp(fakeRepository(), {
      billing: { ...fakeBilling(), createCreditTopUp },
    });
    const response = await app.request("/v1/billing/top-ups", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "billing-command-1" },
      body: JSON.stringify({ amountCents: 1_000 }),
    });

    expect(response.status).toBe(201);
    expect(createCreditTopUp).toHaveBeenCalledWith(actor, {
      amountCents: 1_000,
      idempotencyKey: "billing-command-1",
    });
    const missingKey = await app.request("/v1/billing/top-ups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: 1_000 }),
    });
    expect(missingKey.status).toBe(400);
    expect(createCreditTopUp).toHaveBeenCalledTimes(1);
  });

  it("routes capabilities and Brain controls through their authorized services", async () => {
    const getSettings = vi.fn(async () => ({
      capabilities: [{ source: "x" as const, enabled: true }],
      sessionBudgetUsdMicros: 5_000_000,
    }));
    const setCapability = vi.fn(async () => ({ source: "x" as const, enabled: false }));
    const getApproval = vi.fn(async () => ({
      runId: "gcr_1",
      source: "lead" as const,
      action: "lead.find_person_email",
      status: "awaiting_approval" as const,
      maxCostUsdMicros: 360_000,
      expiresAt: new Date("2026-08-13T16:00:00.000Z"),
      settledCostUsdMicros: null,
    }));
    const createBrain = vi.fn(async () => ({ brainId: "brain_new" }));
    const getAccess = vi.fn(async () => ({
      visibility: "restricted" as const,
      memberIds: ["user_1"],
      workspaceMembers: [],
    }));
    const app = testApp(fakeRepository(), {
      workspaceCapabilities: {
        ...fakeWorkspaceCapabilities(),
        getSettings,
        setCapability,
        getApproval,
      },
      brainControl: { ...fakeBrainControl(), createBrain, getAccess },
    });

    const settings = await app.request("/v1/capabilities");
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({
      data: { capabilities: [{ source: "x", enabled: true }] },
    });

    const toggled = await app.request("/v1/capabilities/x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggled.status).toBe(200);
    expect(setCapability).toHaveBeenCalledWith(actor, "x", false);

    const approval = await app.request("/v1/capability-approvals/gcr_1");
    expect(approval.status).toBe(200);
    await expect(approval.json()).resolves.toMatchObject({
      data: { expiresAt: "2026-08-13T16:00:00.000Z" },
    });

    const created = await app.request("/v1/brains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Research", visibility: "workspace" }),
    });
    expect(created.status).toBe(201);
    expect(createBrain).toHaveBeenCalledWith(actor, {
      name: "Research",
      visibility: "workspace",
    });

    const access = await app.request("/v1/brains/brain_new/access");
    expect(access.status).toBe(200);
    expect(getAccess).toHaveBeenCalledWith(actor, "brain_new");
  });

  it("routes workspace settings, membership, provisioning, and switch commands", async () => {
    const getSettings = vi.fn(async () => ({
      workspace: { id: "goat_ws_current", name: "Current Organization" },
      role: "admin" as const,
      plan: "pro" as const,
      memberCap: 10,
      members: [],
      invitations: [],
    }));
    const invite = vi.fn(async () => undefined);
    const removeMember = vi.fn(async () => undefined);
    const rename = vi.fn(async () => ({ id: "goat_ws_current", name: "Renamed" }));
    const create = vi.fn(async () => ({
      workspaceId: "goat_ws_new",
      organizationId: "org_new",
      brainId: "brain_new",
    }));
    const switchWorkspace = vi.fn(async () => ({
      workspaceId: "goat_ws_next",
      organizationId: "org_next",
      brainId: null,
    }));
    const app = testApp(fakeRepository(), {
      workspaceControl: {
        ...fakeWorkspaceControl(),
        getSettings,
        invite,
        removeMember,
        rename,
        create,
        switch: switchWorkspace,
      },
    });

    const settings = await app.request("/v1/workspace");
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({
      data: { workspace: { id: "goat_ws_current" }, plan: "pro" },
    });

    const invited = await app.request("/v1/workspace/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com" }),
    });
    expect(invited.status).toBe(201);
    expect(invite).toHaveBeenCalledWith(actor, "teammate@example.com");

    const removed = await app.request("/v1/workspace/members/user_2", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(actor, "user_2");

    const renamed = await app.request("/v1/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(renamed.status).toBe(200);
    expect(rename).toHaveBeenCalledWith(actor, "Renamed");

    const created = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "goat_ws_new", name: "New Workspace" }),
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith(actor, {
      workspaceId: "goat_ws_new",
      name: "New Workspace",
    });

    const switched = await app.request("/v1/workspaces/goat_ws_next/switch", { method: "POST" });
    expect(switched.status).toBe(200);
    expect(switchWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ userId: actor.userId, credentialKind: "browser_cookie" }),
      "goat_ws_next",
    );
  });

  it("routes identity reads and synchronization through the pre-onboarding identity tier", async () => {
    const identity = {
      userId: "user_mid_onboarding",
      organizationId: null,
      activeWorkspaceId: null,
      activeBrainId: null,
      method: "session" as const,
      credentialKind: "browser_cookie" as const,
    };
    const authenticate = vi.fn(async () => {
      throw new Error("The actor tier must not run for identity.");
    });
    const identify = vi.fn(async () => identity);
    const service = fakeIdentity();
    const get = vi.spyOn(service, "get");
    const sync = vi.spyOn(service, "sync");
    const app = testApp(fakeRepository(), { authenticate, identify, identity: service });

    expect((await app.request("/v1/identity")).status).toBe(200);
    expect((await app.request("/v1/identity/sync", { method: "POST" })).status).toBe(200);
    expect(get).toHaveBeenCalledWith(identity);
    expect(sync).toHaveBeenCalledWith(identity);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("routes workspace switching through verified identity and rate-limits by WorkOS user", async () => {
    const workspaceId = "workspace_next";
    const identity = {
      userId: "user_mobile",
      organizationId: null,
      activeWorkspaceId: null,
      activeBrainId: null,
      method: "session" as const,
      credentialKind: "authkit_bearer" as const,
    };
    const authenticate = vi.fn(async () => {
      throw new Error("The actor tier must not run for workspace switching.");
    });
    const identify = vi.fn(async () => identity);
    const switchWorkspace = vi.fn(async () => ({
      workspaceId,
      organizationId: "org_next",
      brainId: "brain_general",
    }));
    const consume = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const app = testApp(fakeRepository(), {
      authenticate,
      identify,
      rateLimiter: { consume } as ApiRateLimiter,
      workspaceControl: { ...fakeWorkspaceControl(), switch: switchWorkspace },
    });

    const response = await app.request(`/v1/workspaces/${workspaceId}/switch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${compactJwt({ client_id: "client_mobile" })}` },
    });

    expect(response.status).toBe(200);
    expect(switchWorkspace).toHaveBeenCalledWith(identity, workspaceId);
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "user_mobile",
        bucket: "workspace-switch",
        limit: 60,
      }),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("routes onboarding through verified identity without the onboarded actor gate", async () => {
    const identity = {
      userId: "user_mid_onboarding",
      organizationId: null,
      activeWorkspaceId: null,
      activeBrainId: null,
      method: "session" as const,
      credentialKind: "browser_cookie" as const,
      refreshedSessionCookie: "wos-session=refreshed; Path=/; HttpOnly",
    };
    const authenticate = vi.fn(async () => {
      throw new Error("The actor tier must not run for onboarding.");
    });
    const identify = vi.fn(async () => identity);
    const getState = vi.fn(async () => ({
      onboarding: null,
      workspace: null,
      activeBrainId: null,
    }));
    const checkSlug = vi.fn(async () => ({ slug: "analytical-co", available: true }));
    const saveProfile = vi.fn(async () => undefined);
    const saveWorkspace = vi.fn(async () => ({
      workspaceId: "goat_ws_new",
      organizationId: "org_new",
      brainId: "brain_general",
      createdByCaller: true,
    }));
    const finish = vi.fn(async () => undefined);
    const app = testApp(fakeRepository(), {
      authenticate,
      identify,
      onboarding: { getState, checkSlug, saveProfile, saveWorkspace, finish },
    });

    const state = await app.request("/v1/onboarding");
    expect(state.status).toBe(200);
    expect(state.headers.get("set-cookie")).toContain("wos-session=refreshed");
    expect(getState).toHaveBeenCalledWith(identity);

    const checked = await app.request("/v1/onboarding/workspace-slug/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "analytical-co" }),
    });
    expect(checked.status).toBe(200);
    expect(checkSlug).toHaveBeenCalledWith(identity, "analytical-co");

    const profile = await app.request("/v1/onboarding/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "founder", companyUrl: "https://opencompany.ai/" }),
    });
    expect(profile.status).toBe(200);
    expect(saveProfile).toHaveBeenCalledWith(identity, {
      role: "founder",
      companyUrl: "https://opencompany.ai/",
    });

    const workspace = await app.request("/v1/onboarding/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "goat_ws_00000000-0000-4000-8000-000000000123",
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    });
    expect(workspace.status).toBe(200);
    expect(saveWorkspace).toHaveBeenCalledWith(identity, {
      workspaceId: "goat_ws_00000000-0000-4000-8000-000000000123",
      name: "Analytical Co",
      slug: "analytical-co",
    });

    const completed = await app.request("/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referralSource: "friend" }),
    });
    expect(completed.status).toBe(200);
    expect(finish).toHaveBeenCalledWith(identity, "friend");
    expect(identify).toHaveBeenCalledTimes(5);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("protects internal onboarding-email persistence with the shared cron secret", async () => {
    const enroll = vi.fn(async () => undefined);
    const claimDue = vi.fn(async () => [
      {
        id: "goem_1",
        workosUserId: "user_1",
        step: "welcome" as const,
        attempts: 1,
        email: "owner@example.com",
        firstName: "Owner",
        terminalOnFailure: false,
      },
    ]);
    const settle = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(async () => 2);
    const app = testApp(fakeRepository(), {
      onboardingEmails: { enroll, claimDue, settle, unsubscribe },
      emailLifecycleInternalSecret: "cron-secret",
    });

    const unauthorized = await app.request("/internal/onboarding-emails/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 4 }),
    });
    expect(unauthorized.status).toBe(401);
    expect(claimDue).not.toHaveBeenCalled();

    const headers = {
      Authorization: "Bearer cron-secret",
      "Content-Type": "application/json",
    };
    const enrolled = await app.request("/internal/onboarding-emails/enroll", {
      method: "POST",
      headers,
      body: JSON.stringify({ workosUserId: "user_1" }),
    });
    expect(enrolled.status).toBe(200);
    expect(enroll).toHaveBeenCalledWith("user_1");

    const claimed = await app.request("/internal/onboarding-emails/claim", {
      method: "POST",
      headers,
      body: JSON.stringify({ limit: 4, workosUserId: "user_1" }),
    });
    expect(claimed.status).toBe(200);
    expect(claimDue).toHaveBeenCalledWith(4, "user_1");

    const settled = await app.request("/internal/onboarding-emails/settle", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "goem_1", outcome: "sent" }),
    });
    expect(settled.status).toBe(200);
    expect(settle).toHaveBeenCalledWith({ id: "goem_1", outcome: "sent" });

    const unsubscribed = await app.request("/internal/onboarding-emails/unsubscribe", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "OWNER@EXAMPLE.COM" }),
    });
    expect(unsubscribed.status).toBe(200);
    expect(unsubscribe).toHaveBeenCalledWith("owner@example.com");
  });
});

describe("POST /internal/wiki/commands", () => {
  const secret = "internal-wiki-secret-value";
  const body = (command: unknown) =>
    JSON.stringify({ userWorkosId: "user_1", workspaceId: "workspace_1", command });
  const headers = (overrides: Record<string, string> = {}) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
    "Idempotency-Key": "agent-wiki:turn_1:call_1",
    ...overrides,
  });

  it("returns 503 when the internal secret is not configured", async () => {
    const app = testApp(fakeRepository());
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: headers(),
      body: body({ command: "tree" }),
    });
    expect(response.status).toBe(503);
  });

  it("returns 401 for a wrong bearer token", async () => {
    const app = testApp(fakeRepository(), { wikiCommandsInternalSecret: secret });
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: headers({ Authorization: "Bearer nope" }),
      body: body({ command: "tree" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const app = testApp(fakeRepository(), { wikiCommandsInternalSecret: secret });
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: body({ command: "tree" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for a malformed command", async () => {
    const app = testApp(fakeRepository(), { wikiCommandsInternalSecret: secret });
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: headers(),
      body: body({ command: "bogus" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 403 when the actor cannot be reconstructed", async () => {
    const app = testApp(fakeRepository(), {
      wikiCommandsInternalSecret: secret,
      resolveWikiServiceActor: async () => {
        throw new ApiError(403, "forbidden", "The user cannot access the wiki in this workspace.");
      },
    });
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: headers(),
      body: body({ command: "tree" }),
    });
    expect(response.status).toBe(403);
  });

  it("reconstructs the actor server-side and returns the tool output", async () => {
    const resolveWikiServiceActor = vi.fn(async () => actor);
    const writePage = vi.fn(async (input: { path: string }) => ({
      action: "created" as const,
      path: input.path,
      slug: "plan",
      title: "Plan",
      createdAncestors: [] as string[],
    }));
    const app = testApp(fakeRepository(), {
      wikiCommandsInternalSecret: secret,
      resolveWikiServiceActor,
      wikiCommands: fakeWikiCommandsService({ writePage }),
    });
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: headers(),
      body: body({
        command: "write",
        path: "projects/plan",
        body: "# Plan",
        kind: "other",
        title: "",
        pages: "",
        query: "",
        since: "",
        to: "",
        at: "",
        text: "",
        depth: 0,
        limit: 100,
        offset: 0,
        recursive: false,
        ignoreCase: true,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { ok: true, result: { action: "created", path: "projects/plan", slug: "plan" } },
    });
    // Tenancy comes from the request but the actor is reloaded, never trusted.
    expect(resolveWikiServiceActor).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    expect(writePage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        actorWorkosId: "user_1",
        idempotencyKey: "agent-wiki:turn_1:call_1",
        path: "projects/plan",
        body: "# Plan",
      }),
    );
  });

  it("applies a command-aware write rate limit", async () => {
    const consume = vi.fn(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    const app = testApp(fakeRepository(), {
      wikiCommandsInternalSecret: secret,
      rateLimiter: { consume } as unknown as ApiRateLimiter,
    });
    const response = await app.request("/internal/wiki/commands", {
      method: "POST",
      headers: headers(),
      body: body({ command: "write", path: "projects/plan", body: "# Plan" }),
    });
    expect(response.status).toBe(429);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ bucket: "wiki_write" }));
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
    wikiCommands: fakeWikiCommandsService(),
    resolveWikiServiceActor: async () => actor,
    wikiSources: fakeWikiSources(),
    brainSources: fakeBrainSources(),
    brainImports: fakeBrainImports(),
    wikiImports: fakeWikiImports(),
    browserProfiles: fakeBrowserProfiles(),
    skillImports: fakeSkillImportService(),
    pluginImports: fakePluginImportService(),
    brainAssets: fakeBrainAssets(),
    brainControl: fakeBrainControl(),
    attachments: fakeAttachments(),
    userSettings: fakeUserSettings(),
    feedback: fakeFeedback(),
    repoConfigs: fakeRepoConfigs(),
    integrationAccounts: fakeIntegrationAccounts(),
    slackBotSettings: fakeSlackBotSettings(),
    engineAuth: fakeEngineAuth(),
    engineSessions: fakeEngineSessions(),
    billing: fakeBilling(),
    workspaceCapabilities: fakeWorkspaceCapabilities(),
    workspaceControl: fakeWorkspaceControl(),
    identity: fakeIdentity(),
    onboarding: fakeOnboarding(),
    onboardingEmails: fakeOnboardingEmails(),
    authenticate: async () => ({ actor }),
    identify: async () => ({
      userId: actor.userId,
      organizationId: null,
      activeWorkspaceId: actor.workspaceId,
      activeBrainId: null,
      method: actor.authenticationMethod,
      credentialKind: "browser_cookie" as const,
    }),
    defaultModel: "provider/default",
    ...overrides,
  });
}

async function responseBody(response: Response | Promise<Response>) {
  return (await response).text();
}

function compactJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
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

function fakeBrainControl(): Parameters<typeof createApiApp>[0]["brainControl"] {
  return {
    switchBrain: async () => {
      throw new Error("Unexpected Brain switch.");
    },
    createBrain: async () => {
      throw new Error("Unexpected Brain creation.");
    },
    getAccess: async () => {
      throw new Error("Unexpected Brain access read.");
    },
    setAccess: async () => {
      throw new Error("Unexpected Brain access mutation.");
    },
    getEnrichment: async () => {
      throw new Error("Unexpected Brain enrichment read.");
    },
    setEnrichment: async () => {
      throw new Error("Unexpected Brain enrichment mutation.");
    },
    getIntelligence: async () => {
      throw new Error("Unexpected Brain intelligence read.");
    },
    setIntelligence: async () => {
      throw new Error("Unexpected Brain intelligence mutation.");
    },
  };
}

function fakeWorkspaceCapabilities(): Parameters<typeof createApiApp>[0]["workspaceCapabilities"] {
  return {
    getSettings: async () => {
      throw new Error("Unexpected workspace capability settings read.");
    },
    setCapability: async () => {
      throw new Error("Unexpected workspace capability mutation.");
    },
    setSessionBudget: async () => {
      throw new Error("Unexpected workspace capability budget mutation.");
    },
    getApproval: async () => {
      throw new Error("Unexpected capability approval read.");
    },
    getApprovalByToolCall: async () => {
      throw new Error("Unexpected tool-call capability approval read.");
    },
  };
}

function fakeWorkspaceControl(): Parameters<typeof createApiApp>[0]["workspaceControl"] {
  return {
    getSettings: async () => {
      throw new Error("Unexpected workspace settings read.");
    },
    invite: async () => {
      throw new Error("Unexpected workspace invitation.");
    },
    revokeInvitation: async () => {
      throw new Error("Unexpected workspace invitation revoke.");
    },
    removeMember: async () => {
      throw new Error("Unexpected workspace member removal.");
    },
    rename: async () => {
      throw new Error("Unexpected workspace rename.");
    },
    create: async () => {
      throw new Error("Unexpected workspace creation.");
    },
    switch: async () => {
      throw new Error("Unexpected workspace switch.");
    },
  };
}

function fakeIdentity(): Parameters<typeof createApiApp>[0]["identity"] {
  const data = {
    user: {
      id: actor.userId,
      email: "owner@example.com",
      firstName: "Owner",
      lastName: null,
      avatarUrl: null,
      timezone: "UTC",
      taskSpawningEnabled: true,
      autoModelRoutingEnabled: false,
      chatCapabilitiesBetaEnabled: false,
      imessageEnabled: false,
      taskViewMode: "board" as const,
      preferredMcpClient: null,
      mcpSetupCompletedAt: null,
      onboardedAt: "2026-08-13T12:00:00.000Z",
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
    workspaces: [
      {
        id: actor.workspaceId,
        name: "Workspace",
        slug: "workspace",
        role: "admin" as const,
        legacyBrainEnabled: true,
      },
    ],
    activeWorkspaceId: actor.workspaceId,
    brains: [],
    activeBrainId: null,
  };
  return {
    get: async () => data,
    sync: async () => data,
  };
}

function fakeOnboarding(): Parameters<typeof createApiApp>[0]["onboarding"] {
  return {
    getState: async () => {
      throw new Error("Unexpected onboarding state read.");
    },
    checkSlug: async () => {
      throw new Error("Unexpected onboarding slug check.");
    },
    saveProfile: async () => {
      throw new Error("Unexpected onboarding profile mutation.");
    },
    saveWorkspace: async () => {
      throw new Error("Unexpected onboarding workspace mutation.");
    },
    finish: async () => {
      throw new Error("Unexpected onboarding completion.");
    },
  };
}

function fakeOnboardingEmails(): Parameters<typeof createApiApp>[0]["onboardingEmails"] {
  return {
    enroll: async () => {
      throw new Error("Unexpected onboarding email enrollment.");
    },
    claimDue: async () => {
      throw new Error("Unexpected onboarding email claim.");
    },
    settle: async () => {
      throw new Error("Unexpected onboarding email settlement.");
    },
    unsubscribe: async () => {
      throw new Error("Unexpected onboarding email unsubscribe.");
    },
  };
}

function fakeBrainImports(): Parameters<typeof createApiApp>[0]["brainImports"] {
  return {
    start: async () => {
      throw new Error("Unexpected Brain import start.");
    },
    confirm: async () => {
      throw new Error("Unexpected Brain import confirmation.");
    },
    cancel: async () => {
      throw new Error("Unexpected Brain import cancellation.");
    },
    retry: async () => {
      throw new Error("Unexpected Brain import retry.");
    },
  };
}

function fakeWikiImports(): Parameters<typeof createApiApp>[0]["wikiImports"] {
  return {
    start: vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "discovering" as const,
      replayed: false,
    })),
    confirm: vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "ingesting" as const,
      replayed: false,
    })),
    cancel: vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "canceled" as const,
      replayed: false,
    })),
    retry: vi.fn(async () => ({
      importRunId: "gbimp_wiki",
      status: "discovering" as const,
      replayed: false,
    })),
  };
}

function brainImportService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["brainImports"]>,
): Parameters<typeof createApiApp>[0]["brainImports"] {
  return { ...fakeBrainImports(), ...overrides };
}

function wikiImportService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["wikiImports"]>,
): Parameters<typeof createApiApp>[0]["wikiImports"] {
  return { ...fakeWikiImports(), ...overrides };
}

function fakeUserSettings(): Parameters<typeof createApiApp>[0]["userSettings"] {
  return {
    updatePreferences: async () => {
      throw new Error("Unexpected preference update.");
    },
    getMcpSetup: async () => {
      throw new Error("Unexpected MCP setup read.");
    },
    setPreferredMcpClient: async () => {
      throw new Error("Unexpected MCP client mutation.");
    },
  };
}

function fakeFeedback(): Parameters<typeof createApiApp>[0]["feedback"] {
  return {
    submit: async () => {
      throw new Error("Unexpected feedback submission.");
    },
  };
}

function fakeBilling(): Parameters<typeof createApiApp>[0]["billing"] {
  return {
    getOverview: async () => {
      throw new Error("Unexpected billing overview read.");
    },
    getUsage: async () => {
      throw new Error("Unexpected billing usage read.");
    },
    getBalance: async () => {
      throw new Error("Unexpected billing balance read.");
    },
    createCreditTopUp: async () => {
      throw new Error("Unexpected billing top-up.");
    },
    createProCheckout: async () => {
      throw new Error("Unexpected billing subscription checkout.");
    },
    createBillingPortal: async () => {
      throw new Error("Unexpected billing portal session.");
    },
    updateAutoRefill: async () => {
      throw new Error("Unexpected billing auto-refill update.");
    },
  };
}

function fakeRepoConfigs(): Parameters<typeof createApiApp>[0]["repoConfigs"] {
  return {
    list: async () => {
      throw new Error("Unexpected repository config list.");
    },
    setEnv: async () => {
      throw new Error("Unexpected repository env mutation.");
    },
    setSetupInstructions: async () => {
      throw new Error("Unexpected repository setup mutation.");
    },
    remove: async () => {
      throw new Error("Unexpected repository config removal.");
    },
  };
}

function fakeIntegrationAccounts(): Parameters<typeof createApiApp>[0]["integrationAccounts"] {
  return {
    list: async () => {
      throw new Error("Unexpected integration account list.");
    },
    getUsage: async () => {
      throw new Error("Unexpected integration account usage read.");
    },
    disconnect: async () => {
      throw new Error("Unexpected integration account disconnect.");
    },
    setCapabilityMode: async () => {
      throw new Error("Unexpected capability mode mutation.");
    },
    alwaysAllowAction: async () => {
      throw new Error("Unexpected standing permission mutation.");
    },
    connectAttio: async () => {
      throw new Error("Unexpected Attio connect.");
    },
    disconnectAttio: async () => {
      throw new Error("Unexpected Attio disconnect.");
    },
    connectFathom: async () => {
      throw new Error("Unexpected Fathom connect.");
    },
    connectGranola: async () => {
      throw new Error("Unexpected Granola connect.");
    },
    connectRender: async () => {
      throw new Error("Unexpected Render connect.");
    },
    startImessagePairing: async () => {
      throw new Error("Unexpected iMessage pairing start.");
    },
    confirmImessagePairing: async () => {
      throw new Error("Unexpected iMessage pairing confirm.");
    },
    connectStripe: async () => {
      throw new Error("Unexpected Stripe connect.");
    },
    disconnectStripe: async () => {
      throw new Error("Unexpected Stripe disconnect.");
    },
    createOrResetJamieWebhookEndpoint: async () => {
      throw new Error("Unexpected Jamie webhook endpoint mutation.");
    },
    saveJamieWebhookApiKey: async () => {
      throw new Error("Unexpected Jamie API key mutation.");
    },
  };
}

function fakeSlackBotSettings(): Parameters<typeof createApiApp>[0]["slackBotSettings"] {
  return {
    getWorkspaceSettings: async () => {
      throw new Error("Unexpected Slack bot workspace settings read.");
    },
    disconnect: async () => {
      throw new Error("Unexpected Slack bot disconnect.");
    },
    getDestination: async () => {
      throw new Error("Unexpected Slack bot destination read.");
    },
    listChannels: async () => {
      throw new Error("Unexpected Slack bot channel list.");
    },
    setDestination: async () => {
      throw new Error("Unexpected Slack bot destination mutation.");
    },
  };
}

function integrationAccountService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["integrationAccounts"]>,
): Parameters<typeof createApiApp>[0]["integrationAccounts"] {
  return { ...fakeIntegrationAccounts(), ...overrides };
}

function fakeEngineAuth(): Parameters<typeof createApiApp>[0]["engineAuth"] {
  return {
    getClaudeCodeStatus: async () => {
      throw new Error("Unexpected Claude Code status read.");
    },
    saveClaudeCodeToken: async () => {
      throw new Error("Unexpected Claude Code token save.");
    },
    disconnectClaudeCode: async () => {
      throw new Error("Unexpected Claude Code disconnect.");
    },
    getCodexStatus: async () => {
      throw new Error("Unexpected Codex status read.");
    },
    setCodexWorkspaceEngine: async () => {
      throw new Error("Unexpected Codex workspace engine mutation.");
    },
    startCodexDeviceAuth: async () => {
      throw new Error("Unexpected Codex device auth start.");
    },
    pollCodexDeviceAuth: async () => {
      throw new Error("Unexpected Codex device auth poll.");
    },
    disconnectCodex: async () => {
      throw new Error("Unexpected Codex disconnect.");
    },
    getInfisicalStatus: async () => {
      throw new Error("Unexpected Infisical status read.");
    },
    startInfisicalAuth: async () => {
      throw new Error("Unexpected Infisical auth start.");
    },
    completeInfisicalAuth: async () => {
      throw new Error("Unexpected Infisical auth completion.");
    },
    disconnectInfisical: async () => {
      throw new Error("Unexpected Infisical disconnect.");
    },
  };
}

function engineAuthService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["engineAuth"]>,
): Parameters<typeof createApiApp>[0]["engineAuth"] {
  return { ...fakeEngineAuth(), ...overrides };
}

function fakeEngineSessions(): Parameters<typeof createApiApp>[0]["engineSessions"] {
  return {
    getRuntimeStatus: async () => {
      throw new Error("Unexpected engine runtime status read.");
    },
    createRuntimeAccess: async () => {
      throw new Error("Unexpected engine runtime access mutation.");
    },
  };
}

function engineSessionService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["engineSessions"]>,
): Parameters<typeof createApiApp>[0]["engineSessions"] {
  return { ...fakeEngineSessions(), ...overrides };
}

function fakeWikiSources(): Parameters<typeof createApiApp>[0]["wikiSources"] {
  return {
    list: async () => {
      throw new Error("Unexpected Wiki source list.");
    },
    listActivity: async () => {
      throw new Error("Unexpected Wiki activity list.");
    },
    upsert: async () => {
      throw new Error("Unexpected Wiki source mutation.");
    },
    setEnabled: async () => {
      throw new Error("Unexpected Wiki source enabled mutation.");
    },
    remove: async () => {
      throw new Error("Unexpected Wiki source removal.");
    },
  };
}

function wikiSourceService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["wikiSources"]>,
): Parameters<typeof createApiApp>[0]["wikiSources"] {
  return { ...fakeWikiSources(), ...overrides };
}

function wikiActivityItem() {
  return {
    id: "gwjob_1",
    provider: "gmail" as const,
    sourceType: "thread" as const,
    title: "Launch update",
    outcome: "succeeded" as const,
    reason: null,
    pages: [{ path: "projects/launch", title: "Launch", action: "updated" as const }],
    attempts: 1,
    occurredAt: "2026-08-24T08:00:00.000Z",
    completedAt: "2026-08-24T09:01:00.000Z",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:01:00.000Z",
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

function fakeBrowserProfiles(): Parameters<typeof createApiApp>[0]["browserProfiles"] {
  return {
    list: async () => {
      throw new Error("Unexpected browser profile list.");
    },
    create: async () => {
      throw new Error("Unexpected browser profile creation.");
    },
    remove: async () => {
      throw new Error("Unexpected browser profile removal.");
    },
    createLoginSession: async () => {
      throw new Error("Unexpected browser profile login session.");
    },
    completeLoginSession: async () => {
      throw new Error("Unexpected browser profile login completion.");
    },
    resolveLiveViewUrl: async () => {
      throw new Error("Unexpected browser profile live view.");
    },
  };
}

function browserProfileService(
  overrides: Partial<Parameters<typeof createApiApp>[0]["browserProfiles"]>,
): Parameters<typeof createApiApp>[0]["browserProfiles"] {
  return { ...fakeBrowserProfiles(), ...overrides };
}

function wikiSourceView(overrides: Record<string, unknown> = {}) {
  return {
    id: "gwscfg_1",
    provider: "gmail" as const,
    integrationId: "integration_1",
    enabled: true,
    config: {},
    integrationStatus: "connected" as const,
    accountName: null,
    accountEmail: "ada@example.com",
    connectionLabel: null,
    ownerName: "Ada Lovelace",
    ownerEmail: "ada@example.com",
    ownerAvatarUrl: null,
    ownerKind: "user" as const,
    isOwn: true,
    canConfigure: true,
    canToggle: true,
    canDelete: true,
    ...overrides,
  };
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

function chatResourceService(overrides: Partial<ChatResourceService>): ChatResourceService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected Chat resource operation.");
  };
  return {
    findShare: unexpected,
    ensureShare: unexpected,
    revokeShare: unexpected,
    loadPublicShare: unexpected,
    loadPublicShareMetadata: unexpected,
    deleteArtifact: unexpected,
    downloadArtifact: unexpected,
    downloadAttachment: unexpected,
    downloadScreenshot: unexpected,
    downloadPublicAttachment: unexpected,
    downloadPublicArtifact: unexpected,
    ...overrides,
  };
}

function fakeKnowledgeService() {
  return knowledgeService({});
}

function fakeWikiCommandRepository(
  overrides: Partial<WikiCommandRepository> = {},
): WikiCommandRepository {
  const reject = async () => {
    throw new Error("Unexpected wiki command repository call.");
  };
  return {
    getTree: async () => [],
    resolvePages: async () => ({ pages: [], missing: [] }),
    getBacklinks: async () => [],
    grep: async () => [],
    search: async () => [],
    recentChanges: async () => [],
    listTimeline: async () => [],
    createFolder: reject,
    writePage: reject,
    moveNode: reject,
    deletePage: reject,
    addTimelineEntry: reject,
    ...overrides,
  };
}

function fakeWikiCommandsService(overrides: Partial<WikiCommandRepository> = {}) {
  return new WikiCommandApplicationService(fakeWikiCommandRepository(overrides));
}

function fakeSkillImportService(
  repositoryOverrides: Partial<SkillBundleRepository> = {},
  resolverOverrides: Partial<SkillImportResolver> = {},
  authorOverrides: Partial<SkillBundleAuthor> = {},
) {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected Skill installation operation.");
  };
  const repository: SkillBundleRepository = {
    install: unexpected,
    replace: unexpected,
    list: unexpected,
    listCatalog: unexpected,
    get: unexpected,
    readFile: unexpected,
    setEnabled: unexpected,
    archive: unexpected,
    ...repositoryOverrides,
  };
  const resolver: SkillImportResolver = {
    resolve: async () => {
      throw new Error("Unexpected Skill import preview.");
    },
    ...resolverOverrides,
  };
  const author: SkillBundleAuthor = {
    create: async () => {
      throw new Error("Unexpected workspace Skill authoring operation.");
    },
    ...authorOverrides,
  };
  return new SkillImportApplicationService(repository, resolver, author);
}

function fakePluginImportService(
  repositoryOverrides: Partial<PluginRepository> = {},
  resolverOverrides: Partial<PluginImportResolver> = {},
  gatewayLifecycle?: PluginGatewayLifecycle,
) {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected Plugin installation operation.");
  };
  const repository: PluginRepository = {
    install: unexpected,
    list: unexpected,
    get: unexpected,
    setStatus: unexpected,
    approveMcp: unexpected,
    revokeMcp: unexpected,
    archive: unexpected,
    deleteData: unexpected,
    ...repositoryOverrides,
  };
  const resolver: PluginImportResolver = {
    resolve: async () => {
      throw new Error("Unexpected Plugin import preview.");
    },
    ...resolverOverrides,
  };
  return new PluginImportApplicationService(repository, resolver, gatewayLifecycle);
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
    nodeType: "page" as const,
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
    nodeType: "page" as const,
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

function fakeSkillInstallation(): SkillInstallation {
  return {
    id: "skill_installation_1",
    name: "imported-skill",
    enabled: true,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
    bundle: {
      id: "skill_bundle_1",
      integrity: `sha256:${"b".repeat(64)}`,
      name: "imported-skill",
      description: "Imported instructions.",
      license: null,
      compatibility: null,
      metadata: null,
      allowedTools: null,
      body: "Use this when imported.",
      source: {
        type: "github",
        url: "https://github.com/o/r",
        ref: "main",
        path: "imported-skill",
        resolvedCommit: "a".repeat(40),
      },
      files: [{ path: "SKILL.md", executable: false, sizeBytes: 128 }],
      createdAt,
    },
  };
}

function fakePluginInstallation(): PluginInstallation {
  return {
    id: "plugin_1",
    name: "quality-tools",
    status: "enabled",
    manifest: { name: "quality-tools", description: "Quality helpers." },
    source: {
      type: "github",
      url: "https://github.com/example/plugins",
      ref: "main",
      path: "",
      resolvedCommit: "a".repeat(40),
    },
    integrity: `sha256:${"c".repeat(64)}`,
    files: [{ path: "plugin.json", executable: false, sizeBytes: 128 }],
    skills: [],
    stdioServers: [
      {
        name: "local",
        type: "stdio",
        command: "./server",
        args: [],
        env: { PRIVATE_TOKEN: "secret-value" },
      },
    ],
    remoteMcpServers: [
      {
        name: "remote",
        type: "streamable-http",
        connectionProvider: "quality-tools",
        capabilities: [
          { id: "read", label: "Read tools", defaultMode: "on", tools: ["list_issues"] },
        ],
        tools: [
          {
            name: "list_issues",
            description: "List issues.",
            classification: {
              capabilityId: "read",
              capabilityLabel: "Read tools",
              defaultMode: "on",
              bucket: "read",
              curated: true,
            },
          },
        ],
        discoveryStatus: "stale",
        discoveredAt: createdAt,
        refreshAfter: createdAt,
        lastDiscoveryError: "Provider discovery timed out.",
      },
    ],
    installReport: {
      ignoredManifestFields: [],
      skills: [],
      mcp: {
        present: true,
        status: "parsed",
        reports: [{ name: "local", status: "selected", transport: "stdio" }],
      },
      collisions: [],
    },
    mcpApprovedIntegrity: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
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
          input.trigger.type === "manual" || input.trigger.type === "event"
            ? input.trigger.type === "event"
              ? {
                  ...input.trigger,
                  prompt: input.trigger.prompt ?? "Review and triage this Linear issue.",
                }
              : { type: "manual" }
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
          messageShapeEpoch: 4,
          runtime: {
            status: "running",
            activeRunId: "run_1",
            hasError: false,
            updatedAt: createdAt,
          },
          activityState: "working",
          hasUnseen: false,
          pinnedAt: null,
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
      messageShapeEpoch: 4,
      runtime: {
        status: "running",
        activeRunId: "run_1",
        hasError: false,
        updatedAt: createdAt,
      },
      activityState: "working",
      hasUnseen: false,
      pinnedAt: null,
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

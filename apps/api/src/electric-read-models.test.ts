import { describe, expect, it, vi } from "vitest";
import { ElectricReadModelProxy } from "./electric-read-models";

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: [
    "chat:read",
    "chat:write",
    "task:read",
    "task:write",
    "workflow:read",
    "workflow:write",
    "schedule:read",
    "schedule:write",
  ],
  authenticationMethod: "session" as const,
};

describe("Electric read models", () => {
  it("selects the physical shape server-side and returns only canonical Message fields", async () => {
    let upstreamUrl = "";
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      upstreamUrl = String(input);
      return Response.json(
        [
          {
            headers: { operation: "insert" },
            key: '"message_1"',
            value: {
              id: "message_1",
              conversation_id: "conversation_1",
              role: "user",
              content: "Review this",
              task_id: null,
              presentation: JSON.stringify({
                schemaVersion: "opencompany.chat.debug.v1",
                uiMessageParts: [{ type: "text", text: "Review this" }],
              }),
              attachments: JSON.stringify([
                {
                  id: "attachment_1",
                  filename: "brief.pdf",
                  mediaType: "application/pdf",
                  sizeBytes: 10,
                  kind: "pdf",
                  blobUrl: "https://private.invalid/brief.pdf",
                  blobPathname: "private/brief.pdf",
                },
              ]),
              created_at: "2026-08-10 20:00:00+00",
              updated_at: "2026-08-10 20:00:01+00",
              actor_id: "must-not-cross",
              workspace_id: "must-not-cross",
            },
            old_value: { actor_id: "must-not-cross", content: "Old" },
          },
          {
            headers: { operation: "update" },
            key: '"message_1"',
            value: {
              id: "message_1",
              content: "Updated review",
              updated_at: "2026-08-10 20:00:02+00",
            },
          },
          {
            headers: { operation: "delete" },
            key: '"message_2"',
            value: { id: "message_2" },
          },
        ],
        {
          headers: {
            connection: "keep-alive",
            "transfer-encoding": "chunked",
            "content-encoding": "zstd",
            "access-control-allow-origin": "*",
            "electric-source-id": "source_1",
            server: "upstream-edge",
            "electric-handle": "shape_1",
            "electric-offset": "0_42",
            "electric-up-to-date": "",
            "electric-schema": JSON.stringify({
              id: { type: "text" },
              conversation_id: { type: "text" },
              presentation: { type: "jsonb" },
              attachments: { type: "jsonb" },
              actor_id: { type: "text" },
              updated_at: { type: "timestamptz" },
            }),
          },
        },
      );
    });
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: fetchMock as typeof fetch,
    });
    const response = await proxy.stream({
      actor,
      readModel: "chat-messages-v1",
      conversationId: "conversation_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/chat-messages-v1?conversationId=conversation_1&table=goat.users&where=true&offset=cursor_1&log=full&expired_handle=old_1&cache-buster=recovery_1",
      ),
    });
    expect(response.status).toBe(200);
    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.message_read_model_v1");
    expect(requestedUrl.searchParams.get("where")).toContain('"actor_id" = $2');
    expect(requestedUrl.searchParams.get("params[2]")).toBe("user_1");
    expect(requestedUrl.searchParams.get("params[3]")).toBe("workspace_1");
    expect(requestedUrl.searchParams.get("offset")).toBe("cursor_1");
    expect(requestedUrl.searchParams.get("log")).toBe("full");
    expect(requestedUrl.searchParams.get("expired_handle")).toBe("old_1");
    expect(requestedUrl.searchParams.get("cache-buster")).toBe("recovery_1");
    expect(requestedUrl.searchParams.get("replica")).toBe("default");
    expect(requestedUrl.searchParams.has("table", "goat.users")).toBe(false);
    expect(response.headers.get("electric-schema")).toBe(
      JSON.stringify({
        id: { type: "text" },
        conversationId: { type: "text" },
        updatedAt: { type: "timestamptz" },
      }),
    );
    expect(response.headers.get("electric-handle")).toBe("shape_1");
    expect(response.headers.get("electric-offset")).toBe("0_42");
    expect(response.headers.has("electric-up-to-date")).toBe(true);
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("electric-source-id")).toBeNull();
    expect(response.headers.get("server")).toBeNull();
    expect(await response.json()).toEqual([
      {
        headers: { operation: "insert" },
        key: '"message_1"',
        value: {
          id: "message_1",
          conversationId: "conversation_1",
          role: "user",
          content: "Review this",
          taskId: null,
          presentation: {
            schemaVersion: "opencompany.chat.debug.v1",
            uiMessageParts: [{ type: "text", text: "Review this" }],
          },
          attachments: [
            {
              id: "attachment_1",
              filename: "brief.pdf",
              mediaType: "application/pdf",
              sizeBytes: 10,
              kind: "pdf",
            },
          ],
          createdAt: "2026-08-10T20:00:00.000Z",
          updatedAt: "2026-08-10T20:00:01.000Z",
        },
      },
      {
        headers: { operation: "update" },
        key: '"message_1"',
        value: {
          id: "message_1",
          content: "Updated review",
          updatedAt: "2026-08-10T20:00:02.000Z",
        },
      },
      {
        headers: { operation: "delete" },
        key: '"message_2"',
        value: { id: "message_2" },
      },
    ]);
  });

  it("requires conversation scope for child read models", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn() as typeof fetch,
    });
    await expect(
      proxy.stream({
        actor,
        readModel: "chat-runs-v1",
        requestUrl: new URL("https://api.example.test/v1/read-models/chat-runs-v1"),
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("fixes Brain shape identity server-side and projects only canonical document fields", async () => {
    let upstreamUrl = "";
    const historicalAlias = "a".repeat(113);
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"document_1"',
            value: {
              id: "document_1",
              brain_id: "project-alpha",
              folder_path: "projects",
              title: null,
              content: "---\nid: project-alpha\n---\n# Alpha",
              body: "# Alpha",
              timeline: "[]",
              format: "markdown",
              mime_type: "text/markdown",
              original_file_name: null,
              asset_size_bytes: null,
              relations: "[]",
              sources: "[]",
              kind: "page",
              entity_type: "project",
              status: "draft",
              aliases: JSON.stringify([historicalAlias]),
              content_hash: "a".repeat(64),
              size_bytes: "7",
              created_by_workos_id: "user_1",
              created_at: "2026-08-12 08:00:00+00",
              updated_at: "2026-08-12 08:01:00+00",
              brain_ref: "must-not-cross",
              asset_storage_key: "private/blob",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "brain-documents-v1",
      brainId: "brain_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/brain-documents-v1?brainId=brain_1&table=goat.users&where=true",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.brain_documents");
    expect(requestedUrl.searchParams.get("where")).toBe('"brain_ref" = $1');
    expect(requestedUrl.searchParams.get("params[1]")).toBe("brain_1");
    expect(requestedUrl.searchParams.get("columns")).not.toContain("asset_storage_key");
    const body = await response.json();
    expect(body).toEqual([
      {
        headers: { operation: "insert" },
        key: '"document_1"',
        value: {
          id: "document_1",
          brainId: "project-alpha",
          folderPath: "projects",
          path: "projects/project-alpha.md",
          title: "project-alpha",
          content: "---\nid: project-alpha\n---\n# Alpha",
          body: "# Alpha",
          timeline: [],
          format: "markdown",
          mimeType: "text/markdown",
          originalFileName: null,
          assetSizeBytes: null,
          relations: [],
          sources: [],
          kind: "page",
          type: "project",
          status: "draft",
          aliases: [historicalAlias],
          contentHash: "a".repeat(64),
          sizeBytes: 7,
          createdByActorId: "user_1",
          createdAt: "2026-08-12T08:00:00.000Z",
          updatedAt: "2026-08-12T08:01:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/brain_ref|asset_storage_key|workspace_id/iu);
  });

  it("projects Brain ingestion activity without worker leases or actor identifiers", async () => {
    let upstreamUrl = "";
    const longError = "x".repeat(2_001);
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"job_1"',
            value: {
              id: "job_1",
              source_item_id: "source_item_1",
              source_provider: "goat-chat",
              kind: "brain_agent_ingest",
              status: "running",
              plan_paused: false,
              attempts: "1",
              last_error: longError,
              result: JSON.stringify({
                summary: "Filing",
                draftBrainId: "project-alpha",
                workerLease: "must-not-cross",
                attemptErrors: ["must-not-cross"],
                trace: {
                  schemaVersion: "goat.brain_ingest_trace.v1",
                  model: "claude-sonnet-4.5",
                  steps: 1,
                  toolCallCount: 0,
                  mutations: 0,
                  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
                  finalText: "Filed",
                  toolCalls: [],
                  truncatedToolCalls: 0,
                  createdAt: "2026-08-12T08:01:00.000Z",
                  providerResponse: "must-not-cross",
                },
              }),
              completed_at: null,
              created_at: "2026-08-12 08:00:00+00",
              updated_at: "2026-08-12 08:01:00+00",
              brain_ref: "must-not-cross",
              user_workos_id: "must-not-cross",
              integration_id: "must-not-cross",
              lease_id: "must-not-cross",
              lease_owner: "must-not-cross",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "brain-ingest-jobs-v1",
      brainId: "brain_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/brain-ingest-jobs-v1?brainId=brain_1&table=goat.users&where=true",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.brain_ingest_jobs");
    expect(requestedUrl.searchParams.get("where")).toBe('"brain_ref" = $1');
    expect(requestedUrl.searchParams.get("columns")).not.toMatch(/lease|user_workos|integration/iu);
    const body = await response.json();
    expect(body).toEqual([
      {
        headers: { operation: "insert" },
        key: '"job_1"',
        value: {
          id: "job_1",
          sourceItemId: "source_item_1",
          sourceProvider: "goat-chat",
          kind: "brain_agent_ingest",
          status: "running",
          planPaused: false,
          attempts: 1,
          lastError: longError.slice(0, 2_000),
          result: {
            summary: "Filing",
            draftBrainId: "project-alpha",
            trace: {
              schemaVersion: "goat.brain_ingest_trace.v1",
              model: "claude-sonnet-4.5",
              steps: 1,
              toolCallCount: 0,
              mutations: 0,
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
                cacheReadInputTokens: null,
                cacheWriteInputTokens: null,
              },
              finalText: "Filed",
              toolCalls: [],
              truncatedToolCalls: 0,
              webSearchCount: 0,
              webSearchCostUsdMicros: 0,
              createdAt: "2026-08-12T08:01:00.000Z",
            },
          },
          completedAt: null,
          createdAt: "2026-08-12T08:00:00.000Z",
          updatedAt: "2026-08-12T08:01:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/workerLease|attemptErrors|providerResponse/iu);
  });

  it("scopes Wiki shapes to the authenticated Workspace and ignores caller shape parameters", async () => {
    let upstreamUrl = "";
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([]);
      }) as typeof fetch,
    });

    await proxy.stream({
      actor,
      readModel: "wiki-pages-v1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/wiki-pages-v1?table=goat.users&where=true&params[1]=workspace_other",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.wiki_pages");
    expect(requestedUrl.searchParams.get("where")).toBe('"workspace_id" = $1');
    expect(requestedUrl.searchParams.get("params[1]")).toBe("workspace_1");
    expect(requestedUrl.searchParams.get("columns")).not.toContain("created_by_workos_id");
  });

  it("scopes the Task shape to the server-owned Workspace and nests canonical outcome fields", async () => {
    let upstreamUrl = "";
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"task_1"',
            value: {
              id: "task_1",
              display_id: "TASK-1",
              name: "Launch brief",
              goal: "Prepare the launch brief",
              conversation_id: "conversation_task_1",
              status: "succeeded",
              source: "manual",
              engine: "opencompany",
              model: "provider/model",
              workflow_id: null,
              schedule_id: null,
              scheduled_for: "2026-08-12 08:30:00+00",
              result: "Ready",
              error: null,
              reported_status: "done",
              outcome_comment: "Reviewed",
              archived_at: null,
              created_at: "2026-08-11 10:00:00+00",
              updated_at: "2026-08-11 10:01:00+00",
              actor_id: "must-not-cross",
              workspace_id: "must-not-cross",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "tasks-v1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/tasks-v1?table=goat.users&where=true",
      ),
    });
    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.task_read_model_v1");
    expect(requestedUrl.searchParams.get("where")).toContain('"workspace_id" = $2');
    expect(requestedUrl.searchParams.get("params[1]")).toBe("user_1");
    expect(requestedUrl.searchParams.get("params[2]")).toBe("workspace_1");
    expect(await response.json()).toEqual([
      {
        headers: { operation: "insert" },
        key: '"task_1"',
        value: {
          id: "task_1",
          displayId: "TASK-1",
          name: "Launch brief",
          goal: "Prepare the launch brief",
          conversationId: "conversation_task_1",
          status: "succeeded",
          source: "manual",
          engine: "opencompany",
          model: "provider/model",
          workflowId: null,
          scheduleId: null,
          scheduledFor: "2026-08-12T08:30:00.000Z",
          outcome: {
            result: "Ready",
            error: null,
            reportedStatus: "done",
            comment: "Reviewed",
          },
          archivedAt: null,
          createdAt: "2026-08-11T10:00:00.000Z",
          updatedAt: "2026-08-11T10:01:00.000Z",
        },
      },
    ]);
  });

  it("projects Workflow and schedule shapes without leaking tenancy or physical trigger fields", async () => {
    const requestedUrls: URL[] = [];
    const rowsByTable: Record<string, Record<string, unknown>> = {
      "goat.workflow_read_model_v1": {
        id: "workflow_1",
        slug: "weekly-research",
        name: "Weekly research",
        description: "Track material changes",
        steps: JSON.stringify([
          {
            id: "step_1",
            title: "Research",
            model: "provider/model",
            instructions: "Find changes.",
          },
        ]),
        status: "active",
        trigger: JSON.stringify({
          type: "schedule",
          cron: "0 9 * * 1",
          timezone: "Europe/Berlin",
          prompt: "Run this workflow.",
          enabled: true,
          lastRunAt: null,
          nextRunAt: "2026-08-13T09:00:00.000Z",
        }),
        version: "2",
        archived_at: null,
        created_at: "2026-08-12 08:00:00+00",
        updated_at: "2026-08-12 08:05:00+00",
        workspace_id: "must-not-cross",
      },
      "goat.workflow_schedule_read_model_v1": {
        id: "workflow_1",
        workflow_id: "workflow_1",
        workflow_slug: "weekly-research",
        name: "Weekly research",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
        prompt: "Run this workflow.",
        enabled: true,
        last_run_at: null,
        next_run_at: "2026-08-13 09:00:00+00",
        version: "2",
        created_at: "2026-08-12 08:00:00+00",
        updated_at: "2026-08-12 08:05:00+00",
        workspace_id: "must-not-cross",
      },
      "goat.task_schedule_read_model_v1": {
        id: "schedule_1",
        name: "Daily research",
        source_description: "Tasks page",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Research changes.",
        enabled: false,
        last_run_at: null,
        next_run_at: "2026-08-13 09:00:00+00",
        version: "3",
        created_at: "2026-08-12 08:00:00+00",
        updated_at: "2026-08-12 08:05:00+00",
        actor_id: "must-not-cross",
        workspace_id: "must-not-cross",
      },
    };
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        const requestedUrl = new URL(String(input));
        requestedUrls.push(requestedUrl);
        const table = requestedUrl.searchParams.get("table") ?? "";
        return Response.json([
          {
            headers: { operation: "insert" },
            key: JSON.stringify(rowsByTable[table]?.id),
            value: rowsByTable[table],
          },
        ]);
      }) as typeof fetch,
    });

    const [workflowResponse, workflowScheduleResponse, taskScheduleResponse] = await Promise.all([
      proxy.stream({
        actor,
        readModel: "workflows-v1",
        requestUrl: new URL("https://api.example.test/v1/read-models/workflows-v1"),
      }),
      proxy.stream({
        actor,
        readModel: "workflow-schedules-v1",
        requestUrl: new URL("https://api.example.test/v1/read-models/workflow-schedules-v1"),
      }),
      proxy.stream({
        actor,
        readModel: "task-schedules-v1",
        requestUrl: new URL("https://api.example.test/v1/read-models/task-schedules-v1"),
      }),
    ]);

    expect(requestedUrls.map((url) => url.searchParams.get("table"))).toEqual([
      "goat.workflow_read_model_v1",
      "goat.workflow_schedule_read_model_v1",
      "goat.task_schedule_read_model_v1",
    ]);
    expect(requestedUrls[0]?.searchParams.get("where")).toBe('"workspace_id" = $1');
    expect(requestedUrls[2]?.searchParams.get("where")).toContain('"actor_id" = $1');
    expect(requestedUrls[2]?.searchParams.get("where")).toContain('"workspace_id" IS NULL');
    expect((await workflowResponse.json())[0]?.value).toEqual({
      id: "workflow_1",
      slug: "weekly-research",
      name: "Weekly research",
      description: "Track material changes",
      steps: [
        {
          id: "step_1",
          title: "Research",
          model: "provider/model",
          instructions: "Find changes.",
        },
      ],
      status: "active",
      trigger: {
        type: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
        prompt: "Run this workflow.",
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2026-08-13T09:00:00.000Z",
      },
      version: 2,
      archivedAt: null,
      createdAt: "2026-08-12T08:00:00.000Z",
      updatedAt: "2026-08-12T08:05:00.000Z",
    });
    expect((await workflowScheduleResponse.json())[0]?.value).toMatchObject({
      id: "workflow_1",
      workflowId: "workflow_1",
      workflowSlug: "weekly-research",
      version: 2,
    });
    expect((await taskScheduleResponse.json())[0]?.value).toEqual({
      id: "schedule_1",
      name: "Daily research",
      sourceDescription: "Tasks page",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "Research changes.",
      enabled: false,
      lastRunAt: null,
      nextRunAt: "2026-08-13T09:00:00.000Z",
      version: 3,
      createdAt: "2026-08-12T08:00:00.000Z",
      updatedAt: "2026-08-12T08:05:00.000Z",
    });
  });

  it("projects a Workflow trigger update atomically from one JSON field", async () => {
    let requestedUrl: URL | undefined;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        requestedUrl = new URL(String(input));
        return Response.json([
          {
            headers: { operation: "update" },
            key: JSON.stringify("workflow_1"),
            value: {
              id: "workflow_1",
              trigger: JSON.stringify({
                type: "schedule",
                cron: "0 10 * * 1",
                timezone: "Europe/Berlin",
                prompt: "Run the updated workflow.",
                enabled: true,
                lastRunAt: null,
                nextRunAt: "2026-08-14T10:00:00.000Z",
              }),
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "workflows-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/workflows-v1"),
    });

    expect(requestedUrl?.searchParams.get("columns")).not.toContain("schedule_");
    expect((await response.json())[0]?.value).toEqual({
      id: "workflow_1",
      trigger: {
        type: "schedule",
        cron: "0 10 * * 1",
        timezone: "Europe/Berlin",
        prompt: "Run the updated workflow.",
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2026-08-14T10:00:00.000Z",
      },
    });
  });

  it("does not expose upstream Electric diagnostics", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      sourceId: "source_1",
      sourceSecret: "not-for-the-browser",
      fetch: vi.fn(
        async () => new Response("request failed: secret=not-for-the-browser", { status: 401 }),
      ) as typeof fetch,
    });

    await expect(
      proxy.stream({
        actor,
        readModel: "chat-conversations-v1",
        requestUrl: new URL("https://api.example.test/v1/read-models/chat-conversations-v1"),
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "unavailable",
      message: "Electric read models are unavailable.",
    });
  });

  it("preserves recovery metadata without returning an upstream 409 body", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(
        async () =>
          new Response('physical table "goat.message_read_model_v1" expired', {
            status: 409,
            headers: { "electric-handle": "replacement_handle" },
          }),
      ) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "chat-messages-v1",
      conversationId: "conversation_1",
      requestUrl: new URL("https://api.example.test/v1/read-models/chat-messages-v1"),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("electric-handle")).toBe("replacement_handle");
    await expect(response.text()).resolves.toBe("[]");
  });

  it("preserves a successful no-change long poll and its Electric cursor headers", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 204,
            headers: {
              "electric-handle": "shape_1",
              "electric-offset": "0_42",
            },
          }),
      ) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "chat-conversations-v1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/chat-conversations-v1?live=true",
      ),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("electric-handle")).toBe("shape_1");
    expect(response.headers.get("electric-offset")).toBe("0_42");
    await expect(response.text()).resolves.toBe("");
  });
});

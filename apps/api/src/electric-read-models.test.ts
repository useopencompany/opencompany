import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElectricReadModelProxy } from "./electric-read-models";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  createLogger: () => loggerMocks,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the v1 Conversation shape stable for deployed clients", async () => {
    let requestedUrl: URL | undefined;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        requestedUrl = new URL(String(input));
        return Response.json([]);
      }) as typeof fetch,
    });

    await proxy.stream({
      actor,
      readModel: "chat-conversations-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/chat-conversations-v1"),
    });

    expect(requestedUrl?.searchParams.get("columns")).not.toContain("activity_state");
    expect(requestedUrl?.searchParams.get("columns")).not.toContain("has_unseen");
  });

  it("projects API-owned activity and unseen state on Conversation rows", async () => {
    let requestedUrl: URL | undefined;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        requestedUrl = new URL(String(input));
        return Response.json(
          [
            {
              headers: { operation: "insert" },
              key: '"conversation_1"',
              value: {
                id: "conversation_1",
                title: "Review launch",
                engine: "claude_code",
                model: "anthropic/claude-sonnet-5",
                archived_at: null,
                pinned_at: null,
                last_seen_at: "2026-08-10 20:00:00+00",
                activity_state: "working",
                has_unseen: "true",
                runtime_status: "running",
                active_run_id: "run_1",
                runtime_has_error: "false",
                runtime_updated_at: "2026-08-10 20:00:30+00",
                message_shape_epoch: "3",
                error: "must-not-cross",
                created_at: "2026-08-10 19:00:00+00",
                updated_at: "2026-08-10 20:01:00+00",
                actor_id: "must-not-cross",
                workspace_id: "must-not-cross",
              },
            },
          ],
          {
            headers: {
              "electric-schema": JSON.stringify({
                id: { type: "text" },
                has_unseen: { type: "bool" },
                runtime_has_error: { type: "bool" },
              }),
            },
          },
        );
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "chat-conversations-v2",
      requestUrl: new URL("https://api.example.test/v1/read-models/chat-conversations-v2"),
    });

    expect(requestedUrl?.searchParams.get("columns")).toContain("activity_state");
    expect(requestedUrl?.searchParams.get("columns")).toContain("has_unseen");
    expect(requestedUrl?.searchParams.get("columns")).toContain("runtime_status");
    expect(requestedUrl?.searchParams.get("columns")).toContain("message_shape_epoch");
    expect(requestedUrl?.searchParams.get("columns")?.split(",")).not.toContain("error");
    expect(response.headers.get("electric-schema")).toBe(JSON.stringify({ id: { type: "text" } }));
    expect(await response.json()).toEqual([
      {
        headers: { operation: "insert" },
        key: '"conversation_1"',
        value: {
          id: "conversation_1",
          title: "Review launch",
          engine: "claude_code",
          model: "anthropic/claude-sonnet-5",
          archivedAt: null,
          pinnedAt: null,
          lastSeenAt: "2026-08-10T20:00:00.000Z",
          activityState: "working",
          hasUnseen: true,
          messageShapeEpoch: 3,
          runtime: {
            status: "running",
            activeRunId: "run_1",
            hasError: false,
            updatedAt: "2026-08-10T20:00:30.000Z",
          },
          createdAt: "2026-08-10T19:00:00.000Z",
          updatedAt: "2026-08-10T20:01:00.000Z",
        },
      },
    ]);
  });

  it("scopes v2 Conversation detail shapes to one actor-authorized projection row", async () => {
    let requestedUrl: URL | undefined;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        requestedUrl = new URL(String(input));
        return Response.json([]);
      }) as typeof fetch,
    });

    await proxy.stream({
      actor,
      readModel: "chat-conversations-v2",
      conversationId: "conversation_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/chat-conversations-v2?conversationId=conversation_1",
      ),
    });

    expect(requestedUrl?.searchParams.get("where")).toBe(
      '"id" = $1 AND "actor_id" = $2 AND ("workspace_id" = $3 OR "workspace_id" IS NULL)',
    );
    expect(requestedUrl?.searchParams.get("params[1]")).toBe("conversation_1");
    expect(requestedUrl?.searchParams.get("params[2]")).toBe("user_1");
    expect(requestedUrl?.searchParams.get("params[3]")).toBe("workspace_1");
  });

  it("projects nested runtime fields from partial v2 Conversation updates", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async () =>
        Response.json([
          {
            headers: { operation: "update" },
            key: '"conversation_1"',
            value: {
              runtime_status: "failed",
              active_run_id: null,
              runtime_has_error: "t",
              runtime_updated_at: "2026-08-10 20:02:00+00",
            },
          },
        ]),
      ) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "chat-conversations-v2",
      conversationId: "conversation_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/chat-conversations-v2?conversationId=conversation_1",
      ),
    });

    await expect(response.json()).resolves.toEqual([
      {
        headers: { operation: "update" },
        key: '"conversation_1"',
        value: {
          runtime: {
            status: "failed",
            activeRunId: null,
            hasError: true,
            updatedAt: "2026-08-10T20:02:00.000Z",
          },
        },
      },
    ]);
  });

  it("serves integration accounts as a credential-free actor and workspace read model", async () => {
    let requestedUrl: URL | undefined;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        requestedUrl = new URL(String(input));
        return Response.json([
          {
            headers: { operation: "insert" },
            key: JSON.stringify("integration_1"),
            value: {
              id: "integration_1",
              user_workos_id: "must-not-cross",
              workspace_id: "workspace_1",
              provider: "jamie",
              external_id: "123456",
              connection_label: "opencompany",
              account_name: "opencompany",
              account_email: null,
              account_type: "Organization",
              status: "connected",
              status_reason: null,
              scopes: JSON.stringify(["repo"]),
              capability_modes: JSON.stringify({ repositories: "on" }),
              oauth_access_token: "must-not-cross",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "integration-accounts-v1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/integration-accounts-v1?table=goat.integration_credentials",
      ),
    });

    expect(requestedUrl?.searchParams.get("table")).toBe("goat.integrations");
    expect(requestedUrl?.searchParams.get("where")).toBe(
      `("user_workos_id" = $1 AND "workspace_id" IS NULL) OR "workspace_id" = $2`,
    );
    expect(requestedUrl?.searchParams.get("params[1]")).toBe("user_1");
    expect(requestedUrl?.searchParams.get("params[2]")).toBe("workspace_1");
    expect(requestedUrl?.searchParams.get("columns")).not.toContain("credential");
    expect((await response.json())[0]?.value).toEqual({
      id: "integration_1",
      provider: "jamie",
      workspaceId: "workspace_1",
      externalId: "123456",
      connectionLabel: "opencompany",
      accountName: "opencompany",
      accountEmail: null,
      accountType: "Organization",
      status: "connected",
      statusReason: null,
      scopes: ["repo"],
      capabilityModes: { repositories: "on" },
    });
  });

  it("reduces integration account delete history to its identity before validation", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async () =>
        Response.json([
          {
            headers: { operation: "delete" },
            key: JSON.stringify("integration_retired"),
            value: {
              id: "integration_retired",
              provider: "imessage",
              status: "disconnected",
            },
          },
        ]),
      ) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "integration-accounts-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/integration-accounts-v1"),
    });

    await expect(response.json()).resolves.toEqual([
      {
        headers: { operation: "delete" },
        key: JSON.stringify("integration_retired"),
        value: { id: "integration_retired" },
      },
    ]);
  });

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
      messageShapeEpoch: 7,
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
    expect(requestedUrl.searchParams.get("params[4]")).toBe("7");
    expect(requestedUrl.searchParams.get("where")).toContain("CAST($4 AS text) = CAST($4 AS text)");
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

  it("streams compact Message summaries without selecting full presentations", async () => {
    let upstreamUrl = "";
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"message_1"',
            value: {
              id: "message_1",
              conversation_id: "conversation_1",
              role: "assistant",
              content: "Done",
              task_id: null,
              presentation_summary: JSON.stringify({
                schemaVersion: "opencompany.chat.debug.v1",
                uiMessageParts: [
                  { type: "reasoning", text: "Preview", presentationSummary: true },
                  { type: "text", text: "Done" },
                ],
              }),
              attachments: null,
              created_at: "2026-08-10 20:00:00+00",
              updated_at: "2026-08-10 20:00:01+00",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "chat-messages-v2",
      conversationId: "conversation_1",
      messageShapeEpoch: 9,
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/chat-messages-v2?conversationId=conversation_1",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    const columns = requestedUrl.searchParams.get("columns")?.split(",") ?? [];
    expect(columns).toContain("presentation_summary");
    expect(columns).not.toContain("presentation");
    expect(requestedUrl.searchParams.get("params[4]")).toBe("9");
    await expect(response.json()).resolves.toEqual([
      {
        headers: { operation: "insert" },
        key: '"message_1"',
        value: {
          id: "message_1",
          conversationId: "conversation_1",
          role: "assistant",
          content: "Done",
          taskId: null,
          presentationSummary: {
            schemaVersion: "opencompany.chat.debug.v1",
            uiMessageParts: [
              { type: "reasoning", text: "Preview", presentationSummary: true },
              { type: "text", text: "Done" },
            ],
          },
          attachments: null,
          createdAt: "2026-08-10T20:00:00.000Z",
          updatedAt: "2026-08-10T20:00:01.000Z",
        },
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

  it("qualifies engine sessions globally and strips runtime ownership fields", async () => {
    let upstreamUrl = "";
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"runtime_1"',
            value: {
              id: "runtime_1",
              chat_session_id: "conversation_1",
              engine: "codex",
              status: "running",
              active_turn_id: "run_1",
              error: null,
              updated_at: "2026-08-13 08:00:00+00",
              sandbox_id: "must-not-cross",
              lease_id: "must-not-cross",
              user_workos_id: "must-not-cross",
              workspace_id: "must-not-cross",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "engine-sessions-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/engine-sessions-v1"),
    });
    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.codex_chat_sessions");
    expect(requestedUrl.searchParams.get("where")).toContain('"user_workos_id" = $1');
    expect(requestedUrl.searchParams.get("where")).toContain('"workspace_id" = $2');
    expect(requestedUrl.searchParams.get("params[1]")).toBe("user_1");
    expect(requestedUrl.searchParams.get("params[2]")).toBe("workspace_1");
    expect(requestedUrl.searchParams.get("columns")?.split(",")).toContain("id");
    expect(requestedUrl.searchParams.get("columns")).not.toContain("sandbox_id");
    await expect(response.json()).resolves.toEqual([
      {
        headers: { operation: "insert" },
        key: '"runtime_1"',
        value: {
          conversationId: "conversation_1",
          engine: "codex",
          status: "running",
          activeRunId: "run_1",
          error: null,
          updatedAt: "2026-08-13T08:00:00.000Z",
        },
      },
    ]);
  });

  it("scopes an engine session shape to one Conversation without widening ownership", async () => {
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
      readModel: "engine-sessions-v1",
      conversationId: "conversation_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/engine-sessions-v1?conversationId=conversation_1",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("where")).toContain('"chat_session_id" = $1');
    expect(requestedUrl.searchParams.get("where")).toContain('"user_workos_id" = $2');
    expect(requestedUrl.searchParams.get("where")).toContain('"workspace_id" = $3');
    expect(requestedUrl.searchParams.get("params[1]")).toBe("conversation_1");
    expect(requestedUrl.searchParams.get("params[2]")).toBe("user_1");
    expect(requestedUrl.searchParams.get("params[3]")).toBe("workspace_1");
  });

  it("bounds a legacy session error without dropping valid active session state", async () => {
    const historicalError = `${"x".repeat(2_000)}private-tail`;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async () =>
        Response.json([
          {
            headers: { operation: "insert" },
            key: '"runtime_legacy"',
            value: {
              id: "runtime_legacy",
              chat_session_id: "conversation_legacy",
              engine: "claude_code",
              status: "failed",
              active_turn_id: null,
              error: historicalError,
              updated_at: "2026-08-13 07:00:00+00",
            },
          },
          {
            headers: { operation: "insert" },
            key: '"runtime_active"',
            value: {
              id: "runtime_active",
              chat_session_id: "conversation_active",
              engine: "codex",
              status: "running",
              active_turn_id: "run_active",
              error: null,
              updated_at: "2026-08-13 08:00:00+00",
            },
          },
        ]),
      ) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "engine-sessions-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/engine-sessions-v1"),
    });
    const payload = (await response.json()) as Array<{ value: Record<string, unknown> }>;

    expect(payload[0]?.value.error).toBe(historicalError.slice(0, 2_000));
    expect(payload[1]?.value).toMatchObject({
      conversationId: "conversation_active",
      status: "running",
      activeRunId: "run_active",
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith("Normalized overlong engine session error", {
      event: "opencompany.api_engine_session_error_normalized",
      read_model: "engine-sessions-v1",
      field: "error",
      original_length: historicalError.length,
      max_length: 2_000,
    });
    expect(loggerMocks.warn.mock.calls[0]?.[1]).not.toHaveProperty("error");
  });

  it("bounds overlong errors in partial Electric updates", async () => {
    const historicalError = "x".repeat(2_001);
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async () =>
        Response.json([
          {
            headers: { operation: "update" },
            key: '"runtime_legacy"',
            value: { error: historicalError },
          },
        ]),
      ) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "engine-sessions-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/engine-sessions-v1"),
    });

    await expect(response.json()).resolves.toEqual([
      {
        headers: { operation: "update" },
        key: '"runtime_legacy"',
        value: { error: historicalError.slice(0, 2_000) },
      },
    ]);
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

  it("projects import runs without leases, actors, integration IDs, or provider payloads", async () => {
    let upstreamUrl = "";
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"gbimp_1"',
            value: {
              id: "gbimp_1",
              status: "awaiting_confirmation",
              company_url: "https://acme.com",
              company_name: "Acme",
              focus: "x".repeat(2_100),
              source_selection: JSON.stringify({
                public_web: { enabled: true },
                github: {
                  enabled: true,
                  integrationId: "must-not-cross",
                  config: { repos: [{ id: "must-not-cross" }] },
                },
                unknown_provider: { enabled: true },
              }),
              discovery_summary: JSON.stringify({
                github: {
                  status: "ready",
                  discoveredEntries: 12,
                  eligibleEntries: 5,
                  alreadyKnownEntries: 7,
                  selectedEntries: 3,
                  plannedRuns: 3,
                  searchCount: 4,
                  internalDiagnostics: "must-not-cross",
                  error: "y".repeat(2_100),
                },
              }),
              last_error: null,
              confirmed_at: null,
              completed_at: null,
              created_at: "2026-08-12 08:00:00+00",
              updated_at: "2026-08-12 08:01:00+00",
              brain_ref: "must-not-cross",
              user_workos_id: "must-not-cross",
              lease_id: "must-not-cross",
              lease_owner: "must-not-cross",
              result: "must-not-cross",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "brain-import-runs-v1",
      brainId: "brain_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/brain-import-runs-v1?brainId=brain_1&table=goat.users&where=true",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.brain_import_runs");
    expect(requestedUrl.searchParams.get("where")).toBe('"brain_ref" = $1');
    expect(requestedUrl.searchParams.get("columns")).not.toMatch(
      /lease|user_workos|result|history/iu,
    );
    const body = await response.json();
    expect(body).toEqual([
      {
        headers: { operation: "insert" },
        key: '"gbimp_1"',
        value: {
          id: "gbimp_1",
          status: "awaiting_confirmation",
          companyUrl: "https://acme.com",
          companyName: "Acme",
          focus: "x".repeat(2_000),
          sourceSelection: {
            public_web: { enabled: true },
            github: { enabled: true },
          },
          discoverySummary: {
            github: {
              status: "ready",
              discoveredEntries: 12,
              eligibleEntries: 5,
              alreadyKnownEntries: 7,
              selectedEntries: 3,
              plannedRuns: 3,
              error: "y".repeat(2_000),
            },
          },
          lastError: null,
          confirmedAt: null,
          completedAt: null,
          createdAt: "2026-08-12T08:00:00.000Z",
          updatedAt: "2026-08-12T08:01:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /must-not-cross|integrationId|unknown_provider|searchCount|internalDiagnostics/iu,
    );
  });

  it("scopes Wiki page and import shapes to the authenticated Workspace", async () => {
    const upstreamUrls: string[] = [];
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrls.push(String(input));
        return Response.json([]);
      }) as typeof fetch,
    });

    await proxy.stream({
      actor,
      readModel: "wiki-pages-v2",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/wiki-pages-v2?table=goat.users&where=true&params[1]=workspace_other",
      ),
    });
    await proxy.stream({
      actor,
      readModel: "wiki-import-runs-v1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/wiki-import-runs-v1?table=goat.users&where=true&params[1]=workspace_other",
      ),
    });

    const pagesUrl = new URL(upstreamUrls[0]!);
    expect(pagesUrl.searchParams.get("table")).toBe("goat.wiki_pages");
    expect(pagesUrl.searchParams.get("where")).toBe('"workspace_id" = $1');
    expect(pagesUrl.searchParams.get("params[1]")).toBe("workspace_1");
    expect(pagesUrl.searchParams.get("columns")).not.toContain("created_by_workos_id");

    const importsUrl = new URL(upstreamUrls[1]!);
    expect(importsUrl.searchParams.get("table")).toBe("goat.brain_import_runs");
    expect(importsUrl.searchParams.get("where")).toBe('"workspace_id" = $1');
    expect(importsUrl.searchParams.get("params[1]")).toBe("workspace_1");
    expect(importsUrl.searchParams.get("columns")).not.toMatch(/brain_ref|user_workos|lease/iu);
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

  it("scopes Task activities to one authorized Task and projects only timeline fields", async () => {
    let upstreamUrl = "";
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async (input: URL | RequestInfo) => {
        upstreamUrl = String(input);
        return Response.json([
          {
            headers: { operation: "insert" },
            key: '"task_activity_1"',
            value: {
              id: "task_activity_1",
              task_id: "task_1",
              author: "system",
              author_workos_id: null,
              kind: "run_finished",
              body: "Launch brief ready.",
              metadata: JSON.stringify({
                runId: "run_1",
                disposition: "done",
                stepIndex: 0,
                stepCount: 1,
              }),
              created_at: "2026-08-11 10:01:00+00",
              workspace_id: "must-not-cross",
            },
          },
        ]);
      }) as typeof fetch,
    });

    const response = await proxy.stream({
      actor,
      readModel: "task-activities-v1",
      taskId: "task_1",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/task-activities-v1?taskId=task_1&table=goat.users&where=true",
      ),
    });

    const requestedUrl = new URL(upstreamUrl);
    expect(requestedUrl.searchParams.get("table")).toBe("goat.task_activities");
    expect(requestedUrl.searchParams.get("where")).toBe('"task_id" = $1');
    expect(requestedUrl.searchParams.get("params[1]")).toBe("task_1");
    expect(await response.json()).toEqual([
      {
        headers: { operation: "insert" },
        key: '"task_activity_1"',
        value: {
          id: "task_activity_1",
          taskId: "task_1",
          author: "system",
          authorWorkosId: null,
          kind: "run_finished",
          body: "Launch brief ready.",
          metadata: {
            runId: "run_1",
            disposition: "done",
            stepIndex: 0,
            stepCount: 1,
          },
          createdAt: "2026-08-11T10:01:00.000Z",
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

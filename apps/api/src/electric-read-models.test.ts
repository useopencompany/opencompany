import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElectricReadModelProxy, parseElectricAuthMode } from "./electric-read-models";

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
  ],
  authenticationMethod: "session" as const,
};

describe("Electric read models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects self-hosted auth while retaining cloud credentials for rollback", async () => {
    let requestedUrl: URL | undefined;
    let requestedHeaders: HeadersInit | undefined;
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      authMode: "self-hosted",
      sourceId: "retained_cloud_source",
      sourceSecret: "retained_cloud_secret",
      electricSecret: "self_hosted_secret",
      token: "retained_bearer_token",
      fetch: vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        requestedUrl = new URL(String(input));
        requestedHeaders = init?.headers;
        return Response.json([]);
      }) as typeof fetch,
    });

    await proxy.stream({
      actor,
      readModel: "chat-conversations-v1",
      requestUrl: new URL("https://api.example.test/v1/read-models/chat-conversations-v1"),
    });

    expect(requestedUrl?.searchParams.get("secret")).toBe("self_hosted_secret");
    expect(requestedUrl?.searchParams.has("source_id")).toBe(false);
    expect(requestedHeaders).toEqual({});
  });

  it("rejects an unknown Electric auth mode", () => {
    expect(() => parseElectricAuthMode("automatic")).toThrow(
      "ELECTRIC_AUTH_MODE must be one of: cloud, self-hosted, bearer, insecure.",
    );
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

  it("projects API-owned activity, unseen, and awaiting-input state on Conversation rows", async () => {
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
                awaiting_input: "true",
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
                awaiting_input: { type: "bool" },
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
    expect(requestedUrl?.searchParams.get("columns")).toContain("awaiting_input");
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
          // A foreground approval keeps the engine open, so the row is both working and blocked
          // on the reader. The client picks the signal it needs rather than losing one to the other.
          awaitingInput: true,
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

  it.each(["notion", "custom_mcp"])("streams %s integration accounts", async (provider) => {
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
              provider,
              external_id: "123456",
              connection_label: "opencompany",
              account_name: "opencompany",
              account_email: null,
              account_type: "Organization",
              status: "connected",
              status_reason: null,
              scopes: JSON.stringify(["repo"]),
              capability_modes: JSON.stringify({ repositories: "on" }),
              tool_modes: JSON.stringify({ "list-broadcasts": "on" }),
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
      `"user_workos_id" = $1 AND "workspace_id" IS NULL AND CAST($2 AS text) = CAST($2 AS text) ` +
        `AND CAST($3 AS text) = CAST($3 AS text)`,
    );
    expect(requestedUrl?.searchParams.get("params[1]")).toBe("user_1");
    expect(requestedUrl?.searchParams.get("params[2]")).toBe("workspace_1");
    expect(requestedUrl?.searchParams.get("params[3]")?.split(",")).toEqual([
      "gmail",
      "google_admin",
      "google_calendar",
      "google_drive",
      "linear",
      "github",
      "github_user",
      "jamie",
      "slack",
      "slack_bot",
      "hubspot",
      "granola",
      "fathom",
      "attio",
      "betterstack",
      "convex",
      "render",
      "vercel",
      "signoz",
      "dash0",
      "stripe",
      "latitude",
      "posthog",
      "neon",
      "notion",
      "supabase",
      "resend",
      "todoist",
      "x_account",
      "custom_mcp",
    ]);
    expect(requestedUrl?.searchParams.get("columns")).not.toContain("credential");
    expect(requestedUrl?.searchParams.get("columns")?.split(",")).toContain("tool_modes");
    expect((await response.json())[0]?.value).toEqual({
      id: "integration_1",
      provider,
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
      toolModes: { "list-broadcasts": "on" },
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

  it("retains the public engine session identity on delete", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async () =>
        Response.json([
          {
            headers: { operation: "delete" },
            key: '"runtime_retired"',
            value: {
              id: "runtime_retired",
              chat_session_id: "conversation_retired",
              engine: "retired_engine",
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

    await expect(response.json()).resolves.toEqual([
      {
        headers: { operation: "delete" },
        key: '"runtime_retired"',
        value: { conversationId: "conversation_retired" },
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

  it("scopes the Wiki page shape to the authorized wiki, not the Workspace", async () => {
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
      wikiId: "goat_wiki_clevel",
      requestUrl: new URL(
        "https://api.example.test/v1/read-models/wiki-pages-v2?table=goat.users&where=true&params[1]=workspace_other",
      ),
    });
    // A workspace can hold a restricted wiki, so a workspace-scoped page stream
    // would put its rows in every member's browser.
    const pagesUrl = new URL(upstreamUrls[0]!);
    expect(pagesUrl.searchParams.get("table")).toBe("goat.wiki_pages");
    expect(pagesUrl.searchParams.get("where")).toBe('"wiki_id" = $1');
    expect(pagesUrl.searchParams.get("params[1]")).toBe("goat_wiki_clevel");
    expect(pagesUrl.searchParams.get("columns")).not.toContain("created_by_workos_id");
  });

  it("refuses a Wiki page or timeline stream with no wiki resolved", async () => {
    const proxy = new ElectricReadModelProxy({
      electricUrl: "https://electric.example.test",
      fetch: vi.fn(async () => Response.json([])) as typeof fetch,
    });

    for (const readModel of ["wiki-pages-v2", "wiki-timeline-v1"] as const) {
      await expect(
        proxy.stream({
          actor,
          readModel,
          requestUrl: new URL(`https://api.example.test/v1/read-models/${readModel}`),
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
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
              has_unseen: true,
              awaiting_input: false,
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
          hasUnseen: true,
          awaitingInput: false,
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
        scope: "company",
        created_by_workos_id: "user_1",
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
        scope: "company",
        created_by_workos_id: "user_1",
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

    const [workflowResponse, workflowScheduleResponse] = await Promise.all([
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
    ]);

    expect(requestedUrls.map((url) => url.searchParams.get("table"))).toEqual([
      "goat.workflow_read_model_v1",
      "goat.workflow_schedule_read_model_v1",
    ]);
    // Personal workflows belong to their creator, so the shape itself withholds a teammate's.
    expect(requestedUrls[0]?.searchParams.get("where")).toBe(
      '"workspace_id" = $1 AND ("scope" = \'company\' OR "created_by_workos_id" = $2)',
    );
    expect(requestedUrls[1]?.searchParams.get("where")).toBe(
      '"workspace_id" = $1 AND ("scope" = \'company\' OR "created_by_workos_id" = $2)',
    );
    expect(requestedUrls[1]?.searchParams.get("params[1]")).toBe("workspace_1");
    expect(requestedUrls[1]?.searchParams.get("params[2]")).toBe("user_1");
    expect(requestedUrls[1]?.searchParams.get("columns")).not.toContain("scope");
    expect(requestedUrls[1]?.searchParams.get("columns")).not.toContain("created_by_workos_id");
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
      scope: "company",
      createdByUserId: "user_1",
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

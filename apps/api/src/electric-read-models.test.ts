import { describe, expect, it, vi } from "vitest";
import { ElectricChatReadModelProxy } from "./electric-read-models";

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session" as const,
};

describe("Electric Chat read models", () => {
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
                  blobUrl: "https://private.invalid/brief.pdf",
                  blobPathname: "private/brief.pdf",
                },
              ],
              created_at: "2026-08-10T20:00:00.000Z",
              updated_at: "2026-08-10T20:00:01.000Z",
              actor_id: "must-not-cross",
              workspace_id: "must-not-cross",
            },
            old_value: { actor_id: "must-not-cross", content: "Old" },
          },
        ],
        {
          headers: {
            "electric-schema": JSON.stringify({
              id: { type: "text" },
              conversation_id: { type: "text" },
              actor_id: { type: "text" },
              updated_at: { type: "timestamptz" },
            }),
          },
        },
      );
    });
    const proxy = new ElectricChatReadModelProxy({
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
    ]);
  });

  it("requires conversation scope for child read models", async () => {
    const proxy = new ElectricChatReadModelProxy({
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

  it("does not expose upstream Electric diagnostics", async () => {
    const proxy = new ElectricChatReadModelProxy({
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
    const proxy = new ElectricChatReadModelProxy({
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
    const proxy = new ElectricChatReadModelProxy({
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

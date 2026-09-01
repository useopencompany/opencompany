import { expect, it, vi } from "vitest";
import type { ChatUiMessage } from "@/lib/chat-ui";
import { loadHeadlessChatMessagePresentation } from "./headless-chat-presentations";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("./headless-chat-api", () => ({
  headlessChatApiBaseUrl: () => "https://api.example.test",
  createHeadlessChatApiFetch: () => mocks.fetch,
}));

it("loads and caches a full presentation for a compact historical Message", async () => {
  const summary = {
    id: "message_client_cache",
    role: "assistant",
    metadata: {
      sessionId: "conversation_1",
      presentation: {
        source: "summary",
        updatedAt: "2026-08-10T20:00:01.000Z",
      },
      timing: {
        createdAt: "2026-08-10T20:00:00.000Z",
        updatedAt: "2026-08-10T20:00:01.000Z",
      },
    },
    parts: [
      { type: "reasoning", text: "Preview", state: "done" },
      { type: "text", text: "Done" },
    ],
  } as ChatUiMessage;
  mocks.fetch.mockResolvedValueOnce(
    Response.json(
      {
        data: {
          presentation: {
            schemaVersion: "opencompany.chat.debug.v1",
            uiMessageParts: [
              { type: "reasoning", text: "The complete reasoning detail", state: "done" },
              { type: "text", text: "Done" },
            ],
          },
          updatedAt: "2026-08-10T20:00:01.000Z",
        },
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
      },
      { headers: { ETag: 'W/"presentation-1"' } },
    ),
  );

  const first = await loadHeadlessChatMessagePresentation(summary);
  const second = await loadHeadlessChatMessagePresentation(summary);

  expect(first.parts[0]).toMatchObject({
    type: "reasoning",
    text: "The complete reasoning detail",
  });
  expect(second).toBe(first);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(String(mocks.fetch.mock.calls[0]?.[0])).toBe(
    "https://api.example.test/v1/conversations/conversation_1/messages/message_client_cache/presentation",
  );
});

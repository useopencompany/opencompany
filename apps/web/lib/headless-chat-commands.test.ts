import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitHeadlessConversationTransaction } from "./headless-chat-collections";
import { updateHeadlessChatConversation } from "./headless-chat-commands";

vi.mock("./headless-chat-collections", () => ({
  awaitHeadlessConversationTransaction: vi.fn(async () => undefined),
}));

describe("headless Conversation commands", () => {
  beforeEach(() => vi.clearAllMocks());

  it("patches the canonical resource and reconciles through its transaction id", async () => {
    let request: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        data: { conversationId: "conversation_1", transactionId: "42" },
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
      });
    });

    await expect(
      updateHeadlessChatConversation(
        "conversation_1",
        { archived: true },
        { baseUrl: "https://app.example.test", fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toEqual({ conversationId: "conversation_1", transactionId: "42" });

    const sent = request as unknown as Request;
    expect(sent.method).toBe("PATCH");
    expect(new URL(sent.url).pathname).toBe("/v1/conversations/conversation_1");
    await expect(sent.json()).resolves.toEqual({ archived: true });
    expect(awaitHeadlessConversationTransaction).toHaveBeenCalledWith("42");
  });
});

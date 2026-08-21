import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  getHeadlessChatConversations,
  getHeadlessChatEngineSession,
  getHeadlessChatMessages,
  getHeadlessChatMessagesGeneration,
  retryHeadlessChatMessages,
} from "./headless-chat-collections";
import { getChatSyncFailed, recordChatSyncError } from "./headless-chat-sync-status";

vi.mock("@tanstack/electric-db-collection", () => ({
  electricCollectionOptions: vi.fn((options) => options),
}));

vi.mock("@tanstack/react-db", () => ({
  createCollection: vi.fn((options) => ({
    options,
    preload: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    utils: { awaitTxId: vi.fn(async () => undefined) },
  })),
}));

vi.mock("./headless-chat-api", () => ({
  createHeadlessChatApiFetch: vi.fn(() => fetch),
  headlessChatApiBaseUrl: vi.fn(() => "https://api.example.test"),
}));

type TestCollection = {
  options: {
    id: string;
    shapeOptions: { url: string; params?: Record<string, string> };
  };
};

type MockCollection = {
  preload: Mock;
  cleanup: Mock;
};

describe("headless Chat collections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the sidebar list global and caches engine session shapes by Conversation", () => {
    const sidebar = getHeadlessChatConversations();
    const firstSession = getHeadlessChatEngineSession("conversation_1");
    const sameSession = getHeadlessChatEngineSession("conversation_1");
    const otherSession = getHeadlessChatEngineSession("conversation_2");

    expect(firstSession).toBe(sameSession);
    expect(firstSession).not.toBe(otherSession);
    expect(createCollection).toHaveBeenCalledTimes(3);
    expect((sidebar as unknown as TestCollection).options).toMatchObject({
      id: "headless-chat:conversations:v2",
      shapeOptions: {
        url: "https://api.example.test/v1/read-models/chat-conversations-v2",
      },
    });
    expect((sidebar as unknown as TestCollection).options.shapeOptions.params).toBeUndefined();
    expect((firstSession as unknown as TestCollection).options).toMatchObject({
      id: "headless-chat:engine-session:v1:conversation_1",
      shapeOptions: {
        url: "https://api.example.test/v1/read-models/engine-sessions-v1",
        params: { conversationId: "conversation_1" },
      },
    });
  });

  it("stops the old stream and recreates the message collection on retry", async () => {
    const conversationId = "conversation_retry";
    const first = getHeadlessChatMessages(conversationId) as unknown as MockCollection;
    expect(getHeadlessChatMessages(conversationId)).toBe(
      first as unknown as ReturnType<typeof getHeadlessChatMessages>,
    ); // cached until retry
    const generationBefore = getHeadlessChatMessagesGeneration(conversationId);
    recordChatSyncError(conversationId);
    expect(getChatSyncFailed(conversationId)).toBe(true);

    await retryHeadlessChatMessages(conversationId);

    // A no-op preload on the ready collection would leave a persistently-failed stream stuck, so
    // retry must hand back a fresh collection (new ShapeStream) and clear the surfaced failure.
    expect(getChatSyncFailed(conversationId)).toBe(false);
    const fresh = getHeadlessChatMessages(conversationId) as unknown as MockCollection;
    expect(fresh).not.toBe(first);
    expect(getHeadlessChatMessagesGeneration(conversationId)).toBe(generationBefore + 1);
    // The previous stream must be stopped before the fresh one starts fetching, so both never race
    // on the same heavy transcript and a stale onError cannot re-flag the conversation.
    expect(first.cleanup).toHaveBeenCalledTimes(1);
    expect(first.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      fresh.preload.mock.invocationCallOrder[0]!,
    );
  });
});

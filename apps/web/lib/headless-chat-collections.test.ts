import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("recreates the message collection and clears the failure flag on retry", async () => {
    const conversationId = "conversation_retry";
    const first = getHeadlessChatMessages(conversationId);
    expect(getHeadlessChatMessages(conversationId)).toBe(first); // cached until retry
    const generationBefore = getHeadlessChatMessagesGeneration(conversationId);
    recordChatSyncError(conversationId);
    expect(getChatSyncFailed(conversationId)).toBe(true);

    await retryHeadlessChatMessages(conversationId);

    // A no-op preload on the ready collection would leave a persistently-failed stream stuck, so
    // retry must hand back a fresh collection (new ShapeStream) and clear the surfaced failure.
    expect(getChatSyncFailed(conversationId)).toBe(false);
    expect(getHeadlessChatMessages(conversationId)).not.toBe(first);
    expect(getHeadlessChatMessagesGeneration(conversationId)).toBe(generationBefore + 1);
  });
});

import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHeadlessChatConversation,
  getHeadlessChatConversations,
} from "./headless-chat-collections";

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

  it("keeps the sidebar list global and caches detail shapes by Conversation", () => {
    const sidebar = getHeadlessChatConversations();
    const firstDetail = getHeadlessChatConversation("conversation_1");
    const sameDetail = getHeadlessChatConversation("conversation_1");
    const otherDetail = getHeadlessChatConversation("conversation_2");

    expect(firstDetail).toBe(sameDetail);
    expect(firstDetail).not.toBe(otherDetail);
    expect(createCollection).toHaveBeenCalledTimes(3);
    expect((sidebar as unknown as TestCollection).options).toMatchObject({
      id: "headless-chat:conversations:v2",
      shapeOptions: {
        url: "https://api.example.test/v1/read-models/chat-conversations-v2",
      },
    });
    expect((sidebar as unknown as TestCollection).options.shapeOptions.params).toBeUndefined();
    expect((firstDetail as unknown as TestCollection).options).toMatchObject({
      id: "headless-chat:conversation:v2:conversation_1",
      shapeOptions: {
        url: "https://api.example.test/v1/read-models/chat-conversations-v2",
        params: { conversationId: "conversation_1" },
      },
    });
  });
});

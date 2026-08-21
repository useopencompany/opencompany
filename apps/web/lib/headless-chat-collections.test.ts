import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHeadlessChatConversations,
  getHeadlessChatEngineSession,
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
});

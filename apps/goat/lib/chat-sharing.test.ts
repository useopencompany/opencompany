import type {
  GoatChatMessageAttachment,
  GoatChatSession,
  GoatChatShare,
} from "@opencompany/db/goat-schema";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import {
  createDbGoatChatShareStore,
  ensureGoatChatShareForUser,
  type GoatChatShareStore,
  isGoatChatShareId,
  loadPublicGoatChat,
  newGoatChatShareId,
} from "@/lib/chat-sharing";
import type { GoatStoredChatMessage } from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

const SHARE_ID = "goat_chat_share_123e4567-e89b-42d3-a456-426614174000";

describe("Goat chat sharing", () => {
  it("scopes share creation to the session owner and reuses the unique session token", async () => {
    const query = vi.fn(async (...[statement]: [string, unknown[], object]) => {
      if (statement.startsWith("insert")) return { rows: [] };
      if (statement.includes('"goat"."chat_session_shares"')) {
        return { rows: [[SHARE_ID, "chat_1", "2026-07-27T10:00:00.000Z"]] };
      }
      return { rows: [["chat_1"]] };
    });
    const client = Object.assign(query, {
      transaction: vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
    });
    const store = createDbGoatChatShareStore(drizzle(client as never) as never);

    await expect(
      store.ensureShare({
        id: "goat_chat_share_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
      }),
    ).resolves.toMatchObject({ id: SHARE_ID, chatSessionId: "chat_1" });

    const [ownerStatement, ownerParams] = query.mock.calls[0]!;
    expect(ownerStatement).toContain('from "goat"."chat_sessions"');
    expect(ownerParams).toEqual(expect.arrayContaining(["chat_1", "user_1"]));
    const [insertStatement] = query.mock.calls[1]!;
    expect(insertStatement).toContain("on conflict");
    expect(insertStatement).toContain('"chat_session_id"');
  });

  it("creates an opaque share id for the owned session", async () => {
    const store = createStore();

    await expect(
      ensureGoatChatShareForUser({ userWorkosId: "user_1", chatSessionId: "  chat_1  " }, store),
    ).resolves.toMatchObject({ chatSessionId: "chat_1" });

    expect(store.ensureShare).toHaveBeenCalledWith({
      id: expect.stringMatching(/^goat_chat_share_/),
      userWorkosId: "user_1",
      chatSessionId: "chat_1",
    });
    expect(isGoatChatShareId(vi.mocked(store.ensureShare).mock.calls[0]![0].id)).toBe(true);
  });

  it("rejects malformed public ids before querying storage", async () => {
    const store = createStore();

    await expect(loadPublicGoatChat("../chat_1", store)).resolves.toBeNull();

    expect(store.findShare).not.toHaveBeenCalled();
    expect(isGoatChatShareId(newGoatChatShareId())).toBe(true);
  });

  it("loads a shared transcript without leaking its private session id or blob URL", async () => {
    const attachment: GoatChatMessageAttachment = {
      id: "att_1",
      kind: "image",
      mediaType: "image/png",
      filename: "diagram.png",
      sizeBytes: 42,
      blobUrl: "https://private.example/diagram.png",
      blobPathname: "goat-chat/user_1/diagram.png",
    };
    const store = createStore({
      messages: [
        storedMessage({
          id: "message_1",
          role: "user",
          content: "Take a look.",
          attachments: [attachment],
        }),
        storedMessage({
          id: "message_2",
          role: "assistant",
          content: "Looks good.",
        }),
      ],
    });

    const result = await loadPublicGoatChat(SHARE_ID, store);

    expect(result).toMatchObject({
      shareId: SHARE_ID,
      title: "Architecture review",
      messages: [
        {
          id: "message_1",
          metadata: {
            attachments: [
              {
                id: "att_1",
                filename: "diagram.png",
              },
            ],
          },
        },
        {
          id: "message_2",
        },
      ],
    });
    expect(result?.messages[0]?.metadata?.sessionId).toBeUndefined();
    expect(result?.messages[0]?.metadata?.timing).toBeUndefined();
    expect(result?.messages[1]?.metadata).toBeUndefined();
    expect(result?.messages[0]?.metadata?.attachments?.[0]).not.toHaveProperty("blobUrl");
    expect(store.listMessages).toHaveBeenCalledWith("chat_1");
  });
});

function createStore({ messages = [] }: { messages?: GoatStoredChatMessage[] } = {}) {
  const createdAt = new Date("2026-07-27T10:00:00.000Z");
  const share: GoatChatShare = {
    id: SHARE_ID,
    chatSessionId: "chat_1",
    createdAt,
  };
  const chatSession: GoatChatSession = {
    id: "chat_1",
    userWorkosId: "user_1",
    title: "Architecture review",
    model: DEFAULT_GOAT_MODEL,
    engine: "opencompany",
    closedAt: null,
    pinnedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    ensureShare: vi.fn(async (input) => ({ ...share, id: input.id })),
    findShare: vi.fn(async (shareId) => (shareId === SHARE_ID ? { share, chatSession } : null)),
    listMessages: vi.fn(async () => messages),
  } satisfies GoatChatShareStore;
}

function storedMessage(
  input: Pick<GoatStoredChatMessage, "id" | "role" | "content"> & {
    attachments?: GoatChatMessageAttachment[] | null;
  },
): GoatStoredChatMessage {
  const createdAt = new Date("2026-07-27T10:00:00.000Z");
  return {
    id: input.id,
    sessionId: "chat_1",
    role: input.role,
    content: input.content,
    taskId: null,
    debugTrace: null,
    attachments: input.attachments ?? null,
    attachmentTexts: null,
    createdAt,
    updatedAt: createdAt,
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  };
}

import { describe, expect, it, vi } from "vitest";
import { type ChatResourceStorage, createChatResourceService } from "./chat-resources";

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session" as const,
};
const shareId = "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd";

describe("Chat resource service", () => {
  it("projects a public transcript without session, token, or Blob locators", async () => {
    const db = fakeDb([
      [
        {
          shareId,
          conversationId: "conversation_1",
          title: "Shared Chat",
          kind: "chat",
          engine: "codex",
        },
      ],
      [
        {
          id: "message_1",
          sessionId: "conversation_1",
          role: "user",
          content: "Review this",
          taskId: null,
          debugTrace: { model: "openai/gpt-5", usage: { inputTokens: 321 } },
          attachments: [
            {
              id: "attachment_1",
              kind: "image",
              mediaType: "image/png",
              filename: "diagram.png",
              sizeBytes: 42,
              blobPathname: "private/pathname",
              blobUrl: "https://private.example.test/token",
            },
          ],
          attachmentTexts: null,
          createdAt: new Date("2026-08-13T10:00:00.000Z"),
          updatedAt: new Date("2026-08-13T10:00:00.000Z"),
          taskDisplayId: null,
          taskName: null,
          taskPrompt: null,
          taskStatus: null,
        },
      ],
    ]);
    const service = createChatResourceService({ db, storage: fakeStorage() });

    const share = await service.loadPublicShare(shareId);

    expect(share).toMatchObject({
      shareId,
      engine: "codex",
      messages: [{ id: "message_1", role: "user" }],
    });
    expect(JSON.stringify(share)).not.toMatch(
      /conversation_1|sessionId|contextTokens|blobPathname|blobUrl|private\.example|token/iu,
    );
  });

  it("returns the existing share when an idempotent create loses the insert race", async () => {
    const db = fakeDb([[{ id: "conversation_1" }], [{ id: shareId }]]);
    const service = createChatResourceService({
      db,
      id: () => "goat_chat_share_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      storage: fakeStorage(),
    });

    await expect(service.ensureShare(actor, "conversation_1")).resolves.toBe(shareId);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("makes repeated artifact deletion safe after the tombstone wins", async () => {
    const db = fakeDb([
      [
        {
          id: "artifact_1",
          chatSessionId: "conversation_1",
          archivedAt: new Date("2026-08-13T10:00:00.000Z"),
        },
      ],
    ]);
    const storage = fakeStorage();
    const service = createChatResourceService({ db, storage });

    await expect(service.deleteArtifact(actor, "artifact_1")).resolves.toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("streams only the selected attachment while keeping its locator server-side", async () => {
    const db = fakeDb([
      [
        {
          attachments: [
            {
              id: "attachment_1",
              kind: "image",
              mediaType: "image/png",
              filename: "diagram.png",
              sizeBytes: 3,
              blobPathname: "private/pathname",
              blobUrl: "https://private.example.test/blob-token",
            },
          ],
        },
      ],
    ]);
    const storage = fakeStorage();
    const service = createChatResourceService({ db, storage });

    const download = await service.downloadAttachment({
      actor,
      messageId: "message_1",
      attachmentId: "attachment_1",
    });

    expect(storage.get).toHaveBeenCalledWith("https://private.example.test/blob-token");
    expect(download).toMatchObject({
      mediaType: "image/png",
      filename: "diagram.png",
      sizeBytes: 3,
      inline: true,
    });
    expect(download).not.toHaveProperty("blobUrl");
    expect(download).not.toHaveProperty("blobPathname");
  });
});

function fakeStorage(): ChatResourceStorage & {
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => new Response("abc").body as ReadableStream<Uint8Array>),
    delete: vi.fn(async () => undefined),
  };
}

function fakeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  return {
    select: vi.fn(() => queryBuilder(queue.shift() ?? [])),
    insert: vi.fn(() => queryBuilder([])),
    delete: vi.fn(() => queryBuilder([])),
    update: vi.fn(() => queryBuilder([])),
    execute: vi.fn(async () => undefined),
  };
}

function queryBuilder(rows: unknown[]) {
  let builder: Record<string, unknown>;
  builder = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === "limit" || property === "orderBy") {
          return async () => rows;
        }
        return () => builder;
      },
    },
  );
  return builder;
}

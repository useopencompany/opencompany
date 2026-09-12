import { ChatShareIdSchema } from "@opencompany/protocol";
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
  it("creates a readable share capability while preserving an existing share", async () => {
    const db = fakeDb([[{ id: "conversation_1" }], [{ id: shareId }]]);
    const values = vi.fn((_row: { id: string; chatSessionId: string }) => ({
      onConflictDoNothing: vi.fn(),
    }));
    db.insert.mockReturnValue({ values });
    const service = createChatResourceService({ db, storage: fakeStorage() });

    await expect(service.ensureShare(actor, "conversation_1")).resolves.toBe(shareId);
    expect(values).toHaveBeenCalledWith({
      id: expect.stringMatching(/^share_/u),
      chatSessionId: "conversation_1",
    });
    expect(ChatShareIdSchema.safeParse(values.mock.calls[0]?.[0]?.id).success).toBe(true);
  });

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

  it("lists authorized immutable artifact versions newest first without blob locators", async () => {
    const db = fakeDb([
      [{ id: "artifact_1", currentVersion: 2 }],
      [
        {
          artifactVersionId: "version_2",
          version: 2,
          title: "Report",
          description: "Revised report",
          filename: "report.md",
          mediaType: "text/markdown",
          sizeBytes: 16,
          createdAt: new Date("2026-09-05T10:00:00.000Z"),
        },
        {
          artifactVersionId: "version_1",
          version: 1,
          title: "Report",
          description: null,
          filename: "report.md",
          mediaType: "text/markdown",
          sizeBytes: 8,
          createdAt: new Date("2026-09-05T09:00:00.000Z"),
        },
      ],
    ]);
    const service = createChatResourceService({ db, storage: fakeStorage() });

    const result = await service.listArtifactVersions(actor, "artifact_1");

    expect(result).toEqual({
      artifactId: "artifact_1",
      currentVersion: 2,
      versions: [
        expect.objectContaining({ artifactVersionId: "version_2", version: 2 }),
        expect.objectContaining({ artifactVersionId: "version_1", version: 1 }),
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/blob|pathname|sha256/iu);
  });

  it("serves an HTML artifact inline under the hardened, egress-blocked policy", async () => {
    const db = fakeDb([
      [
        {
          version: {
            blobPathname: "private/pathname",
            filename: "pricing-model.html",
            mediaType: "text/html",
            sizeBytes: 24,
          },
        },
      ],
    ]);
    const service = createChatResourceService({ db, storage: fakeStorage() });

    const download = await service.downloadArtifact({
      actor,
      artifactId: "artifact_1",
      versionId: "version_1",
      download: false,
    });

    expect(download).toMatchObject({ mediaType: "text/html; charset=utf-8", inline: true });
    expect(download.contentSecurityPolicy).toContain("sandbox allow-scripts");
    expect(download.contentSecurityPolicy).toContain("default-src 'none'");
    expect(download.contentSecurityPolicy).not.toContain("allow-same-origin");
  });

  it("keeps the HTML artifact policy on an explicit download", async () => {
    const db = fakeDb([
      [
        {
          version: {
            blobPathname: "private/pathname",
            filename: "pricing-model.html",
            mediaType: "text/html",
            sizeBytes: 24,
          },
        },
      ],
    ]);
    const service = createChatResourceService({ db, storage: fakeStorage() });

    const download = await service.downloadArtifact({
      actor,
      artifactId: "artifact_1",
      versionId: "version_1",
      download: true,
    });

    expect(download.inline).toBe(false);
    expect(download.contentSecurityPolicy).toContain("sandbox allow-scripts");
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

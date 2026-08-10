import type { Actor } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { createAttachmentUploadService } from "./attachments";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session",
};

describe("attachment upload service", () => {
  it("stores private bytes and persists only actor-scoped registry metadata", async () => {
    const create = vi.fn(async (input) => ({
      id: input.id,
      format: input.format,
      mediaType: input.mediaType,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt,
    }));
    const put = vi.fn(async () => ({
      pathname: "goat-chat-v1/user_1/attachment_1/notes.txt-random",
      url: "https://private.invalid/notes.txt",
    }));
    const service = createAttachmentUploadService({
      repository: { create },
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
      id: () => "attachment_1",
    });
    const result = await service.upload({
      actor,
      file: new File(["private notes"], "notes.txt", { type: "text/plain" }),
    });
    expect(result).toMatchObject({ id: "attachment_1", format: "text" });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "goat-chat-v1/user_1/attachment_1/notes.txt",
        mediaType: "text/plain",
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        id: "attachment_1",
        extractedText: "private notes",
        blobPathname: expect.stringContaining("goat-chat-v1/user_1/"),
        expiresAt: new Date("2026-08-11T20:00:00.000Z"),
      }),
    );
  });

  it("cleans up the blob if persistence loses workspace authorization", async () => {
    const remove = vi.fn(async () => undefined);
    const service = createAttachmentUploadService({
      repository: { create: vi.fn(async () => null) },
      storage: {
        put: vi.fn(async () => ({ pathname: "private/path", url: "https://private.invalid/file" })),
        delete: remove,
      },
      id: () => "attachment_1",
    });
    await expect(
      service.upload({
        actor,
        file: new File(["notes"], "notes.txt", { type: "text/plain" }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(remove).toHaveBeenCalledOnce();
  });
});

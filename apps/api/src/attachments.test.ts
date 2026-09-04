import type { Actor } from "@opencompany/core";
import type {
  ChatAttachmentUpload,
  ChatAttachmentUploadReservation,
  CompleteChatAttachmentUploadInput,
  CreateChatAttachmentUploadInput,
} from "@opencompany/db/chat-repository";
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
      repository: unkeyedRepository(create),
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
        deterministic: false,
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
      repository: unkeyedRepository(vi.fn(async () => null)),
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

  it("returns a stable completed replay without writing Blob twice", async () => {
    const repository = keyedRepository();
    const put = vi.fn(async (input) => ({
      pathname: input.pathname,
      url: "https://private.invalid/content",
    }));
    const service = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    const request = {
      actor,
      idempotencyKey: "web-chat-attachment:pending-1",
      file: new File(["private notes"], " notes.txt ", { type: "text/plain" }),
    };

    const first = await service.upload(request);
    const replay = await service.upload(request);

    expect(first).toMatchObject({ replayed: false, filename: "notes.txt" });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: `goat-chat-v1/user_1/${first.id}/content`,
        deterministic: true,
      }),
    );
  });

  it.each([
    ["different bytes", new File(["other"], "notes.txt", { type: "text/plain" })],
    ["different filename", new File(["same"], "other.txt", { type: "text/plain" })],
    ["different media type", new File(["same"], "notes.csv", { type: "text/csv" })],
  ])("rejects %s for an existing key before Blob", async (_label, conflictingFile) => {
    const repository = keyedRepository();
    const put = vi.fn(async (input) => ({
      pathname: input.pathname,
      url: "https://private.invalid/content",
    }));
    const service = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    await service.upload({
      actor,
      idempotencyKey: "same-key",
      file: new File(["same"], "notes.txt", { type: "text/plain" }),
    });
    put.mockClear();

    await expect(
      service.upload({ actor, idempotencyKey: "same-key", file: conflictingFile }),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(put).not.toHaveBeenCalled();
  });

  it("resumes the same reservation after Blob and database failures", async () => {
    const repository = keyedRepository({ failFirstCompletion: true });
    const put = vi.fn(async (input) => ({
      pathname: input.pathname,
      url: "https://private.invalid/content",
    }));
    const service = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    const request = {
      actor,
      idempotencyKey: "resume-key",
      file: new File(["same"], "notes.txt", { type: "text/plain" }),
    };

    await expect(service.upload(request)).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
    });
    await expect(service.upload(request)).resolves.toMatchObject({ replayed: false });
    expect(repository.reserve).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.[0].pathname).toBe(put.mock.calls[1]?.[0].pathname);
  });

  it("resumes the same reservation after a Blob failure", async () => {
    const repository = keyedRepository();
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockImplementation(async (input) => ({
        pathname: input.pathname,
        url: "https://private.invalid/content",
      }));
    const service = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    const request = {
      actor,
      idempotencyKey: "blob-resume-key",
      file: new File(["same"], "notes.txt", { type: "text/plain" }),
    };

    await expect(service.upload(request)).rejects.toMatchObject({ status: 503 });
    await expect(service.upload(request)).resolves.toMatchObject({ replayed: false });
    expect(repository.reserve).toHaveBeenCalledTimes(2);
  });

  it("converges concurrent identical requests on one attachment and pathname", async () => {
    const repository = keyedRepository();
    const put = vi.fn(async (input) => ({
      pathname: input.pathname,
      url: "https://private.invalid/content",
    }));
    const service = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    const request = {
      actor,
      idempotencyKey: "race-key",
      file: new File(["same"], "notes.txt", { type: "text/plain" }),
    };

    const results = await Promise.all([service.upload(request), service.upload(request)]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.[0].pathname).toBe(put.mock.calls[1]?.[0].pathname);
  });

  it("rejects a cleaned reservation without touching Blob", async () => {
    const put = vi.fn(async (input) => ({
      pathname: input.pathname,
      url: "https://private.invalid/content",
    }));
    const file = new File(["same"], "notes.txt", { type: "text/plain" });
    const initial = keyedRepository();
    const service = createAttachmentUploadService({
      repository: initial,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    await service.upload({ actor, idempotencyKey: "cleaned-key", file });
    initial.clean();
    put.mockClear();

    await expect(
      service.upload({ actor, idempotencyKey: "cleaned-key", file }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an expired completed reservation without touching Blob", async () => {
    const repository = keyedRepository();
    const put = vi.fn(async (input) => ({
      pathname: input.pathname,
      url: "https://private.invalid/content",
    }));
    const file = new File(["same"], "notes.txt", { type: "text/plain" });
    const first = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-10T20:00:00.000Z"),
    });
    await first.upload({ actor, idempotencyKey: "expired-key", file });
    put.mockClear();
    const afterExpiry = createAttachmentUploadService({
      repository,
      storage: { put, delete: vi.fn() },
      now: () => new Date("2026-08-12T20:00:00.000Z"),
    });

    await expect(
      afterExpiry.upload({ actor, idempotencyKey: "expired-key", file }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(put).not.toHaveBeenCalled();
  });
});

function unkeyedRepository(
  create: (input: CreateChatAttachmentUploadInput) => Promise<ChatAttachmentUpload | null>,
) {
  return {
    create,
    reserve: vi.fn(() => Promise.reject(new Error("Unexpected keyed reservation."))),
    findCompleted: vi.fn(() => Promise.reject(new Error("Unexpected keyed lookup."))),
    complete: vi.fn(() => Promise.reject(new Error("Unexpected keyed completion."))),
  };
}

function keyedRepository(options: { failFirstCompletion?: boolean } = {}) {
  let reservation: ChatAttachmentUploadReservation | null = null;
  let upload: ChatAttachmentUpload | null = null;
  let failCompletion = options.failFirstCompletion ?? false;
  const reserve = vi.fn(async (input) => {
    reservation ??= {
      commandId: input.commandId,
      requestHash: input.requestHash,
      attachmentId: input.attachmentId,
      blobPathname: input.blobPathname,
      expiresAt: input.expiresAt,
      completedAt: null,
      cleanedAt: null,
    };
    return reservation;
  });
  const complete = vi.fn(async (input: CompleteChatAttachmentUploadInput) => {
    if (failCompletion) {
      failCompletion = false;
      throw new Error("database unavailable");
    }
    if (!reservation) throw new Error("Expected a reservation.");
    const created = !upload;
    upload ??= {
      id: reservation.attachmentId,
      format: input.format,
      mediaType: input.mediaType,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      expiresAt: reservation.expiresAt,
    };
    reservation = { ...reservation, completedAt: new Date("2026-08-10T20:00:00.000Z") };
    return { ...upload, created };
  });
  return {
    create: vi.fn(() => Promise.reject(new Error("Unexpected unkeyed upload."))),
    reserve,
    findCompleted: vi.fn(async () => upload),
    complete,
    clean() {
      if (!reservation) throw new Error("Expected a reservation.");
      reservation = { ...reservation, cleanedAt: new Date("2026-08-12T00:00:00.000Z") };
      upload = null;
    },
  };
}

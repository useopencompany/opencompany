import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const hydrationMocks = vi.hoisted(() => ({
  downloadBlobBytes: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));
vi.mock("./attachment-hydration", () => ({
  downloadBlobBytes: hydrationMocks.downloadBlobBytes,
}));

import {
  buildGoatTaskUserModelMessage,
  formatGoatTaskAttachmentManifest,
  materializeGoatTaskAttachmentsForCodex,
} from "./goat-attachments";

const attachmentRows = [
  {
    id: "att_1",
    kind: "image" as const,
    mediaType: "image/png",
    filename: "screenshot.png",
    sizeBytes: 9,
    blobPathname: "goat/users/user_1/pending/att_1-screenshot.png",
    blobUrl: "https://blob.example/screenshot.png",
  },
];

function createAttachmentDb(rows = attachmentRows) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

function createSandbox() {
  return {
    commands: {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    },
    files: {
      write: vi.fn(async () => undefined),
    },
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("Goat task attachments", () => {
  it("materializes task attachments for Codex and formats a manifest", async () => {
    dbMocks.getDb.mockReturnValue(createAttachmentDb());
    hydrationMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("png-bytes"));
    const sandbox = createSandbox();

    const materialized = await materializeGoatTaskAttachmentsForCodex({
      sandbox: sandbox as never,
      taskId: "task_1",
      userWorkosId: "user_1",
      workdir: "/home/user/opencompany-goat/codex",
      blobToken: "blob-token",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(expect.stringContaining("work/attachments"), {
      timeoutMs: 30_000,
    });
    expect(hydrationMocks.downloadBlobBytes).toHaveBeenCalledWith(
      "https://blob.example/screenshot.png",
      "blob-token",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/opencompany-goat/codex/work/attachments/att_1-screenshot.png",
      expect.any(ArrayBuffer),
    );
    expect(formatGoatTaskAttachmentManifest(materialized)).toContain(
      "screenshot.png (image/png, 9 B, image) -> work/attachments/att_1-screenshot.png",
    );
  });

  it("adds image attachments to the regular Goat user model message", async () => {
    dbMocks.getDb.mockReturnValue(createAttachmentDb());
    hydrationMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("png-bytes"));

    const message = await buildGoatTaskUserModelMessage({
      taskId: "task_1",
      userWorkosId: "user_1",
      prompt: "Inspect this screenshot",
      blobToken: undefined,
    });

    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Inspect this screenshot" },
        {
          type: "image",
          image: Buffer.from("png-bytes").toString("base64"),
          mediaType: "image/png",
        },
      ],
    });
  });
});

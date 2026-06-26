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

import { materializeCodexAttachmentsForSession } from "./codex-attachment-materialize";

type AttachmentRow = {
  blobPathname: string;
  blobUrl: string;
  filename: string;
  kind: string;
  mediaType: string;
};

function createAttachmentDb(rows: AttachmentRow[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

function createSandbox(existingFiles: string[] = []) {
  return {
    commands: {
      run: vi.fn(async (command: string) =>
        command.startsWith("ls ")
          ? { stdout: existingFiles.join("\n"), stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 },
      ),
    },
    files: {
      write: vi.fn(async () => undefined),
    },
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("materializeCodexAttachmentsForSession", () => {
  it("downloads Codex attachments and writes them under codex/work/attachments", async () => {
    dbMocks.getDb.mockReturnValue(
      createAttachmentDb([
        {
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_1-screenshot.png",
          blobUrl: "https://blob.example/att_1-screenshot.png",
          filename: "screenshot.png",
          kind: "image",
          mediaType: "image/png",
        },
      ]),
    );
    hydrationMocks.downloadBlobBytes.mockResolvedValue(Buffer.from([1, 2, 3]));
    const sandbox = createSandbox();

    const attachments = await materializeCodexAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
      blobToken: "tok_test",
    });

    const setupCommand = sandbox.commands.run.mock.calls[0]?.[0] as string;
    expect(setupCommand).toContain("mkdir -p '/home/user/workspace/codex/work/attachments'");
    expect(setupCommand).toContain(".gitignore");
    expect(hydrationMocks.downloadBlobBytes).toHaveBeenCalledWith(
      "https://blob.example/att_1-screenshot.png",
      "tok_test",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith([
      expect.objectContaining({
        path: "/home/user/workspace/codex/work/attachments/att_1-screenshot.png",
      }),
    ]);
    expect(attachments).toEqual([
      {
        filename: "screenshot.png",
        kind: "image",
        mediaType: "image/png",
        path: "work/attachments/att_1-screenshot.png",
      },
    ]);
  });

  it("skips files already present in the Codex attachment directory", async () => {
    dbMocks.getDb.mockReturnValue(
      createAttachmentDb([
        {
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_1-existing.pdf",
          blobUrl: "https://blob.example/att_1-existing.pdf",
          filename: "existing.pdf",
          kind: "pdf",
          mediaType: "application/pdf",
        },
      ]),
    );
    const sandbox = createSandbox(["att_1-existing.pdf", ".gitignore"]);

    const attachments = await materializeCodexAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      messageId: "msg_1",
      workdir: "/home/user/workspace",
      blobToken: undefined,
    });

    expect(hydrationMocks.downloadBlobBytes).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
    expect(attachments).toEqual([
      {
        filename: "existing.pdf",
        kind: "pdf",
        mediaType: "application/pdf",
        path: "work/attachments/att_1-existing.pdf",
      },
    ]);
  });
});

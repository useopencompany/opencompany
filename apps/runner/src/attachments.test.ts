import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

import { materializePastedAttachmentsForSession } from "./attachments";

type AttachmentRow = {
  attachments:
    | { id: string; filename: string; label: string; bytes: number; lineCount: number; content: string }[]
    | null;
};

function createDb(rows: AttachmentRow[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

function createSandbox() {
  return {
    commands: { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }) },
    files: { write: vi.fn().mockResolvedValue(undefined) },
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("materializePastedAttachmentsForSession", () => {
  it("writes each attachment under work/pasted and gitignores the folder", async () => {
    dbMocks.getDb.mockReturnValue(
      createDb([
        {
          attachments: [
            {
              id: "att_1",
              filename: "pasted/msg_1-0.txt",
              label: "doc",
              bytes: 5,
              lineCount: 1,
              content: "hello",
            },
          ],
        },
      ]),
    );
    const sandbox = createSandbox();

    await materializePastedAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/pasted/msg_1-0.txt",
      "hello",
    );
    // .gitignore is touched and the pasted/ entry added.
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining(".gitignore"),
      expect.anything(),
    );
  });

  it("does nothing when no message carries attachments", async () => {
    dbMocks.getDb.mockReturnValue(createDb([{ attachments: null }]));
    const sandbox = createSandbox();

    await materializePastedAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.write).not.toHaveBeenCalled();
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("skips attachments whose filename escapes the pasted directory", async () => {
    dbMocks.getDb.mockReturnValue(
      createDb([
        {
          attachments: [
            {
              id: "att_evil",
              filename: "pasted/../../etc/passwd",
              label: "evil",
              bytes: 1,
              lineCount: 1,
              content: "x",
            },
          ],
        },
      ]),
    );
    const sandbox = createSandbox();

    await materializePastedAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
    });

    expect(sandbox.files.write).not.toHaveBeenCalled();
  });
});

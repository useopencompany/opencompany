import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const hydrationMocks = vi.hoisted(() => ({
  downloadBlobBytes: vi.fn(),
}));
const observabilityMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  logger: { warn: vi.fn() },
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));
vi.mock("./attachment-hydration", () => ({
  downloadBlobBytes: hydrationMocks.downloadBlobBytes,
}));
vi.mock("@opencompany/observability", () => ({
  captureException: observabilityMocks.captureException,
  createLogger: vi.fn(() => observabilityMocks.logger),
}));

import { materializeLargeTextAttachmentsForSession } from "./attachment-materialize";

function createAttachmentDb(rows: Array<{ id: string; blobPathname: string; blobUrl: string }>) {
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

describe("materializeLargeTextAttachmentsForSession", () => {
  it("downloads above-threshold text attachments and writes them under work/attachments", async () => {
    dbMocks.getDb.mockReturnValue(
      createAttachmentDb([
        {
          id: "att_1",
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_1-server.log",
          blobUrl: "https://blob.example/att_1-server.log",
        },
      ]),
    );
    hydrationMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("log line\n"));
    const sandbox = createSandbox();

    await materializeLargeTextAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
      blobToken: "tok_test",
    });

    // Directory prepared with a self-ignoring .gitignore.
    const setupCommand = sandbox.commands.run.mock.calls[0]?.[0] as string;
    expect(setupCommand).toContain("mkdir -p '/home/user/workspace/work/attachments'");
    expect(setupCommand).toContain(".gitignore");
    expect(hydrationMocks.downloadBlobBytes).toHaveBeenCalledWith(
      "https://blob.example/att_1-server.log",
      "tok_test",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/attachments/att_1-server.log",
      "log line\n",
    );
  });

  it("skips files that already exist in the sandbox (immutable rows, cheap re-acquire)", async () => {
    dbMocks.getDb.mockReturnValue(
      createAttachmentDb([
        {
          id: "att_1",
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_1-server.log",
          blobUrl: "https://blob.example/att_1-server.log",
        },
        {
          id: "att_2",
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_2-notes.md",
          blobUrl: "https://blob.example/att_2-notes.md",
        },
      ]),
    );
    hydrationMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("notes"));
    const sandbox = createSandbox(["att_1-server.log", ".gitignore"]);

    await materializeLargeTextAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
      blobToken: undefined,
    });

    expect(hydrationMocks.downloadBlobBytes).toHaveBeenCalledTimes(1);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/attachments/att_2-notes.md",
      "notes",
    );
  });

  it("does not touch the sandbox when the session has no above-threshold text attachments", async () => {
    dbMocks.getDb.mockReturnValue(createAttachmentDb([]));
    const sandbox = createSandbox();

    await materializeLargeTextAttachmentsForSession({
      sandbox: sandbox as never,
      sessionId: "ses_1",
      workdir: "/home/user/workspace",
      blobToken: undefined,
    });

    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });

  it("never throws: a failed download is reported and the rest still materialize", async () => {
    dbMocks.getDb.mockReturnValue(
      createAttachmentDb([
        {
          id: "att_1",
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_1-broken.txt",
          blobUrl: "https://blob.example/att_1-broken.txt",
        },
        {
          id: "att_2",
          blobPathname: "workspace/wsp_1/sessions/ses_1/att_2-fine.txt",
          blobUrl: "https://blob.example/att_2-fine.txt",
        },
      ]),
    );
    hydrationMocks.downloadBlobBytes
      .mockRejectedValueOnce(new Error("blob gone"))
      .mockResolvedValueOnce(Buffer.from("fine"));
    const sandbox = createSandbox();

    await expect(
      materializeLargeTextAttachmentsForSession({
        sandbox: sandbox as never,
        sessionId: "ses_1",
        workdir: "/home/user/workspace",
        blobToken: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(observabilityMocks.captureException).toHaveBeenCalledTimes(1);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/workspace/work/attachments/att_2-fine.txt",
      "fine",
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  CodingWorkspaceFileError,
  decodeUtf8Text,
  listCodingWorkspaceDirectory,
  MAX_EDITABLE_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  normalizeWorkspaceRelativePath,
  readCodingWorkspaceFile,
  writeCodingWorkspaceFile,
} from "./coding-workspace-files";
import type { SandboxHandle } from "./sandbox";

const WORK_DIRECTORY = "/home/user/opencompany-goat/claude-chat";

function fakeSandbox(overrides: {
  realPath?: (requested: string) => { stdout: string; exitCode: number };
  getInfo?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  read?: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
}) {
  const run = vi.fn(async (command: string) => {
    const requested = command.replace(/^realpath -e -- '/, "").replace(/'$/, "");
    return overrides.realPath?.(requested) ?? { stdout: `${requested}\n`, exitCode: 0 };
  });
  return {
    sandbox: {
      commands: { run },
      files: {
        getInfo: overrides.getInfo ?? vi.fn(),
        list: overrides.list ?? vi.fn(),
        read: overrides.read ?? vi.fn(),
        write: overrides.write ?? vi.fn(async () => undefined),
      },
    } as unknown as SandboxHandle,
    run,
  };
}

describe("normalizeWorkspaceRelativePath", () => {
  it("treats the empty, dot, and slash forms as the workspace root", () => {
    for (const value of ["", "  ", ".", "/"]) {
      expect(normalizeWorkspaceRelativePath(value)).toBe("");
    }
  });

  it("normalizes nested paths and strips trailing slashes", () => {
    expect(normalizeWorkspaceRelativePath("apps/web/")).toBe("apps/web");
    expect(normalizeWorkspaceRelativePath("apps/./web/page.tsx")).toBe("apps/web/page.tsx");
    expect(normalizeWorkspaceRelativePath("apps/api/../web")).toBe("apps/web");
  });

  it("rejects absolute paths, traversal, and non-strings", () => {
    for (const value of ["/etc/passwd", "../secrets", "apps/../../etc", "..", "a\0b", 7, null]) {
      expect(() => normalizeWorkspaceRelativePath(value)).toThrow(CodingWorkspaceFileError);
    }
  });
});

describe("listCodingWorkspaceDirectory", () => {
  it("sorts directories first, then naturally, and namespaces child paths", async () => {
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "dir" })),
      list: vi.fn(async () => [
        { name: "readme.md", type: "file", size: 12 },
        { name: "item10.ts", type: "file", size: 3 },
        { name: "item2.ts", type: "file", size: 3 },
        { name: "web", type: "dir", size: 0 },
        { name: "api", type: "dir", size: 0 },
        { name: "link", type: "symlink", size: 5 },
      ]),
    });

    const listing = await listCodingWorkspaceDirectory(sandbox, {
      workDirectory: WORK_DIRECTORY,
      relativePath: "apps",
    });

    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "api",
      "web",
      "item2.ts",
      "item10.ts",
      "link",
      "readme.md",
    ]);
    expect(listing.entries[0]).toMatchObject({ path: "apps/api", type: "directory" });
    expect(listing.entries.find((entry) => entry.name === "link")).toMatchObject({
      type: "file",
      symlink: true,
    });
    expect(listing.truncated).toBe(false);
  });

  it("refuses a path that resolves outside the working directory", async () => {
    const { sandbox } = fakeSandbox({
      realPath: () => ({ stdout: "/etc/ssh\n", exitCode: 0 }),
      getInfo: vi.fn(async () => ({ type: "dir" })),
    });

    await expect(
      listCodingWorkspaceDirectory(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "escape-link",
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("reports a missing path instead of listing it", async () => {
    const { sandbox } = fakeSandbox({ realPath: () => ({ stdout: "", exitCode: 1 }) });
    await expect(
      listCodingWorkspaceDirectory(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "gone",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("readCodingWorkspaceFile", () => {
  it("returns editable text with a content revision", async () => {
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: 5 })),
      read: vi.fn(async () => new TextEncoder().encode("hello")),
    });

    const file = await readCodingWorkspaceFile(sandbox, {
      workDirectory: WORK_DIRECTORY,
      relativePath: "notes.txt",
    });

    expect(file).toMatchObject({ kind: "text", content: "hello", editable: true, size: 5 });
  });

  it("marks text past the editable limit as read-only", async () => {
    const content = "a".repeat(MAX_EDITABLE_FILE_BYTES + 1);
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: content.length })),
      read: vi.fn(async () => new TextEncoder().encode(content)),
    });

    const file = await readCodingWorkspaceFile(sandbox, {
      workDirectory: WORK_DIRECTORY,
      relativePath: "big.txt",
    });

    expect(file).toMatchObject({ kind: "text", editable: false });
  });

  it("reports binary content instead of mangling it", async () => {
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: 4 })),
      read: vi.fn(async () => new Uint8Array([0x7f, 0x45, 0x00, 0x4c])),
    });

    expect(
      await readCodingWorkspaceFile(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "a.out",
      }),
    ).toMatchObject({ kind: "binary", size: 4 });
  });

  it("inlines images as a data URL", async () => {
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: 3 })),
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    });

    expect(
      await readCodingWorkspaceFile(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "public/logo.png",
      }),
    ).toMatchObject({ kind: "image", dataUrl: "data:image/png;base64,AQID" });
  });

  it("skips reading files past the text limit", async () => {
    const read = vi.fn();
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: MAX_TEXT_FILE_BYTES + 1 })),
      read,
    });

    expect(
      await readCodingWorkspaceFile(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "huge.log",
      }),
    ).toMatchObject({ kind: "too_large" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses to open a directory as a file", async () => {
    const { sandbox } = fakeSandbox({ getInfo: vi.fn(async () => ({ type: "dir" })) });
    await expect(
      readCodingWorkspaceFile(sandbox, { workDirectory: WORK_DIRECTORY, relativePath: "apps" }),
    ).rejects.toMatchObject({ code: "not_a_file" });
  });
});

describe("writeCodingWorkspaceFile", () => {
  const revisionOfHello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  it("writes when the file still matches the revision the edit was based on", async () => {
    const write = vi.fn(async () => undefined);
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: 5 })),
      read: vi.fn(async () => new TextEncoder().encode("hello")),
      write,
    });

    const saved = await writeCodingWorkspaceFile(sandbox, {
      workDirectory: WORK_DIRECTORY,
      relativePath: "notes.txt",
      content: "hello there",
      baseRevision: revisionOfHello,
    });

    expect(write).toHaveBeenCalledWith(`${WORK_DIRECTORY}/notes.txt`, "hello there", {
      user: "user",
    });
    expect(saved).toMatchObject({ path: "notes.txt", size: 11 });
  });

  it("refuses to clobber an edit the agent made after the file was opened", async () => {
    const write = vi.fn(async () => undefined);
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: 7 })),
      read: vi.fn(async () => new TextEncoder().encode("changed")),
      write,
    });

    await expect(
      writeCodingWorkspaceFile(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "notes.txt",
        content: "mine",
        baseRevision: revisionOfHello,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(write).not.toHaveBeenCalled();
  });

  it("overwrites without a revision check when the user chooses to", async () => {
    const read = vi.fn();
    const write = vi.fn(async () => undefined);
    const { sandbox } = fakeSandbox({
      getInfo: vi.fn(async () => ({ type: "file", size: 7 })),
      read,
      write,
    });

    await writeCodingWorkspaceFile(sandbox, {
      workDirectory: WORK_DIRECTORY,
      relativePath: "notes.txt",
      content: "mine",
      baseRevision: null,
    });

    expect(read).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
  });

  it("rejects a document past the editable limit before touching the sandbox", async () => {
    const write = vi.fn(async () => undefined);
    const { sandbox, run } = fakeSandbox({ write });

    await expect(
      writeCodingWorkspaceFile(sandbox, {
        workDirectory: WORK_DIRECTORY,
        relativePath: "notes.txt",
        content: "a".repeat(MAX_EDITABLE_FILE_BYTES + 1),
        baseRevision: null,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("decodeUtf8Text", () => {
  it("accepts UTF-8 and rejects NUL bytes and invalid sequences", () => {
    expect(decodeUtf8Text(Buffer.from("héllo — ok", "utf8"))).toBe("héllo — ok");
    expect(decodeUtf8Text(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeUtf8Text(Buffer.from([0xff, 0xfe, 0xfd]))).toBeNull();
  });
});

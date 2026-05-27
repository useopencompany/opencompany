// Regression tests for the edit_file error-message and validation-feedback
// improvements. Each test covers one new behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const e2bMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  create: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("e2b", () => ({
  Sandbox: e2bMocks,
}));

import { runSandboxTool } from "./sandbox";

afterEach(() => {
  vi.resetAllMocks();
});

function makeSandbox(initial: string) {
  return {
    files: {
      read: vi.fn().mockResolvedValue(initial),
      write: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const WORKDIR = "/home/user/workspace";

describe("edit_file error-message regressions", () => {
  it("identifies a null edit by index", async () => {
    const sandbox = makeSandbox("hello");
    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: WORKDIR,
        name: "edit_file",
        args: { path: "work/file.txt", instructions: ".", edits: [null] },
      }),
    ).rejects.toThrow(/Edit 1 must be an object/);
  });

  it("identifies a non-string newString by edit index", async () => {
    const sandbox = makeSandbox("hello");
    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: WORKDIR,
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: ".",
          edits: [{ oldString: "hello", newString: 42 }],
        },
      }),
    ).rejects.toThrow(/Edit 1 newString must be a string/);
  });

  it("hints at prior-edit cascade when ambiguity hits a non-first edit", async () => {
    const sandbox = makeSandbox("abc");
    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: WORKDIR,
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: ".",
          edits: [
            { oldString: "abc", newString: "abcabc" },
            { oldString: "abc", newString: "X" },
          ],
        },
      }),
    ).rejects.toThrow(/previous edit may have created/);
  });

  it("hints at CRLF when a match fails on a CRLF file with an LF-only oldString", async () => {
    const sandbox = makeSandbox("line1\r\nline2\r\n");
    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: WORKDIR,
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: ".",
          edits: [{ oldString: "line1\nline2", newString: "REPLACED" }],
        },
      }),
    ).rejects.toThrow(/CRLF/);
  });

  it("distinguishes 'edits cancel each other' from a single no-op edit", async () => {
    const sandbox = makeSandbox("foo");
    await expect(
      runSandboxTool({
        sandbox: sandbox as never,
        workdir: WORKDIR,
        name: "edit_file",
        args: {
          path: "work/file.txt",
          instructions: ".",
          edits: [
            { oldString: "foo", newString: "bar" },
            { oldString: "bar", newString: "foo" },
          ],
        },
      }),
    ).rejects.toThrow(/cancel each other/);
  });
});

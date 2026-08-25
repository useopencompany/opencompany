import { describe, expect, test } from "vitest";
import {
  assertSafeRelativePath,
  executableBitForBlobMode,
  isSafeRelativePath,
  isSubmodule,
  isSymlinkMode,
  PathSafetyError,
} from "./path-safety";

describe("assertSafeRelativePath", () => {
  const safe = ["SKILL.md", "references/notes.md", "scripts/run.sh", "a/b/c/d.txt", ".hidden"];
  for (const path of safe) {
    test(`accepts ${path}`, () => {
      expect(() => assertSafeRelativePath(path)).not.toThrow();
      expect(isSafeRelativePath(path)).toBe(true);
    });
  }

  type Rejection = { label: string; path: string; match: RegExp };
  const rejections: Rejection[] = [
    { label: "empty", path: "", match: /Empty path/ },
    { label: "absolute posix", path: "/etc/passwd", match: /Absolute/ },
    { label: "windows drive", path: "C:/x", match: /Windows drive/ },
    { label: "backslash", path: "a\\b", match: /Backslash/ },
    { label: "parent traversal", path: "a/../../etc", match: /traversal/ },
    { label: "leading dot-dot", path: "../escape", match: /traversal/ },
    { label: "single dot segment", path: "a/./b", match: /traversal/ },
    { label: "dot-git segment", path: "a/.git/config", match: /`\.git`/ },
    { label: "dot-git at root", path: ".git", match: /`\.git`/ },
    { label: "double slash", path: "a//b", match: /empty segment/ },
    { label: "trailing slash", path: "a/", match: /empty segment/ },
    { label: "control character", path: "a\u0000b", match: /control character/ },
  ];
  for (const testCase of rejections) {
    test(`rejects ${testCase.label}`, () => {
      expect(() => assertSafeRelativePath(testCase.path)).toThrow(PathSafetyError);
      expect(() => assertSafeRelativePath(testCase.path)).toThrow(testCase.match);
      expect(isSafeRelativePath(testCase.path)).toBe(false);
    });
  }

  test("rejects an over-length path", () => {
    expect(() => assertSafeRelativePath("a".repeat(1025))).toThrow(/too long/);
  });
});

describe("git mode classification", () => {
  test("classifies regular and executable file modes", () => {
    expect(executableBitForBlobMode("100644")).toBe(false);
    expect(executableBitForBlobMode("100755")).toBe(true);
  });

  test("rejects symlink and submodule modes", () => {
    expect(() => executableBitForBlobMode("120000")).toThrow(/Symlink/);
    expect(() => executableBitForBlobMode("160000")).toThrow(/Submodule/);
  });

  test("rejects an unknown mode", () => {
    expect(() => executableBitForBlobMode("040000")).toThrow(/Unsupported file mode/);
  });

  test("identifies symlinks and submodules", () => {
    expect(isSymlinkMode("120000")).toBe(true);
    expect(isSymlinkMode("100644")).toBe(false);
    expect(isSubmodule("160000", "commit")).toBe(true);
    expect(isSubmodule("100644", "commit")).toBe(true);
    expect(isSubmodule("100644", "blob")).toBe(false);
  });
});

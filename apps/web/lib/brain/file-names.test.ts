import { describe, expect, it } from "vitest";
import { brainFileRenameSelectionEnd, resolveBrainFileRenameName } from "./file-names";

describe("brain file names", () => {
  it("selects only the basename during rename", () => {
    expect(brainFileRenameSelectionEnd("a.md")).toBe(1);
    expect(brainFileRenameSelectionEnd("foo.test.md")).toBe(8);
    expect(brainFileRenameSelectionEnd("README")).toBe(6);
  });

  it("keeps the existing extension when only the basename changes", () => {
    expect(resolveBrainFileRenameName("a.md", "b")).toBe("b.md");
    expect(resolveBrainFileRenameName("foo.test.md", "bar")).toBe("bar.md");
    expect(resolveBrainFileRenameName("README", "NOTES")).toBe("NOTES");
    expect(resolveBrainFileRenameName("a.md", "b.txt")).toBe("b.txt");
  });
});

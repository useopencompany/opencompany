import { describe, expect, it } from "vitest";
import { resolveBrainSyncRename } from "./jobs";

describe("resolveBrainSyncRename", () => {
  it("records the previous file path for a fresh rename", () => {
    expect(
      resolveBrainSyncRename({
        renamePreviousPath: "docs/old.md",
        renamePreviousBlobSha: "blob-old",
      }),
    ).toEqual({
      previousPath: "docs/old.md",
      previousBlobSha: "blob-old",
    });
  });

  it("preserves the original previous file path across rapid renames", () => {
    expect(
      resolveBrainSyncRename({
        existingPreviousPath: "docs/a.md",
        existingPreviousBlobSha: "blob-a",
        renamePreviousPath: "docs/b.md",
        renamePreviousBlobSha: "blob-b",
      }),
    ).toEqual({
      previousPath: "docs/a.md",
      previousBlobSha: "blob-a",
    });
  });
});

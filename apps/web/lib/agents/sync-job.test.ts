import { describe, expect, test } from "vitest";
import { resolveAgentSyncRename } from "./sync-job";

describe("resolveAgentSyncRename", () => {
  test("records the previous file path for a fresh rename", () => {
    expect(
      resolveAgentSyncRename({
        renamePreviousPath: "agents/old.agent",
        renamePreviousBlobSha: "blob-old",
      }),
    ).toEqual({
      previousPath: "agents/old.agent",
      previousBlobSha: "blob-old",
    });
  });

  test("preserves the original previous file path across rapid renames", () => {
    expect(
      resolveAgentSyncRename({
        existingPreviousPath: "agents/a.agent",
        existingPreviousBlobSha: "blob-a",
        renamePreviousPath: "agents/b.agent",
        renamePreviousBlobSha: "blob-b",
      }),
    ).toEqual({
      previousPath: "agents/a.agent",
      previousBlobSha: "blob-a",
    });
  });
});

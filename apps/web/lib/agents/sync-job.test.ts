import { describe, expect, test } from "vitest";
import { resolveAgentSyncRename } from "./sync-job";

describe("resolveAgentSyncRename", () => {
  test("records the previous file path for a fresh rename", () => {
    expect(
      resolveAgentSyncRename({
        renamePreviousPath: "agents/old/agent.agent",
        renamePreviousBlobSha: "blob-old",
      }),
    ).toEqual({
      previousPath: "agents/old/agent.agent",
      previousBlobSha: "blob-old",
    });
  });

  test("preserves the original previous file path across rapid renames", () => {
    expect(
      resolveAgentSyncRename({
        existingPreviousPath: "agents/a/agent.agent",
        existingPreviousBlobSha: "blob-a",
        renamePreviousPath: "agents/b/agent.agent",
        renamePreviousBlobSha: "blob-b",
      }),
    ).toEqual({
      previousPath: "agents/a/agent.agent",
      previousBlobSha: "blob-a",
    });
  });
});

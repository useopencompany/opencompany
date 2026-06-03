import { describe, expect, test } from "vitest";
import { prepareAgentBundleFileMoves, resolveAgentSyncRename } from "./sync-job";

describe("resolveAgentSyncRename", () => {
  test("records the previous file path for a fresh rename", () => {
    expect(
      resolveAgentSyncRename({
        renamePreviousPath: "agents/old/old.agent",
        renamePreviousBlobSha: "blob-old",
      }),
    ).toEqual({
      previousPath: "agents/old/old.agent",
      previousBlobSha: "blob-old",
    });
  });

  test("preserves the original previous file path across rapid renames", () => {
    expect(
      resolveAgentSyncRename({
        existingPreviousPath: "agents/a/a.agent",
        existingPreviousBlobSha: "blob-a",
        renamePreviousPath: "agents/b/b.agent",
        renamePreviousBlobSha: "blob-b",
      }),
    ).toEqual({
      previousPath: "agents/a/a.agent",
      previousBlobSha: "blob-a",
    });
  });
});

describe("prepareAgentBundleFileMoves", () => {
  test("moves every file under the old bundle and preserves content hashes", () => {
    expect(
      prepareAgentBundleFileMoves({
        oldBundleDir: "agents/sales",
        newBundleDir: "agents/revenue",
        existingFileSyncJobs: [],
        files: [
          {
            id: 1,
            path: "agents/sales/memory.md",
            contentHash: "hash-memory",
            githubBlobSha: "blob-memory",
          },
          {
            id: 2,
            path: "agents/sales/playbooks/discovery.md",
            contentHash: "hash-playbook",
            githubBlobSha: "blob-playbook",
          },
          {
            id: 3,
            path: "agents/support/memory.md",
            contentHash: "hash-support",
            githubBlobSha: "blob-support",
          },
        ],
      }),
    ).toEqual([
      {
        fileId: 1,
        previousPath: "agents/sales/memory.md",
        path: "agents/revenue/memory.md",
        contentHash: "hash-memory",
        rename: {
          previousPath: "agents/sales/memory.md",
          previousBlobSha: "blob-memory",
        },
      },
      {
        fileId: 2,
        previousPath: "agents/sales/playbooks/discovery.md",
        path: "agents/revenue/playbooks/discovery.md",
        contentHash: "hash-playbook",
        rename: {
          previousPath: "agents/sales/playbooks/discovery.md",
          previousBlobSha: "blob-playbook",
        },
      },
    ]);
  });

  test("preserves the original GitHub source across rapid bundle renames", () => {
    expect(
      prepareAgentBundleFileMoves({
        oldBundleDir: "agents/revenue",
        newBundleDir: "agents/growth",
        existingFileSyncJobs: [
          {
            path: "agents/revenue/memory.md",
            previousPath: "agents/sales/memory.md",
            previousBlobSha: "blob-sales",
          },
        ],
        files: [
          {
            id: 1,
            path: "agents/revenue/memory.md",
            contentHash: "hash-memory",
            githubBlobSha: null,
          },
        ],
      }),
    ).toEqual([
      {
        fileId: 1,
        previousPath: "agents/revenue/memory.md",
        path: "agents/growth/memory.md",
        contentHash: "hash-memory",
        rename: {
          previousPath: "agents/sales/memory.md",
          previousBlobSha: "blob-sales",
        },
      },
    ]);
  });

  test("moves a colliding destination to a conflict path inside the new bundle", () => {
    const [move] = prepareAgentBundleFileMoves({
      oldBundleDir: "agents/sales",
      newBundleDir: "agents/revenue",
      existingFileSyncJobs: [],
      files: [
        {
          id: 1,
          path: "agents/sales/memory.md",
          contentHash: "hash-memory",
          githubBlobSha: "blob-memory",
        },
        {
          id: 2,
          path: "agents/revenue/memory.md",
          contentHash: "hash-existing",
          githubBlobSha: "blob-existing",
        },
      ],
    });

    expect(move).toEqual(
      expect.objectContaining({
        fileId: 1,
        previousPath: "agents/sales/memory.md",
        path: expect.stringMatching(/^agents\/revenue\/memory\.conflict-.*\.md$/),
      }),
    );
  });

  test("rejects moves that escape the destination bundle", () => {
    expect(() =>
      prepareAgentBundleFileMoves({
        oldBundleDir: "agents/sales",
        newBundleDir: "agents/revenue",
        existingFileSyncJobs: [],
        files: [
          {
            id: 1,
            path: "agents/sales/../../../etc/passwd",
            contentHash: "hash-evil",
            githubBlobSha: "blob-evil",
          },
        ],
      }),
    ).toThrow("escaped the destination bundle");
  });
});

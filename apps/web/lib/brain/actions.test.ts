import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { scheduleBrainSyncDispatch } from "@/lib/brain/sync-dispatch";
import { deleteBrainFolder, renameBrainFile, renameBrainFolder } from "./actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/brain/sync-dispatch", () => ({
  scheduleBrainSyncDispatch: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const scheduleBrainSyncDispatchMock = vi.mocked(scheduleBrainSyncDispatch);

function createDbMock(input: { selectResults: unknown[][]; insertReturning?: unknown[][] }) {
  const pendingSelectResults = [...input.selectResults];
  const pendingInsertReturning = [...(input.insertReturning ?? [])];
  const insertedValues: unknown[] = [];

  const limit = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const where = vi.fn(() => ({
    limit,
    then: (resolve: (value: unknown[]) => void) => resolve(pendingSelectResults.shift() ?? []),
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(async () => pendingInsertReturning.shift() ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const onConflictDoUpdate = vi.fn(() => ({ query: "sync-job-upsert" }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push(value);
      return { onConflictDoNothing, onConflictDoUpdate };
    }),
  }));
  const deleteWhere = vi.fn(() => ({ query: "delete" }));
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  const batch = vi.fn(async (queries: unknown[]) => queries);

  return {
    db: {
      select,
      insert,
      delete: deleteFrom,
      batch,
    },
    batch,
    insert,
    insertedValues,
  };
}

describe("renameBrainFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
    } as never);
  });

  it("rejects a rename when the destination already exists", async () => {
    const { db, insert, batch } = createDbMock({
      selectResults: [
        [
          {
            path: "docs/old.md",
            content: "old",
            contentHash: "hash-old",
            sizeBytes: 3,
            githubBlobSha: "blob-old",
          },
        ],
        [{ path: "docs/new.md" }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(renameBrainFile("docs/old.md", "docs/new.md")).resolves.toEqual({
      ok: false,
      error: "A Brain file already exists at that path.",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(scheduleBrainSyncDispatchMock).not.toHaveBeenCalled();
  });

  it("records the previous path and blob for GitHub sync", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        [
          {
            path: "docs/old.md",
            content: "old",
            contentHash: "hash-old",
            sizeBytes: 3,
            githubBlobSha: "blob-old",
          },
        ],
        [],
        [],
      ],
      insertReturning: [[{ path: "docs/new.md" }]],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(renameBrainFile("docs/old.md", "docs/new.md")).resolves.toEqual({
      ok: true,
      path: "docs/new.md",
    });

    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wks_123",
          path: "docs/new.md",
          content: "old",
          contentHash: "hash-old",
          githubSyncStatus: "pending",
        }),
        expect.objectContaining({
          workspaceId: "wks_123",
          path: "docs/new.md",
          operation: "upsert",
          desiredHash: "hash-old",
          previousPath: "docs/old.md",
          previousBlobSha: "blob-old",
        }),
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledOnce();
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "docs/new.md",
    });
  });

  it("moves all files in a folder and records per-file sync renames", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        [
          {
            path: "docs/a.md",
            content: "a",
            contentHash: "hash-a",
            sizeBytes: 1,
            githubBlobSha: "blob-a",
          },
          {
            path: "docs/deep/b.md",
            content: "b",
            contentHash: "hash-b",
            sizeBytes: 1,
            githubBlobSha: "blob-b",
          },
          {
            path: "notes/c.md",
            content: "c",
            contentHash: "hash-c",
            sizeBytes: 1,
            githubBlobSha: "blob-c",
          },
        ],
        [],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(renameBrainFolder("docs", "archive/docs")).resolves.toEqual({
      ok: true,
      path: "archive/docs",
    });

    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ path: "archive/docs/a.md", contentHash: "hash-a" }),
          expect.objectContaining({ path: "archive/docs/deep/b.md", contentHash: "hash-b" }),
        ]),
        expect.objectContaining({
          path: "archive/docs/a.md",
          operation: "upsert",
          previousPath: "docs/a.md",
          previousBlobSha: "blob-a",
        }),
        expect.objectContaining({
          path: "archive/docs/deep/b.md",
          operation: "upsert",
          previousPath: "docs/deep/b.md",
          previousBlobSha: "blob-b",
        }),
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledTimes(2);
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "archive/docs/a.md",
    });
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "archive/docs/deep/b.md",
    });
  });

  it("rejects moving a folder over an existing file path", async () => {
    const { db, batch } = createDbMock({
      selectResults: [
        [
          {
            path: "docs/a.md",
            content: "a",
            contentHash: "hash-a",
            sizeBytes: 1,
            githubBlobSha: "blob-a",
          },
          {
            path: "archive/docs/a.md",
            content: "existing",
            contentHash: "hash-existing",
            sizeBytes: 8,
            githubBlobSha: "blob-existing",
          },
        ],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(renameBrainFolder("docs", "archive/docs")).resolves.toEqual({
      ok: false,
      error: "A Brain file already exists at archive/docs/a.md.",
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("deletes all files in a folder and queues delete sync jobs", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        [
          { path: "docs/a.md", githubBlobSha: "blob-a" },
          { path: "docs/deep/b.md", githubBlobSha: "blob-b" },
          { path: "notes/c.md", githubBlobSha: "blob-c" },
        ],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(deleteBrainFolder("docs")).resolves.toEqual({
      ok: true,
      path: "docs",
    });

    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "docs/a.md",
          operation: "delete",
          desiredHash: null,
          previousBlobSha: "blob-a",
        }),
        expect.objectContaining({
          path: "docs/deep/b.md",
          operation: "delete",
          desiredHash: null,
          previousBlobSha: "blob-b",
        }),
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledTimes(2);
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "docs/a.md",
    });
    expect(scheduleBrainSyncDispatchMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "docs/deep/b.md",
    });
  });
});

import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-sync/dispatch";
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

vi.mock("@/lib/workspace-sync/dispatch", () => ({
  scheduleWorkspaceSyncDispatch: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const scheduleWorkspaceSyncDispatchMock = vi.mocked(scheduleWorkspaceSyncDispatch);

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
  const onConflictDoUpdate = vi.fn(() => ({ query: "dirty-upsert" }));
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
        [{ path: "docs/old.md", content: "old", contentHash: "hash-old", sizeBytes: 3 }],
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
    expect(scheduleWorkspaceSyncDispatchMock).not.toHaveBeenCalled();
  });

  it("inserts the renamed file and requests a single workspace reconcile", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        [{ path: "docs/old.md", content: "old", contentHash: "hash-old", sizeBytes: 3 }],
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
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledWith({ workspaceId: "wks_123" });
  });

  it("moves all files in a folder and requests a single reconcile", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        [
          { path: "docs/a.md", content: "a", contentHash: "hash-a", sizeBytes: 1 },
          { path: "docs/deep/b.md", content: "b", contentHash: "hash-b", sizeBytes: 1 },
          { path: "notes/c.md", content: "c", contentHash: "hash-c", sizeBytes: 1 },
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
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledWith({ workspaceId: "wks_123" });
  });

  it("rejects moving a folder over an existing file path", async () => {
    const { db, batch } = createDbMock({
      selectResults: [
        [
          { path: "docs/a.md", content: "a", contentHash: "hash-a", sizeBytes: 1 },
          {
            path: "archive/docs/a.md",
            content: "existing",
            contentHash: "hash-existing",
            sizeBytes: 8,
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
    expect(scheduleWorkspaceSyncDispatchMock).not.toHaveBeenCalled();
  });

  it("deletes all files in a folder and requests a single reconcile", async () => {
    const { db, batch } = createDbMock({
      selectResults: [[{ path: "docs/a.md" }, { path: "docs/deep/b.md" }, { path: "notes/c.md" }]],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(deleteBrainFolder("docs")).resolves.toEqual({
      ok: true,
      path: "docs",
    });

    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledWith({ workspaceId: "wks_123" });
  });
});

import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { batchWithTxid } from "@/lib/db/txid";
import {
  createPersonalBrainFileFromCollection,
  updatePersonalBrainFilesFromCollection,
} from "@/lib/personal/brain-actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/db/txid", () => ({
  batchWithTxid: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const batchWithTxidMock = vi.mocked(batchWithTxid);

function createDbMock(input: { selectResults: unknown[][] }) {
  const pendingSelectResults = [...input.selectResults];
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];

  const limit = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const where = vi.fn(() => ({
    limit,
    then: (resolve: (value: unknown[]) => void) => resolve(pendingSelectResults.shift() ?? []),
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push(value);
      return { query: "insert-agent-file" };
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => {
      updatedValues.push(value);
      return { where: vi.fn(() => ({ query: "update-agent-file" })) };
    }),
  }));

  return {
    db: { select, insert, update },
    insertedValues,
    updatedValues,
  };
}

describe("personal brain collection actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
      user: { id: "usr_123" },
    } as never);
  });

  it("rejects oversized Personal Brain writes before persisting", async () => {
    const { db, insertedValues } = createDbMock({
      selectResults: [[{ id: "agt_123", path: "agents/personal/personal.agent" }]],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(
      createPersonalBrainFileFromCollection({
        path: "notes/large.md",
        content: "x".repeat(256 * 1024 + 1),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Personal Brain files must be 256 KB or smaller.",
    });
    expect(insertedValues).toEqual([]);
    expect(batchWithTxidMock).not.toHaveBeenCalled();
  });

  it("inserts a scoped Personal Brain file and returns a txid", async () => {
    const { db, insertedValues } = createDbMock({
      selectResults: [[{ id: "agt_123", path: "agents/personal/personal.agent" }], []],
    });
    getDbMock.mockReturnValue(db as never);
    batchWithTxidMock.mockResolvedValue(42);

    await expect(
      createPersonalBrainFileFromCollection({ path: "notes/a.md", content: "hello" }),
    ).resolves.toEqual({ ok: true, txid: 42 });

    expect(insertedValues).toEqual([
      expect.objectContaining({
        workspaceId: "wks_123",
        agentId: "agt_123",
        path: "agents/personal/personal-brain/notes/a.md",
        content: "hello",
        sizeBytes: 5,
        githubSyncStatus: "synced",
      }),
    ]);
    expect(batchWithTxidMock).toHaveBeenCalledTimes(1);
  });

  it("rejects updates to rows outside the Personal Brain subtree", async () => {
    const { db, updatedValues } = createDbMock({
      selectResults: [
        [{ id: "agt_123", path: "agents/personal/personal.agent" }],
        [{ id: 7, path: "agents/personal/memory/user.md" }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(
      updatePersonalBrainFilesFromCollection([{ id: 7, path: "notes/a.md", content: "hello" }]),
    ).resolves.toEqual({ ok: false, error: "Personal Brain file not found." });
    expect(updatedValues).toEqual([]);
    expect(batchWithTxidMock).not.toHaveBeenCalled();
  });
});

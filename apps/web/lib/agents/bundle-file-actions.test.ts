import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleAgentFileSyncDispatch } from "@/lib/agents/file-sync-dispatch";
import { currentWorkspace } from "@/lib/auth";
import { updateAgentBundleFile } from "./bundle-file-actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/agents/file-sync-dispatch", () => ({
  scheduleAgentFileSyncDispatch: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const scheduleAgentFileSyncDispatchMock = vi.mocked(scheduleAgentFileSyncDispatch);

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
  const onConflictDoUpdate = vi.fn(() => ({ query: "agent-file-sync-job" }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push(value);
      return { onConflictDoUpdate };
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => {
      updatedValues.push(value);
      return { where: vi.fn(() => ({ query: "agent-file-update" })) };
    }),
  }));
  const batch = vi.fn(async (queries: unknown[]) => queries);

  return {
    db: {
      select,
      insert,
      update,
      batch,
    },
    batch,
    insertedValues,
    updatedValues,
  };
}

describe("updateAgentBundleFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
    } as never);
  });

  it("updates agentFiles and queues an agentFileSyncJobs upsert for the same bundle path", async () => {
    const { db, batch, insertedValues, updatedValues } = createDbMock({
      selectResults: [
        [{ id: "agt_123", path: "agents/sales/agent.agent" }],
        [
          {
            path: "agents/sales/playbooks/discovery.md",
            content: "Old",
            contentHash: "old_hash",
            sizeBytes: 3,
          },
        ],
        [
          {
            path: "agents/sales/playbooks/discovery.md",
            content: "Updated",
            contentHash: "new_hash",
            sizeBytes: 7,
            githubCommitSha: null,
            githubSyncedAt: null,
            githubSyncStatus: "pending",
            githubSyncError: null,
            updatedAt: new Date("2026-05-24T10:00:00.000Z"),
          },
        ],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await updateAgentBundleFile(
      "agt_123",
      "agents/sales/playbooks/discovery.md",
      "Updated",
    );

    expect(result).toEqual({
      ok: true,
      file: expect.objectContaining({
        path: "agents/sales/playbooks/discovery.md",
        relativePath: "playbooks/discovery.md",
        content: "Updated",
        githubSyncStatus: "pending",
      }),
    });
    expect(updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "Updated",
          sizeBytes: 7,
          githubSyncStatus: "pending",
        }),
      ]),
    );
    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wks_123",
          path: "agents/sales/playbooks/discovery.md",
          operation: "upsert",
          desiredHash: expect.any(String),
        }),
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleAgentFileSyncDispatchMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "agents/sales/playbooks/discovery.md",
    });
  });
});

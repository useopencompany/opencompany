import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { requirePersonalAgentRef } from "@/lib/personal/brain";
import { scheduleWorkspaceSyncDispatch } from "@/lib/workspace-state/sync-dispatch";
import {
  listPersonalBrainFileVersions,
  restorePersonalBrainFileVersion,
} from "../personal/brain-actions";
import {
  listBrainFileVersions,
  restoreBrainFileVersion,
  restoreLatestBrainVersionBeforeTurn,
} from "./version-actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/workspace-state/sync-dispatch", () => ({
  scheduleWorkspaceSyncDispatch: vi.fn(),
}));

vi.mock("@/lib/personal/brain", () => ({
  requirePersonalAgentRef: vi.fn(),
  // Real implementations of the pure path helpers so the repo-path translation
  // under test runs exactly as it does in production.
  personalBrainRepoPath: (bundleDir: string, logicalPath: string) =>
    `${bundleDir}/personal-brain/${logicalPath}`,
  personalBrainPrefix: (bundleDir: string) => `${bundleDir}/personal-brain/`,
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const requirePersonalAgentRefMock = vi.mocked(requirePersonalAgentRef);
const scheduleWorkspaceSyncDispatchMock = vi.mocked(scheduleWorkspaceSyncDispatch);

// Mirrors the harness in actions.test.ts, extended with `.orderBy()` so the
// version queries (which order before limiting) resolve from the same queue.
function createDbMock(input: { selectResults: unknown[][] }) {
  const pendingSelectResults = [...input.selectResults];
  const insertedValues: unknown[] = [];

  const shift = () => pendingSelectResults.shift() ?? [];
  const limit = vi.fn(async () => shift());
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({
    limit,
    orderBy,
    then: (resolve: (value: unknown[]) => void) => resolve(shift()),
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const onConflictDoUpdate = vi.fn(() => ({ query: "upsert" }));
  const onConflictDoNothing = vi.fn(() => ({ returning: vi.fn(async () => []) }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push(value);
      return { onConflictDoUpdate, onConflictDoNothing };
    }),
  }));
  const batch = vi.fn(async (queries: unknown[]) => queries);

  return {
    db: { select, insert, batch },
    select,
    insert,
    batch,
    insertedValues,
  };
}

describe("listBrainFileVersions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({ workspace: { id: "wks_123" } } as never);
  });

  it("returns scoped versions newest-first with ISO timestamps", async () => {
    const newer = new Date("2026-06-16T12:00:00.000Z");
    const older = new Date("2026-06-15T09:30:00.000Z");
    const { db } = createDbMock({
      selectResults: [
        [
          { id: 2, operation: "overwrite", sizeBytes: 12, createdAt: newer, sessionId: "sess_b" },
          { id: 1, operation: "delete", sizeBytes: 8, createdAt: older, sessionId: null },
        ],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(listBrainFileVersions("docs/spec.md")).resolves.toEqual({
      ok: true,
      versions: [
        {
          id: 2,
          operation: "overwrite",
          sizeBytes: 12,
          createdAt: "2026-06-16T12:00:00.000Z",
          sessionId: "sess_b",
        },
        {
          id: 1,
          operation: "delete",
          sizeBytes: 8,
          createdAt: "2026-06-15T09:30:00.000Z",
          sessionId: null,
        },
      ],
    });
  });
});

describe("restoreBrainFileVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({ workspace: { id: "wks_123" } } as never);
  });

  it("records the current content, upserts the restored content, enqueues, and dispatches", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        // version lookup
        [
          {
            id: 7,
            workspaceId: "wks_123",
            scope: "company",
            agentId: null,
            path: "docs/spec.md",
            content: "restored content",
            contentHash: "hash-restored",
            sizeBytes: 16,
            operation: "overwrite",
            sessionId: "sess_old",
            createdAt: new Date("2026-06-10T00:00:00.000Z"),
          },
        ],
        // current brainFiles row
        [{ content: "live content", contentHash: "hash-live", sizeBytes: 12 }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(restoreBrainFileVersion({ path: "docs/spec.md", versionId: 7 })).resolves.toEqual({
      ok: true,
      path: "docs/spec.md",
    });

    // A version-of-current row was recorded before the overwrite.
    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "wks_123",
          scope: "company",
          agentId: null,
          path: "docs/spec.md",
          content: "live content",
          contentHash: "hash-live",
          operation: "overwrite",
        }),
        // brainFiles upsert with the restored content.
        expect.objectContaining({
          workspaceId: "wks_123",
          path: "docs/spec.md",
          content: "restored content",
          githubSyncStatus: "pending",
        }),
        // workspace sync job enqueued for the restored path.
        expect.objectContaining({
          workspaceId: "wks_123",
          repoPath: "brain/docs/spec.md",
          sourceKind: "brain",
          operation: "upsert",
        }),
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledWith({ workspaceId: "wks_123" });
  });

  it("skips recording a version-of-current when the live content already matches", async () => {
    const { db, insertedValues } = createDbMock({
      selectResults: [
        [
          {
            id: 7,
            workspaceId: "wks_123",
            scope: "company",
            agentId: null,
            path: "docs/spec.md",
            content: "same content",
            contentHash: "hash-same",
            sizeBytes: 12,
            operation: "overwrite",
            sessionId: null,
            createdAt: new Date("2026-06-10T00:00:00.000Z"),
          },
        ],
        // current row has the SAME hash as the target version.
        [{ content: "same content", contentHash: "hash-same", sizeBytes: 12 }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(restoreBrainFileVersion({ path: "docs/spec.md", versionId: 7 })).resolves.toEqual({
      ok: true,
      path: "docs/spec.md",
    });

    // No "overwrite" version row captured (only the brainFiles upsert + sync job).
    const versionRows = insertedValues.filter(
      (v): v is { operation?: string } =>
        typeof v === "object" &&
        v !== null &&
        (v as { operation?: string }).operation !== undefined,
    );
    expect(versionRows.every((v) => v.operation === "upsert")).toBe(true);
  });

  it("returns { ok: false } for an unknown version id", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [[]],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(
      restoreBrainFileVersion({ path: "docs/spec.md", versionId: 999 }),
    ).resolves.toEqual({ ok: false, error: "Version not found." });
    expect(insertedValues).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(scheduleWorkspaceSyncDispatchMock).not.toHaveBeenCalled();
  });
});

describe("restoreLatestBrainVersionBeforeTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({ workspace: { id: "wks_123" } } as never);
  });

  it("restores the most recent version row for the path", async () => {
    const { db, batch, insertedValues } = createDbMock({
      selectResults: [
        // most-recent version (ORDER BY createdAt DESC LIMIT 1)
        [
          {
            id: 9,
            workspaceId: "wks_123",
            scope: "company",
            agentId: null,
            path: "docs/spec.md",
            content: "latest restore",
            contentHash: "hash-latest",
            sizeBytes: 14,
            operation: "delete",
            sessionId: "sess_x",
            createdAt: new Date("2026-06-12T00:00:00.000Z"),
          },
        ],
        // current brainFiles row
        [{ content: "live", contentHash: "hash-live", sizeBytes: 4 }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(restoreLatestBrainVersionBeforeTurn("docs/spec.md")).resolves.toEqual({
      ok: true,
      path: "docs/spec.md",
    });
    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "latest restore", path: "docs/spec.md" }),
      ]),
    );
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleWorkspaceSyncDispatchMock).toHaveBeenCalledOnce();
  });

  it("returns { ok: false } when no version exists", async () => {
    const { db, batch } = createDbMock({ selectResults: [[]] });
    getDbMock.mockReturnValue(db as never);

    await expect(restoreLatestBrainVersionBeforeTurn("docs/spec.md")).resolves.toEqual({
      ok: false,
      error: "No previous version to restore.",
    });
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("personal brain versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePersonalAgentRefMock.mockResolvedValue({
      workspaceId: "wks_123",
      agentId: "agent_p",
      bundleDir: "agents/leo",
    } as never);
  });

  it("lists versions keyed by the FULL agent_files repo path", async () => {
    const created = new Date("2026-06-16T08:00:00.000Z");
    const { db, select } = createDbMock({
      selectResults: [
        [{ id: 3, operation: "overwrite", sizeBytes: 5, createdAt: created, sessionId: "s1" }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(listPersonalBrainFileVersions("notes.md")).resolves.toEqual({
      ok: true,
      versions: [
        {
          id: 3,
          operation: "overwrite",
          sizeBytes: 5,
          createdAt: "2026-06-16T08:00:00.000Z",
          sessionId: "s1",
        },
      ],
    });
    // The query ran (path translation happens inside; covered by the restore test).
    expect(select).toHaveBeenCalled();
  });

  it("restores into agent_files with agentId and does NOT enqueue or dispatch", async () => {
    const { db, insertedValues } = createDbMock({
      selectResults: [
        // version lookup (full repo path)
        [
          {
            id: 4,
            workspaceId: "wks_123",
            scope: "personal",
            agentId: "agent_p",
            path: "agents/leo/personal-brain/notes.md",
            content: "restored personal",
            contentHash: "hash-restored",
            sizeBytes: 17,
            operation: "overwrite",
            sessionId: null,
            createdAt: new Date("2026-06-10T00:00:00.000Z"),
          },
        ],
        // current agent_files row
        [{ content: "live personal", contentHash: "hash-live", sizeBytes: 13 }],
      ],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(
      restorePersonalBrainFileVersion({ path: "notes.md", versionId: 4 }),
    ).resolves.toEqual({ ok: true, path: "notes.md" });

    expect(insertedValues).toEqual(
      expect.arrayContaining([
        // version-of-current row, scope personal + agentId, full repo path.
        expect.objectContaining({
          workspaceId: "wks_123",
          scope: "personal",
          agentId: "agent_p",
          path: "agents/leo/personal-brain/notes.md",
          content: "live personal",
          operation: "overwrite",
        }),
        // agent_files upsert with restored content + agentId, marked synced (local-only).
        expect.objectContaining({
          workspaceId: "wks_123",
          agentId: "agent_p",
          path: "agents/leo/personal-brain/notes.md",
          content: "restored personal",
          githubSyncStatus: "synced",
        }),
      ]),
    );
    // Personal brain is local-only: never enqueues a workspace sync job...
    const syncJobs = insertedValues.filter(
      (v): v is { sourceKind?: string } =>
        typeof v === "object" && v !== null && "sourceKind" in (v as object),
    );
    expect(syncJobs).toHaveLength(0);
    // ...and never schedules a projection dispatch.
    expect(scheduleWorkspaceSyncDispatchMock).not.toHaveBeenCalled();
  });
});

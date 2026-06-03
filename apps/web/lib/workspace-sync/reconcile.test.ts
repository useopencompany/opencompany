import {
  agentFiles,
  agents,
  brainFiles,
  workspaceRepositories,
  workspaceSyncJobs,
  workspaces,
} from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobSha } from "@/lib/workspace-state/git-blob";
import {
  createCommit,
  createTree,
  ensureWorkspaceRepository,
  getBranchHead,
  isGitHubRefUpdateConflict,
  listTreeBlobs,
  updateBranchRef,
} from "@/lib/workspace-state/github";
import { reconcileWorkspaceToGitHub } from "./reconcile";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  timing: {
    startTimingTrace: vi.fn(() => ({})),
    endTimingTrace: vi.fn(),
    timeAsync: vi.fn(async (_trace: unknown, _name: string, handler: () => unknown) => handler()),
  },
  github: {
    createCommit: vi.fn(),
    createTree: vi.fn(),
    ensureWorkspaceRepository: vi.fn(),
    getBranchHead: vi.fn(),
    isGitHubRefUpdateConflict: vi.fn(),
    listTreeBlobs: vi.fn(),
    updateBranchRef: vi.fn(),
  },
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => mocks.logger),
}));

vi.mock("@/lib/observability/timing", () => mocks.timing);

vi.mock("@/lib/workspace-state/github", () => mocks.github);

const now = new Date("2026-06-03T12:00:00.000Z");
const repository = {
  workspaceId: "wks_123",
  githubRepoId: "123",
  fullName: "opencompany/wks-123",
  defaultBranch: "main",
  latestHeadSha: null,
  createdAt: now,
  updatedAt: now,
};
const workspace = {
  id: "wks_123",
  name: "Acme",
  workosOrganizationId: null,
  createdByUserId: "usr_123",
  teamSize: null,
  companyUrl: null,
  createdAt: now,
  updatedAt: now,
};

type SyncJob = typeof workspaceSyncJobs.$inferSelect;
type BrainFile = typeof brainFiles.$inferSelect;
type Agent = typeof agents.$inferSelect;
type AgentFile = typeof agentFiles.$inferSelect;

type TestState = {
  job: SyncJob | null;
  workspace: typeof workspace | null;
  repository: typeof repository;
  brainRows: BrainFile[];
  agentRows: Agent[];
  agentFileRows: AgentFile[];
  beforeDeleteJob?: () => void;
  beforeSyncedRowUpdate?: () => void;
};

function pendingJob(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    workspaceId: "wks_123",
    status: "pending",
    attempts: 0,
    nextRunAt: new Date("2026-06-03T11:59:00.000Z"),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function brainRow(overrides: Partial<BrainFile> = {}): BrainFile {
  return {
    id: 1,
    workspaceId: "wks_123",
    path: "docs/a.md",
    content: "A",
    contentHash: "hash-a",
    sizeBytes: 1,
    githubCommitSha: null,
    githubSyncedHash: null,
    githubSyncedAt: null,
    githubSyncStatus: "pending",
    githubSyncError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createState(overrides: Partial<TestState> = {}): TestState {
  return {
    job: pendingJob(),
    workspace,
    repository: { ...repository },
    brainRows: [],
    agentRows: [],
    agentFileRows: [],
    ...overrides,
  };
}

function createDb(state: TestState) {
  return {
    batch: vi.fn(async (statements: Array<Promise<unknown> | unknown>) => {
      return Promise.all(statements);
    }),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        if (table === workspaceSyncJobs) {
          state.beforeDeleteJob?.();
          if (state.job?.status === "syncing") state.job = null;
        }
      }),
    })),
    select: vi.fn(() => new SelectQuery(state)),
    update: vi.fn((table: unknown) => new UpdateQuery(state, table)),
  };
}

class SelectQuery {
  private table: unknown;

  constructor(private state: TestState) {}

  from(table: unknown) {
    this.table = table;
    return this;
  }

  where() {
    return this;
  }

  limit(count: number) {
    return Promise.resolve(this.rows().slice(0, count));
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.rows()).then(onfulfilled, onrejected);
  }

  private rows() {
    if (this.table === workspaceSyncJobs) return this.state.job ? [this.state.job] : [];
    if (this.table === workspaces) return this.state.workspace ? [this.state.workspace] : [];
    if (this.table === brainFiles) return this.state.brainRows;
    if (this.table === agents) return this.state.agentRows;
    if (this.table === agentFiles) return this.state.agentFileRows;
    return [];
  }
}

class UpdateQuery {
  private values: Record<string, unknown> = {};

  constructor(
    private state: TestState,
    private table: unknown,
  ) {}

  set(values: Record<string, unknown>) {
    this.values = values;
    return this;
  }

  where() {
    return Promise.resolve(this.apply());
  }

  private apply() {
    if (this.table === workspaceSyncJobs && this.state.job) {
      Object.assign(this.state.job, this.values);
      return;
    }

    if (this.table === workspaceRepositories) {
      Object.assign(this.state.repository, this.values);
      return;
    }

    if (this.table === brainFiles) {
      applyFileUpdate(this.state, this.state.brainRows, this.values);
      return;
    }

    if (this.table === agents) {
      applyFileUpdate(this.state, this.state.agentRows, this.values);
      return;
    }

    if (this.table === agentFiles) {
      applyFileUpdate(this.state, this.state.agentFileRows, this.values);
    }
  }
}

function applyFileUpdate<T extends { contentHash: string | null; githubSyncStatus: string }>(
  state: TestState,
  rows: T[],
  values: Record<string, unknown>,
) {
  if (values.githubSyncStatus === "syncing") {
    for (const row of rows) {
      const syncedHash = "githubSyncedHash" in row ? row.githubSyncedHash : null;
      if (syncedHash !== row.contentHash) Object.assign(row, values);
    }
    return;
  }

  if (values.githubSyncStatus === "failed") {
    for (const row of rows) {
      if (row.githubSyncStatus === "syncing") Object.assign(row, values);
    }
    return;
  }

  if (values.githubSyncStatus === "synced") {
    state.beforeSyncedRowUpdate?.();
    state.beforeSyncedRowUpdate = undefined;
    for (const row of rows) {
      if (row.contentHash === values.githubSyncedHash) Object.assign(row, values);
    }
  }
}

function setup(state: TestState) {
  const db = createDb(state);
  mocks.getDb.mockReturnValue(db);
  vi.mocked(ensureWorkspaceRepository).mockResolvedValue(state.repository);
  return db;
}

describe("reconcileWorkspaceToGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(now);
    vi.useFakeTimers();
    vi.mocked(createCommit).mockResolvedValue("commit_new");
    vi.mocked(createTree).mockResolvedValue("tree_new");
    vi.mocked(getBranchHead).mockResolvedValue({ commitSha: "commit_head", treeSha: "tree_head" });
    vi.mocked(isGitHubRefUpdateConflict).mockReturnValue(false);
    vi.mocked(updateBranchRef).mockResolvedValue(undefined);
  });

  it("heals stale DB sync metadata on a no-op GitHub tree and clears the job", async () => {
    const row = brainRow({ githubSyncedHash: null, githubSyncStatus: "pending" });
    const state = createState({ brainRows: [row] });
    setup(state);
    vi.mocked(listTreeBlobs).mockResolvedValue({
      entries: new Map([
        ["README.md", gitBlobSha("readme")],
        ["brain/docs/a.md", gitBlobSha("A")],
      ]),
      truncated: false,
    });

    await expect(reconcileWorkspaceToGitHub({ workspaceId: "wks_123" })).resolves.toEqual({
      status: "noop",
    });

    expect(createTree).not.toHaveBeenCalled();
    expect(row.githubSyncStatus).toBe("synced");
    expect(row.githubSyncedHash).toBe("hash-a");
    expect(row.githubCommitSha).toBe("commit_head");
    expect(state.job).toBeNull();
  });

  it("commits changed desired files and marks all matching desired rows synced", async () => {
    const changed = brainRow({ id: 1, path: "docs/a.md", content: "new", contentHash: "hash-new" });
    const unchanged = brainRow({ id: 2, path: "docs/b.md", content: "B", contentHash: "hash-b" });
    const state = createState({ brainRows: [changed, unchanged] });
    setup(state);
    vi.mocked(listTreeBlobs).mockResolvedValue({
      entries: new Map([
        ["brain/docs/a.md", gitBlobSha("old")],
        ["brain/docs/b.md", gitBlobSha("B")],
      ]),
      truncated: false,
    });

    await expect(reconcileWorkspaceToGitHub({ workspaceId: "wks_123" })).resolves.toEqual({
      status: "synced",
      commitSha: "commit_new",
      changed: 1,
      removed: 0,
    });

    expect(createTree).toHaveBeenCalledWith({
      repository: expect.objectContaining({
        fullName: repository.fullName,
        workspaceId: repository.workspaceId,
      }),
      baseTreeSha: "tree_head",
      entries: [
        {
          path: "brain/docs/a.md",
          mode: "100644",
          type: "blob",
          content: "new",
        },
      ],
    });
    expect(changed.githubSyncStatus).toBe("synced");
    expect(unchanged.githubSyncStatus).toBe("synced");
    expect(changed.githubCommitSha).toBe("commit_new");
    expect(unchanged.githubCommitSha).toBe("commit_new");
  });

  it("does not mark a row synced if its content hash changed during reconcile", async () => {
    const row = brainRow({ content: "new", contentHash: "hash-new" });
    const state = createState({
      brainRows: [row],
      beforeSyncedRowUpdate: () => {
        row.contentHash = "hash-raced";
        row.githubSyncStatus = "pending";
      },
    });
    setup(state);
    vi.mocked(listTreeBlobs).mockResolvedValue({
      entries: new Map([["brain/docs/a.md", gitBlobSha("old")]]),
      truncated: false,
    });

    await reconcileWorkspaceToGitHub({ workspaceId: "wks_123" });

    expect(row.githubSyncStatus).toBe("pending");
    expect(row.githubSyncedHash).toBeNull();
  });

  it("deletes repo-only managed files while preserving files outside managed prefixes", async () => {
    const state = createState({ brainRows: [] });
    setup(state);
    vi.mocked(listTreeBlobs).mockResolvedValue({
      entries: new Map([
        ["README.md", gitBlobSha("readme")],
        ["brain/stale.md", gitBlobSha("stale")],
      ]),
      truncated: false,
    });

    await expect(reconcileWorkspaceToGitHub({ workspaceId: "wks_123" })).resolves.toEqual({
      status: "synced",
      commitSha: "commit_new",
      changed: 0,
      removed: 1,
    });

    expect(createTree).toHaveBeenCalledWith({
      repository: expect.objectContaining({
        fullName: repository.fullName,
        workspaceId: repository.workspaceId,
      }),
      baseTreeSha: "tree_head",
      entries: [{ path: "brain/stale.md", mode: "100644", type: "blob", sha: null }],
    });
  });

  it("marks syncing rows and the job failed when GitHub returns a truncated tree", async () => {
    const row = brainRow({ githubSyncedHash: null });
    const state = createState({ brainRows: [row] });
    setup(state);
    vi.mocked(listTreeBlobs).mockResolvedValue({ entries: new Map(), truncated: true });

    await expect(reconcileWorkspaceToGitHub({ workspaceId: "wks_123" })).rejects.toThrow(
      /truncated/,
    );

    expect(captureException).toHaveBeenCalled();
    expect(state.job?.status).toBe("failed");
    expect(state.job?.attempts).toBe(1);
    expect(row.githubSyncStatus).toBe("failed");
    expect(row.githubSyncError).toMatch(/truncated/);
  });

  it("retries from the latest tree after a ref update conflict", async () => {
    const row = brainRow({ content: "A", contentHash: "hash-a" });
    const conflict = new Error("ref moved");
    const state = createState({ brainRows: [row] });
    setup(state);
    vi.mocked(isGitHubRefUpdateConflict).mockImplementation((error) => error === conflict);
    vi.mocked(getBranchHead)
      .mockResolvedValueOnce({ commitSha: "commit_old", treeSha: "tree_old" })
      .mockResolvedValueOnce({ commitSha: "commit_latest", treeSha: "tree_latest" });
    vi.mocked(listTreeBlobs)
      .mockResolvedValueOnce({
        entries: new Map([["brain/docs/a.md", gitBlobSha("old")]]),
        truncated: false,
      })
      .mockResolvedValueOnce({
        entries: new Map([["brain/docs/a.md", gitBlobSha("A")]]),
        truncated: false,
      });
    vi.mocked(updateBranchRef).mockRejectedValueOnce(conflict);

    await expect(reconcileWorkspaceToGitHub({ workspaceId: "wks_123" })).resolves.toEqual({
      status: "noop",
    });

    expect(getBranchHead).toHaveBeenCalledTimes(2);
    expect(createTree).toHaveBeenCalledTimes(1);
    expect(row.githubSyncStatus).toBe("synced");
    expect(row.githubCommitSha).toBe("commit_latest");
  });

  it("keeps a newly dirtied workspace job pending when an edit lands during reconcile", async () => {
    const row = brainRow({ content: "A", contentHash: "hash-a" });
    const state = createState({
      brainRows: [row],
      beforeDeleteJob: () => {
        if (state.job) {
          state.job.status = "pending";
          state.job.nextRunAt = new Date("2026-06-03T12:01:00.000Z");
        }
      },
    });
    setup(state);
    vi.mocked(listTreeBlobs).mockResolvedValue({
      entries: new Map([["brain/docs/a.md", gitBlobSha("A")]]),
      truncated: false,
    });

    await reconcileWorkspaceToGitHub({ workspaceId: "wks_123" });

    expect(state.job?.status).toBe("pending");
    expect(state.job?.nextRunAt).toEqual(new Date("2026-06-03T12:01:00.000Z"));
  });
});

import {
  agentFiles,
  agents,
  brainFiles,
  workspaceSyncJobs,
  workspaces,
} from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitWorkspaceChanges } from "@/lib/workspace-state/git-data-api";
import { ensureWorkspaceRepository } from "@/lib/workspace-state/github";
import { projectWorkspaceToGitHub } from "@/lib/workspace-state/project";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@opencompany/db/client", () => ({ getDb: dbMocks.getDb }));
vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));
vi.mock("@/lib/workspace-state/github", () => ({
  ensureWorkspaceRepository: vi.fn(async () => ({
    workspaceId: "wsp_1",
    fullName: "opencompany/test",
    defaultBranch: "main",
  })),
}));
vi.mock("@/lib/workspace-state/git-data-api", () => ({
  commitWorkspaceChanges: vi.fn(),
}));

const commitMock = vi.mocked(commitWorkspaceChanges);
const ensureRepoMock = vi.mocked(ensureWorkspaceRepository);

// A drizzle-shaped db mock. select().from(table) routes to a per-table row set;
// the returned builder is awaitable and also exposes orderBy/limit. update/delete
// builders are collected so we can assert what was written/cleared.
function createDb(rows: {
  jobs?: unknown[];
  workspaces?: unknown[];
  brainFiles?: unknown[];
  agentFiles?: unknown[];
  agents?: unknown[];
}) {
  const batched: unknown[][] = [];
  const deleted: unknown[] = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === workspaceSyncJobs) return rows.jobs ?? [];
    if (table === workspaces) return rows.workspaces ?? [];
    if (table === brainFiles) return rows.brainFiles ?? [];
    if (table === agentFiles) return rows.agentFiles ?? [];
    if (table === agents) return rows.agents ?? [];
    return [];
  };

  const thenable = (result: unknown[]) => ({
    orderBy: () => Promise.resolve(result),
    limit: () => Promise.resolve(result),
    then: (resolve: (value: unknown[]) => void) => resolve(result),
  });

  const db = {
    select: () => ({
      from: (table: unknown) => ({ where: () => thenable(rowsFor(table)) }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ __op: "update", then: (r: () => void) => r() }) }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        const q = { __op: "delete", table };
        deleted.push(q);
        return q;
      },
    }),
    batch: vi.fn(async (queries: unknown[]) => {
      batched.push(queries);
      return queries;
    }),
  };

  return { db, batched, deleted };
}

const WORKSPACE = { id: "wsp_1", name: "Test" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("projectWorkspaceToGitHub", () => {
  it("caps a single commit at 200 jobs and leaves the rest pending", async () => {
    const count = 201;
    const jobs = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      workspaceId: "wsp_1",
      repoPath: `brain/f${i}.md`,
      sourceKind: "brain",
      sourceRef: null,
      operation: "upsert",
      desiredHash: `h${i}`,
      previousPath: null,
      attempts: 0,
    }));
    const brain = Array.from({ length: count }, (_, i) => ({
      path: `f${i}.md`,
      content: `C${i}`,
      contentHash: `h${i}`,
      githubSyncedHash: null,
    }));
    const { db } = createDb({ jobs, workspaces: [WORKSPACE], brainFiles: brain });
    dbMocks.getDb.mockReturnValue(db as never);
    commitMock.mockResolvedValue({ commitSha: "commit_cap", blobShaByPath: new Map() });

    const result = await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    expect(commitMock).toHaveBeenCalledOnce();
    // Only the first 200 jobs are committed; the 201st stays pending for the
    // next round (the drain-loop re-invokes the projector).
    expect(commitMock.mock.calls[0]![0].upserts).toHaveLength(200);
    expect(result).toMatchObject({ status: "synced", upserts: 200 });
  });

  it("returns idle when no jobs are due", async () => {
    const { db } = createDb({ jobs: [] });
    dbMocks.getDb.mockReturnValue(db as never);
    await expect(projectWorkspaceToGitHub({ workspaceId: "wsp_1" })).resolves.toEqual({
      status: "idle",
    });
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("commits a changed brain file in one commit and marks it synced", async () => {
    const { db } = createDb({
      jobs: [
        {
          id: 1,
          workspaceId: "wsp_1",
          repoPath: "brain/a.md",
          sourceKind: "brain",
          sourceRef: null,
          operation: "upsert",
          desiredHash: "h_new",
          previousPath: null,
          attempts: 0,
        },
      ],
      workspaces: [WORKSPACE],
      brainFiles: [{ path: "a.md", content: "A", contentHash: "h_new", githubSyncedHash: "h_old" }],
    });
    dbMocks.getDb.mockReturnValue(db as never);
    commitMock.mockResolvedValue({
      commitSha: "commit_1",
      blobShaByPath: new Map([["brain/a.md", "blob_a"]]),
    });

    const result = await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    expect(ensureRepoMock).toHaveBeenCalledOnce();
    expect(commitMock).toHaveBeenCalledOnce();
    const arg = commitMock.mock.calls[0]![0];
    expect(arg.upserts).toEqual([{ path: "brain/a.md", content: "A" }]);
    expect(arg.deletes).toEqual([]);
    expect(result).toEqual({ status: "synced", commitSha: "commit_1", upserts: 1, deletes: 0 });
  });

  it("skips the commit when the file already matches its committed hash (no-op)", async () => {
    const { db, batched } = createDb({
      jobs: [
        {
          id: 2,
          workspaceId: "wsp_1",
          repoPath: "brain/a.md",
          sourceKind: "brain",
          sourceRef: null,
          operation: "upsert",
          desiredHash: "h_same",
          previousPath: null,
          attempts: 0,
        },
      ],
      workspaces: [WORKSPACE],
      // githubSyncedHash already equals the content hash → nothing to commit.
      brainFiles: [
        { path: "a.md", content: "A", contentHash: "h_same", githubSyncedHash: "h_same" },
      ],
    });
    dbMocks.getDb.mockReturnValue(db as never);

    const result = await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    expect(commitMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "noop", jobs: 1 });
    // The leased job is still cleared on a no-op.
    expect(batched.length === 0).toBe(true);
  });

  it("emits a delete tree entry for a delete job", async () => {
    const { db } = createDb({
      jobs: [
        {
          id: 3,
          workspaceId: "wsp_1",
          repoPath: "brain/gone.md",
          sourceKind: "brain",
          sourceRef: null,
          operation: "delete",
          desiredHash: null,
          previousPath: null,
          attempts: 0,
        },
      ],
      workspaces: [WORKSPACE],
    });
    dbMocks.getDb.mockReturnValue(db as never);
    commitMock.mockResolvedValue({ commitSha: "commit_del", blobShaByPath: new Map() });

    const result = await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    const arg = commitMock.mock.calls[0]![0];
    expect(arg.upserts).toEqual([]);
    expect(arg.deletes).toEqual([{ path: "brain/gone.md" }]);
    expect(result).toMatchObject({ status: "synced", deletes: 1 });
  });

  it("treats a rename (previousPath) as add-new + delete-old in one commit", async () => {
    const { db } = createDb({
      jobs: [
        {
          id: 4,
          workspaceId: "wsp_1",
          repoPath: "brain/new.md",
          sourceKind: "brain",
          sourceRef: null,
          operation: "upsert",
          desiredHash: "h_r",
          previousPath: "brain/old.md",
          attempts: 0,
        },
      ],
      workspaces: [WORKSPACE],
      brainFiles: [
        // Even though already synced at this hash, the rename must still move it.
        { path: "new.md", content: "R", contentHash: "h_r", githubSyncedHash: "h_r" },
      ],
    });
    dbMocks.getDb.mockReturnValue(db as never);
    commitMock.mockResolvedValue({
      commitSha: "commit_r",
      blobShaByPath: new Map([["brain/new.md", "blob_r"]]),
    });

    await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    const arg = commitMock.mock.calls[0]![0];
    expect(arg.upserts).toEqual([{ path: "brain/new.md", content: "R" }]);
    expect(arg.deletes).toEqual([{ path: "brain/old.md" }]);
  });

  it("does not delete a path that is recreated in the same commit", async () => {
    const { db } = createDb({
      jobs: [
        {
          id: 5,
          workspaceId: "wsp_1",
          repoPath: "brain/recreated.md",
          sourceKind: "brain",
          sourceRef: null,
          operation: "upsert",
          desiredHash: "h_recreated",
          previousPath: null,
          attempts: 0,
        },
        {
          id: 6,
          workspaceId: "wsp_1",
          repoPath: "brain/new.md",
          sourceKind: "brain",
          sourceRef: null,
          operation: "upsert",
          desiredHash: "h_new",
          previousPath: "brain/recreated.md",
          attempts: 0,
        },
      ],
      workspaces: [WORKSPACE],
      brainFiles: [
        {
          path: "recreated.md",
          content: "Recreated",
          contentHash: "h_recreated",
          githubSyncedHash: null,
        },
        {
          path: "new.md",
          content: "Renamed",
          contentHash: "h_new",
          githubSyncedHash: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db as never);
    commitMock.mockResolvedValue({
      commitSha: "commit_recreate",
      blobShaByPath: new Map([["brain/recreated.md", "blob_recreated"]]),
    });

    await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    const arg = commitMock.mock.calls[0]![0];
    expect(arg.upserts).toEqual([
      { path: "brain/recreated.md", content: "Recreated" },
      { path: "brain/new.md", content: "Renamed" },
    ]);
    expect(arg.deletes).toEqual([]);
  });

  it("preserves delegated agents and opt-in skills when projecting agent source", async () => {
    const { db } = createDb({
      jobs: [
        {
          id: 7,
          workspaceId: "wsp_1",
          repoPath: "agents/leo/leo.agent",
          sourceKind: "agent",
          sourceRef: "agt_1",
          operation: "upsert",
          desiredHash: "h_agent",
          previousPath: null,
          attempts: 0,
        },
      ],
      workspaces: [WORKSPACE],
      agents: [
        {
          id: "agt_1",
          workspaceId: "wsp_1",
          path: "agents/leo/leo.agent",
          name: "Leo",
          body: "Coordinate with the research agent.",
          githubSyncedHash: null,
          config: {
            model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
            tools: [],
            brain: [],
            agents: [{ path: "agents/research/research.agent", name: "Research" }],
            skills: [{ id: "agent-self-edit" }],
            integrations: { github: { repositories: [] } },
            triggers: [],
          },
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db as never);
    commitMock.mockResolvedValue({
      commitSha: "commit_agent",
      blobShaByPath: new Map([["agents/leo/leo.agent", "blob_agent"]]),
    });

    await projectWorkspaceToGitHub({ workspaceId: "wsp_1" });

    const content = commitMock.mock.calls[0]![0].upserts[0]?.content ?? "";
    expect(content).toContain("agents:");
    expect(content).toContain("path: agents/research/research.agent");
    expect(content).toContain("skills:");
    expect(content).toContain("- agent-self-edit");
  });
});

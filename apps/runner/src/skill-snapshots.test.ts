import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetcher,
  resolveSkill,
  createGitHubSkillFetcher,
  selectRows,
  limit,
  updateWhere,
  onConflictDoUpdate,
  db,
} = vi.hoisted(() => {
  const fetcher = {
    defaultBranch: vi.fn(),
    resolveCommit: vi.fn(),
    fetchTree: vi.fn(),
    fetchBlob: vi.fn(),
  };
  const resolveSkill = vi.fn();
  const createGitHubSkillFetcher = vi.fn(() => fetcher);
  const selectRows: unknown[] = [];
  const limit = vi.fn(() => Promise.resolve(selectRows));
  const updateWhere = vi.fn(() => Promise.resolve());
  const onConflictDoUpdate = vi.fn(() => Promise.resolve());
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: updateWhere }) })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate }) })),
  };
  return {
    fetcher,
    resolveSkill,
    createGitHubSkillFetcher,
    selectRows,
    limit,
    updateWhere,
    onConflictDoUpdate,
    db,
  };
});

vi.mock("@opencompany/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/agent-runtime")>();
  return { ...actual, createGitHubSkillFetcher, resolveSkill };
});
vi.mock("./db", () => ({ getDb: () => db }));
vi.mock("@opencompany/observability", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { loadExternalSkillFiles } from "./skill-snapshots";

const ref = {
  id: "improve-codebase-architecture",
  name: "Improve Codebase Architecture",
  description: "x",
  source: {
    type: "github" as const,
    url: "https://github.com/mattpocock/skills",
    ref: "main",
    path: "skills/improve-codebase-architecture",
  },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "skl_1",
    skillId: ref.id,
    resolvedCommit: "a".repeat(40),
    files: [{ path: "SKILL.md", content: "cached" }],
    lastResolvedAt: new Date(),
    ...overrides,
  };
}

describe("loadExternalSkillFiles", () => {
  beforeEach(() => {
    selectRows.length = 0;
    vi.clearAllMocks();
  });

  it("reuses a fresh snapshot without hitting GitHub", async () => {
    selectRows.push(row({ lastResolvedAt: new Date() }));
    const result = await loadExternalSkillFiles("ws_1", [ref]);
    expect(result).toEqual([{ id: ref.id, files: [{ path: "SKILL.md", content: "cached" }] }]);
    expect(createGitHubSkillFetcher).not.toHaveBeenCalled();
  });

  it("revalidates a stale snapshot and reuses files when HEAD is unchanged", async () => {
    selectRows.push(row({ lastResolvedAt: new Date(Date.now() - 60 * 60 * 1000) }));
    fetcher.resolveCommit.mockResolvedValue("a".repeat(40));
    const result = await loadExternalSkillFiles("ws_1", [ref]);
    expect(fetcher.resolveCommit).toHaveBeenCalled();
    expect(resolveSkill).not.toHaveBeenCalled();
    expect(updateWhere).toHaveBeenCalled();
    expect(result[0]?.files).toEqual([{ path: "SKILL.md", content: "cached" }]);
  });

  it("re-resolves and upserts when HEAD has moved", async () => {
    selectRows.push(row({ lastResolvedAt: new Date(0) }));
    fetcher.resolveCommit.mockResolvedValue("b".repeat(40));
    resolveSkill.mockResolvedValue({
      status: "resolved",
      skill: {
        skillId: ref.id,
        name: ref.name,
        description: ref.description,
        source: ref.source,
        resolvedCommit: "b".repeat(40),
        integrity: `sha256:${"c".repeat(64)}`,
        files: [{ path: "SKILL.md", content: "fresh" }],
        fileCount: 1,
        totalBytes: 5,
      },
    });
    const result = await loadExternalSkillFiles("ws_1", [ref]);
    expect(onConflictDoUpdate).toHaveBeenCalled();
    expect(result[0]?.files).toEqual([{ path: "SKILL.md", content: "fresh" }]);
  });

  it("skips a skill that can't be resolved and has no cached snapshot", async () => {
    fetcher.resolveCommit.mockRejectedValue(new Error("network"));
    const result = await loadExternalSkillFiles("ws_1", [ref]);
    expect(result).toEqual([]);
  });

  it("falls back to the cached snapshot when a refresh fails", async () => {
    selectRows.push(row({ lastResolvedAt: new Date(0) }));
    fetcher.resolveCommit.mockRejectedValue(new Error("network"));
    const result = await loadExternalSkillFiles("ws_1", [ref]);
    expect(result[0]?.files).toEqual([{ path: "SKILL.md", content: "cached" }]);
  });
});

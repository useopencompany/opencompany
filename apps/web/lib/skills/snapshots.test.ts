import { describe, expect, test } from "vitest";
import type { WorkspaceSkillSnapshot } from "@/lib/skills/snapshots";
import { findSnapshotForSource, toExternalSkillReference } from "@/lib/skills/snapshots";

function snapshot(overrides: Partial<WorkspaceSkillSnapshot> = {}): WorkspaceSkillSnapshot {
  return {
    id: "skl_1",
    workspaceId: "ws_1",
    skillId: "improve-codebase-architecture",
    name: "Improve Codebase Architecture",
    description: "Analyze codebases for architectural friction.",
    sourceType: "github",
    sourceUrl: "https://github.com/mattpocock/skills",
    requestedRef: "main",
    skillPath: "skills/improve-codebase-architecture",
    resolvedCommit: "a".repeat(40),
    integrity: `sha256:${"b".repeat(64)}`,
    files: [{ path: "SKILL.md", content: "x" }],
    fileCount: 1,
    totalBytes: 1,
    lastResolvedAt: new Date(0),
    schemaVersion: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("toExternalSkillReference", () => {
  test("maps a snapshot row to a frontmatter external reference (no files)", () => {
    expect(toExternalSkillReference(snapshot())).toEqual({
      id: "improve-codebase-architecture",
      name: "Improve Codebase Architecture",
      description: "Analyze codebases for architectural friction.",
      source: {
        type: "github",
        url: "https://github.com/mattpocock/skills",
        ref: "main",
        path: "skills/improve-codebase-architecture",
      },
    });
  });

  test("preserves a skills.sh source type", () => {
    expect(toExternalSkillReference(snapshot({ sourceType: "skills.sh" })).source.type).toBe(
      "skills.sh",
    );
  });
});

describe("findSnapshotForSource", () => {
  test("matches on url + ref + path", () => {
    const rows = [
      snapshot(),
      snapshot({ id: "skl_2", skillId: "other", skillPath: "skills/other" }),
    ];
    const found = findSnapshotForSource(rows, {
      type: "github",
      url: "https://github.com/mattpocock/skills",
      ref: "main",
      path: "skills/other",
    });
    expect(found?.id).toBe("skl_2");
  });

  test("returns undefined when nothing matches", () => {
    expect(
      findSnapshotForSource([snapshot()], {
        type: "github",
        url: "https://github.com/other/repo",
        ref: "main",
        path: "",
      }),
    ).toBeUndefined();
  });
});

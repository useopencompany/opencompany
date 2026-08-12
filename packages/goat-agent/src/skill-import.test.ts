import { describe, expect, it, vi } from "vitest";
import { resolveGoatSkillImport } from "./skill-import";

const resolveSkillMock = vi.hoisted(() => vi.fn());

vi.mock("@opencompany/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("@opencompany/agent-runtime")>(
    "@opencompany/agent-runtime",
  );
  return {
    ...actual,
    resolveSkill: resolveSkillMock,
    createGitHubSkillFetcher: () => ({}) as never,
  };
});

describe("resolveGoatSkillImport", () => {
  it("strips SKILL.md frontmatter and reports ignored bundled files", async () => {
    resolveSkillMock.mockResolvedValueOnce({
      status: "resolved",
      skill: {
        skillId: "ignored-mount-id",
        name: "My Skill",
        description: "Does things.",
        source: { type: "github", url: "https://github.com/o/r", ref: "main", path: "" },
        resolvedCommit: "a".repeat(40),
        integrity: `sha256:${"b".repeat(64)}`,
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: My Skill\ndescription: Does things.\n---\nDo the thing.",
          },
          { path: "references/notes.md", content: "extra" },
          { path: "scripts/run.sh", content: "#!/bin/sh" },
        ],
      },
    });

    const preview = await resolveGoatSkillImport({ url: "https://github.com/o/r" });

    expect(preview).toMatchObject({
      status: "resolved",
      proposedSlug: "my-skill",
      name: "My Skill",
      instructions: "Do the thing.",
      extraFiles: ["references/notes.md", "scripts/run.sh"],
      source: { type: "github", url: "https://github.com/o/r", ref: "main", path: "" },
    });
  });

  it("returns bounded candidate metadata for an ambiguous repository", async () => {
    resolveSkillMock.mockResolvedValueOnce({
      status: "ambiguous",
      candidates: [
        { path: "skills/a", name: "A", description: "a." },
        { path: "skills/b", name: "B", description: "b." },
      ],
      source: { type: "github", url: "https://github.com/o/r", ref: "main" },
      resolvedCommit: "a".repeat(40),
    });

    await expect(resolveGoatSkillImport({ url: "https://github.com/o/r" })).resolves.toEqual({
      status: "ambiguous",
      candidates: [
        { path: "skills/a", name: "A", description: "a." },
        { path: "skills/b", name: "B", description: "b." },
      ],
      source: { type: "github", url: "https://github.com/o/r", ref: "main" },
    });
  });

  it("maps resolver validation failures to a safe client error", async () => {
    const { SkillResolverError } = await vi.importActual<
      typeof import("@opencompany/agent-runtime")
    >("@opencompany/agent-runtime");
    resolveSkillMock.mockRejectedValueOnce(
      new SkillResolverError("No SKILL.md found in that repository or path."),
    );

    await expect(resolveGoatSkillImport({ url: "https://github.com/o/r" })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "No SKILL.md found in that repository or path.",
    });
  });

  it("maps upstream failures to a retryable unavailable domain error", async () => {
    resolveSkillMock.mockRejectedValueOnce(new Error("upstream token=do-not-expose"));

    await expect(resolveGoatSkillImport({ url: "https://github.com/o/r" })).rejects.toMatchObject({
      code: "unavailable",
      message: "Couldn't read that skill right now. Check the URL and try again.",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { GoatSkillImportError, previewGoatSkillImport } from "@/lib/skill-import";

const resolveSkillMock = vi.hoisted(() => vi.fn());

vi.mock("@opencompany/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("@opencompany/agent-runtime")>(
    "@opencompany/agent-runtime",
  );
  return {
    ...actual,
    resolveSkill: resolveSkillMock,
    // Never actually called: resolveSkill is mocked above, so the real network fetcher is
    // never reached. A real (empty) object is enough to satisfy the type.
    createGitHubSkillFetcher: () => ({}) as never,
  };
});

describe("previewGoatSkillImport", () => {
  it("strips SKILL.md frontmatter into instructions and lists non-SKILL.md files as extras", async () => {
    resolveSkillMock.mockResolvedValueOnce({
      status: "resolved",
      skill: {
        skillId: "ignored-apps-web-mount-id",
        name: "My Skill",
        description: "Does things.",
        source: { type: "github", url: "https://github.com/o/r", ref: "main", path: "" },
        resolvedCommit: "a".repeat(40),
        integrity: "sha256:abc",
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: My Skill\ndescription: Does things.\n---\nDo the thing.",
          },
          { path: "references/notes.md", content: "extra" },
          { path: "scripts/run.sh", content: "#!/bin/sh" },
        ],
        fileCount: 3,
        totalBytes: 90,
      },
    });

    const preview = await previewGoatSkillImport({ url: "https://github.com/o/r" });

    expect(preview.status).toBe("resolved");
    if (preview.status !== "resolved") return;
    // Proposes a Goat-scheme slug from the name, ignoring the resolver's own apps/web-scheme
    // skillId entirely (that id is tied to the built-in skill namespace, not Goat's).
    expect(preview.proposedSlug).toBe("my-skill");
    expect(preview.name).toBe("My Skill");
    expect(preview.instructions).toBe("Do the thing.");
    expect(preview.extraFiles).toEqual(["references/notes.md", "scripts/run.sh"]);
    expect(preview.source).toEqual({
      type: "github",
      url: "https://github.com/o/r",
      ref: "main",
      path: "",
    });
  });

  it("passes through an ambiguous multi-skill repo as candidates", async () => {
    resolveSkillMock.mockResolvedValueOnce({
      status: "ambiguous",
      candidates: [
        { path: "skills/a", name: "A", description: "a." },
        { path: "skills/b", name: "B", description: "b." },
      ],
      source: { type: "github", url: "https://github.com/o/r", ref: "main" },
      resolvedCommit: "a".repeat(40),
    });

    const preview = await previewGoatSkillImport({ url: "https://github.com/o/r" });

    expect(preview).toEqual({
      status: "ambiguous",
      candidates: [
        { path: "skills/a", name: "A", description: "a." },
        { path: "skills/b", name: "B", description: "b." },
      ],
      source: { type: "github", url: "https://github.com/o/r", ref: "main" },
    });
  });

  it("wraps a resolver failure as GoatSkillImportError with the resolver's message", async () => {
    const { SkillResolverError } = await vi.importActual<
      typeof import("@opencompany/agent-runtime")
    >("@opencompany/agent-runtime");
    resolveSkillMock.mockRejectedValueOnce(
      new SkillResolverError("No SKILL.md found in that repository or path."),
    );

    await expect(previewGoatSkillImport({ url: "https://github.com/o/r" })).rejects.toMatchObject({
      constructor: GoatSkillImportError,
      message: "No SKILL.md found in that repository or path.",
    });
  });
});

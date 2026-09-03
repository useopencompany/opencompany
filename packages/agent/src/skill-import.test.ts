import { describe, expect, it, vi } from "vitest";
import { resolveSkillImport } from "./skill-import";

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

describe("resolveSkillImport", () => {
  it("retains the complete resolved bundle without legacy Brain validation", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    resolveSkillMock.mockResolvedValueOnce({
      status: "resolved",
      skill: {
        name: "my-skill",
        description: "Does things.",
        body: "Do the thing.",
        source: { type: "github", url: "https://github.com/o/r", ref: "main", path: "" },
        resolvedCommit: "a".repeat(40),
        integrity: `sha256:${"b".repeat(64)}`,
        files: [
          {
            path: "SKILL.md",
            content: encode("---\nname: my-skill\ndescription: Does things.\n---\nDo the thing."),
            executable: false,
          },
          { path: "references/notes.md", content: encode("extra"), executable: false },
          { path: "scripts/run.sh", content: encode("#!/bin/sh"), executable: true },
        ],
        fileCount: 3,
        totalBytes: 0,
        warnings: [
          {
            code: "source_directory_normalized",
            message: "Source directory normalized.",
          },
        ],
      },
    });

    const preview = await resolveSkillImport({ url: "https://github.com/o/r" });

    expect(preview).toMatchObject({
      status: "resolved",
      warnings: [
        {
          code: "source_directory_normalized",
          message: "Source directory normalized.",
        },
      ],
      bundle: {
        name: "my-skill",
        body: "Do the thing.",
        source: {
          type: "github",
          url: "https://github.com/o/r",
          ref: "main",
          path: "",
          resolvedCommit: "a".repeat(40),
        },
        files: [
          { path: "SKILL.md", executable: false },
          { path: "references/notes.md", executable: false },
          { path: "scripts/run.sh", executable: true },
        ],
      },
    });
  });

  it("returns bounded candidate metadata for an ambiguous repository", async () => {
    resolveSkillMock.mockResolvedValueOnce({
      status: "ambiguous",
      candidates: [
        { path: "skills/a", name: "A", description: "a." },
        { path: "skills/b", name: "B", description: "b." },
      ],
      source: {
        type: "github",
        url: "https://github.com/o/r",
        ref: "main",
        resolvedCommit: "a".repeat(40),
      },
      resolvedCommit: "a".repeat(40),
    });

    await expect(resolveSkillImport({ url: "https://github.com/o/r" })).resolves.toEqual({
      status: "ambiguous",
      candidates: [
        { path: "skills/a", name: "A", description: "a." },
        { path: "skills/b", name: "B", description: "b." },
      ],
      source: {
        type: "github",
        url: "https://github.com/o/r",
        ref: "main",
        resolvedCommit: "a".repeat(40),
      },
    });
  });

  it("maps resolver validation failures to a safe client error", async () => {
    const { SkillResolverError } = await vi.importActual<
      typeof import("@opencompany/agent-runtime")
    >("@opencompany/agent-runtime");
    resolveSkillMock.mockRejectedValueOnce(
      new SkillResolverError("No SKILL.md found in that repository or path."),
    );

    await expect(resolveSkillImport({ url: "https://github.com/o/r" })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "No SKILL.md found in that repository or path.",
    });
  });

  it("maps upstream failures to a retryable unavailable domain error", async () => {
    resolveSkillMock.mockRejectedValueOnce(new Error("upstream token=do-not-expose"));

    const error = await resolveSkillImport({ url: "https://github.com/o/r" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "unavailable",
      message: "Couldn't read that skill right now. Check the URL and try again.",
    });
    expect(error).not.toHaveProperty("cause");
  });

  it("retains sanitized GitHub diagnostics as the unavailable error cause", async () => {
    const { GitHubArtifactFetchError } = await vi.importActual<
      typeof import("@opencompany/agent-runtime")
    >("@opencompany/agent-runtime");
    const upstreamError = new GitHubArtifactFetchError({
      operation: "resolve_commit",
      failureKind: "rate_limit",
      durationMs: 12,
      status: 403,
      rateLimitRemaining: 0,
    });
    resolveSkillMock.mockRejectedValueOnce(upstreamError);

    const error = await resolveSkillImport({ url: "https://github.com/o/r" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "unavailable",
      message: "Couldn't read that skill right now. Check the URL and try again.",
      cause: upstreamError,
    });
  });
});

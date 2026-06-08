import { describe, expect, test } from "vitest";
import {
  discoverSkillDirectories,
  ensureSkillMountId,
  normalizeSkillCommand,
  parseSkillFrontmatter,
  parseSkillUrl,
  resolveSkill,
  SkillResolverError,
  type SkillResolverFetcher,
  type SkillTreeEntry,
  slugifySkillName,
  validateSkillFiles,
} from "./skill-resolver";

describe("parseSkillUrl", () => {
  test("parses a github repo url", () => {
    expect(parseSkillUrl("https://github.com/mattpocock/skills")).toMatchObject({
      sourceType: "github",
      owner: "mattpocock",
      repo: "skills",
      url: "https://github.com/mattpocock/skills",
    });
  });

  test("parses a github tree url with ref and subpath", () => {
    expect(parseSkillUrl("https://github.com/o/r/tree/dev/skills/foo")).toMatchObject({
      owner: "o",
      repo: "r",
      ref: "dev",
      subpath: "skills/foo",
    });
  });

  test("parses a #ref fragment", () => {
    expect(parseSkillUrl("https://github.com/o/r#release")).toMatchObject({ ref: "release" });
  });

  test("strips a .git suffix", () => {
    expect(parseSkillUrl("https://github.com/o/r.git").repo).toBe("r");
  });

  test("parses a skills.sh page url into the backing github repo + name filter", () => {
    expect(
      parseSkillUrl("https://www.skills.sh/mattpocock/skills/improve-codebase-architecture"),
    ).toMatchObject({
      sourceType: "skills.sh",
      owner: "mattpocock",
      repo: "skills",
      url: "https://github.com/mattpocock/skills",
      nameFilter: "improve-codebase-architecture",
    });
  });

  test("parses owner/repo shorthand with @name and #ref", () => {
    expect(parseSkillUrl("o/r@my-skill#main")).toMatchObject({
      owner: "o",
      repo: "r",
      nameFilter: "my-skill",
      ref: "main",
    });
  });

  test("rejects a non-allowlisted host (SSRF guard)", () => {
    expect(() => parseSkillUrl("https://evil.example.com/o/r")).toThrow(SkillResolverError);
  });

  test("rejects non-https", () => {
    expect(() => parseSkillUrl("http://github.com/o/r")).toThrow(SkillResolverError);
  });

  test("rejects path traversal in a subpath", () => {
    expect(() => parseSkillUrl("o/r/../../etc")).toThrow(SkillResolverError);
  });
});

describe("slugifySkillName / ensureSkillMountId", () => {
  test("slugifies a display name", () => {
    expect(slugifySkillName("Improve Codebase Architecture")).toBe("improve-codebase-architecture");
  });

  test("suffixes when colliding with a built-in id", () => {
    const id = ensureSkillMountId("agent-self-edit", "sha256:abcdef1234567890", new Set());
    expect(id).not.toBe("agent-self-edit");
    expect(id).toContain("abcdef");
  });

  test("suffixes when colliding with a reserved workspace id", () => {
    const id = ensureSkillMountId("pdf", "sha256:abcdef1234567890", new Set(["pdf"]));
    expect(id).toBe("pdf-abcdef");
  });
});

describe("discoverSkillDirectories", () => {
  const tree: SkillTreeEntry[] = [
    { path: "SKILL.md", type: "blob", mode: "100644" },
    { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
    { path: "skills/b/SKILL.md", type: "blob", mode: "100644" },
    { path: "README.md", type: "blob", mode: "100644" },
  ];

  test("finds all SKILL.md directories, root first", () => {
    expect(discoverSkillDirectories(tree)).toEqual(["", "skills/a", "skills/b"]);
  });

  test("honors a subpath filter", () => {
    expect(discoverSkillDirectories(tree, "skills/b")).toEqual(["skills/b"]);
  });
});

describe("parseSkillFrontmatter", () => {
  test("reads name and description", () => {
    expect(parseSkillFrontmatter("---\nname: Foo\ndescription: Bar\n---\nbody")).toEqual({
      name: "Foo",
      description: "Bar",
    });
  });

  test("returns null without frontmatter or required fields", () => {
    expect(parseSkillFrontmatter("no frontmatter")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: Foo\n---\nbody")).toBeNull();
  });

  test("reads an optional command slug", () => {
    expect(
      parseSkillFrontmatter("---\nname: Foo\ndescription: Bar\ncommand: /Graph-ify\n---\nbody"),
    ).toEqual({ name: "Foo", description: "Bar", command: "graph_ify" });
  });

  test("omits command when absent or empty after normalization", () => {
    expect(parseSkillFrontmatter("---\nname: Foo\ndescription: Bar\n---\nbody")).not.toHaveProperty(
      "command",
    );
    expect(
      parseSkillFrontmatter("---\nname: Foo\ndescription: Bar\ncommand: '!!!'\n---\nbody"),
    ).not.toHaveProperty("command");
  });
});

describe("normalizeSkillCommand", () => {
  test("strips leading slash, lowercases, and collapses separators to underscores", () => {
    expect(normalizeSkillCommand("/Graph-ify")).toBe("graph_ify");
    expect(normalizeSkillCommand("Deep Research")).toBe("deep_research");
    expect(normalizeSkillCommand("deep_research")).toBe("deep_research");
  });

  test("returns null for non-strings or empty slugs", () => {
    expect(normalizeSkillCommand(undefined)).toBeNull();
    expect(normalizeSkillCommand(42)).toBeNull();
    expect(normalizeSkillCommand("///")).toBeNull();
  });
});

describe("validateSkillFiles", () => {
  test("accepts a valid skill", () => {
    expect(
      validateSkillFiles([
        { path: "SKILL.md", content: "---\nname: a\ndescription: b\n---\nhi" },
        { path: "LANGUAGE.md", content: "more" },
      ]),
    ).toBeNull();
  });

  test("requires a SKILL.md", () => {
    expect(validateSkillFiles([{ path: "README.md", content: "x" }])).toMatch(/SKILL\.md/);
  });

  test("rejects path traversal", () => {
    expect(
      validateSkillFiles([
        { path: "SKILL.md", content: "x" },
        { path: "../escape.md", content: "x" },
      ]),
    ).toMatch(/unsafe/);
  });

  test("rejects a binary file", () => {
    expect(
      validateSkillFiles([{ path: "SKILL.md", content: `bad${String.fromCharCode(0)}byte` }]),
    ).toMatch(/text file/);
  });
});

function fakeFetcher(input: {
  tree: SkillTreeEntry[];
  blobs: Record<string, string>;
  defaultBranch?: string;
  commit?: string;
}): SkillResolverFetcher {
  return {
    defaultBranch: async () => input.defaultBranch ?? "main",
    resolveCommit: async () => input.commit ?? "a".repeat(40),
    fetchTree: async () => input.tree,
    fetchBlob: async (_o, _r, _c, path) => {
      if (!(path in input.blobs)) throw new Error(`missing blob ${path}`);
      return input.blobs[path]!;
    },
  };
}

describe("resolveSkill", () => {
  test("resolves a single-skill repo", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "SKILL.md", type: "blob", mode: "100644" },
        { path: "LANGUAGE.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "SKILL.md": "---\nname: My Skill\ndescription: Does things.\n---\nbody",
        "LANGUAGE.md": "secondary",
      },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r", fetcher });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.skillId).toBe("my-skill");
    expect(result.skill.source.path).toBe("");
    expect(result.skill.files.map((f) => f.path).sort()).toEqual(["LANGUAGE.md", "SKILL.md"]);
    expect(result.skill.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("returns candidates when the repo has multiple skills", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/b/SKILL.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "skills/a/SKILL.md": "---\nname: A\ndescription: a.\n---\nx",
        "skills/b/SKILL.md": "---\nname: B\ndescription: b.\n---\ny",
      },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r", fetcher });
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates.map((c) => c.path)).toEqual(["skills/a", "skills/b"]);
  });

  test("resolves a chosen candidate by path", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/b/SKILL.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "skills/a/SKILL.md": "---\nname: A\ndescription: a.\n---\nx",
        "skills/b/SKILL.md": "---\nname: B\ndescription: b.\n---\ny",
      },
    });
    const result = await resolveSkill({
      url: "https://github.com/o/r",
      fetcher,
      selectedPath: "skills/b",
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.skillId).toBe("b");
    expect(result.skill.source.path).toBe("skills/b");
  });

  test("skills.sh name filter picks the matching skill", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/improve/SKILL.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "skills/a/SKILL.md": "---\nname: A\ndescription: a.\n---\nx",
        "skills/improve/SKILL.md":
          "---\nname: Improve Codebase Architecture\ndescription: i.\n---\ny",
      },
    });
    const result = await resolveSkill({
      url: "https://www.skills.sh/o/r/improve-codebase-architecture",
      fetcher,
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.skillId).toBe("improve-codebase-architecture");
  });

  test("throws when no SKILL.md exists", async () => {
    const fetcher = fakeFetcher({
      tree: [{ path: "README.md", type: "blob", mode: "100644" }],
      blobs: {},
    });
    await expect(resolveSkill({ url: "https://github.com/o/r", fetcher })).rejects.toThrow(
      SkillResolverError,
    );
  });

  test("rejects a symlink in the skill folder", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "SKILL.md", type: "blob", mode: "100644" },
        { path: "link", type: "blob", mode: "120000" },
      ],
      blobs: { "SKILL.md": "---\nname: A\ndescription: a.\n---\nx", link: "../somewhere" },
    });
    await expect(resolveSkill({ url: "https://github.com/o/r", fetcher })).rejects.toThrow(
      /symlink/,
    );
  });
});

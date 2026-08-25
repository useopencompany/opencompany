import { describe, expect, test } from "vitest";
import {
  discoverSkillDirectories,
  parseSkillUrl,
  resolveSkill,
  SkillResolverError,
  type SkillResolverFetcher,
  type SkillTreeEntry,
} from "./skill-resolver";

const enc = new TextEncoder();
const dec = new TextDecoder();

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

  test("normalizes repeated separators in a subpath", () => {
    expect(parseSkillUrl("o/r///skills////safe///").subpath).toBe("skills/safe");
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

type Blob = Uint8Array | string;

function fakeFetcher(input: {
  tree: SkillTreeEntry[];
  blobs: Record<string, Blob>;
  truncated?: boolean;
  defaultBranch?: string;
  commit?: string;
}): SkillResolverFetcher {
  return {
    defaultBranch: async () => input.defaultBranch ?? "main",
    resolveCommit: async () => input.commit ?? "a".repeat(40),
    fetchTree: async () => ({ entries: input.tree, truncated: input.truncated ?? false }),
    fetchBlob: async (_o, _r, _c, path) => {
      if (!(path in input.blobs)) throw new Error(`missing blob ${path}`);
      const value = input.blobs[path]!;
      return typeof value === "string" ? enc.encode(value) : value;
    },
  };
}

// A minimal valid SKILL.md whose name matches directory `name`.
function skillMd(name: string, body = "Body."): string {
  return `---\nname: ${name}\ndescription: Does ${name} things.\n---\n${body}`;
}

describe("resolveSkill: happy paths", () => {
  test("resolves a single subdirectory skill and keeps raw bytes", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/my-skill/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/my-skill/notes.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "skills/my-skill/SKILL.md": skillMd("my-skill", "Do the thing."),
        "skills/my-skill/notes.md": "secondary",
      },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r", fetcher });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.name).toBe("my-skill");
    expect(result.skill.body).toBe("Do the thing.");
    expect(result.skill.source.path).toBe("skills/my-skill");
    expect(result.skill.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "notes.md"]);
    expect(result.skill.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
    const skillFile = result.skill.files.find((f) => f.path === "SKILL.md");
    expect(skillFile?.content).toBeInstanceOf(Uint8Array);
    expect(dec.decode(skillFile?.content)).toContain("name: my-skill");
  });

  test("resolves a repository-root skill by matching the repo name", async () => {
    const fetcher = fakeFetcher({
      tree: [{ path: "SKILL.md", type: "blob", mode: "100644" }],
      blobs: { "SKILL.md": skillMd("r") },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r", fetcher });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.name).toBe("r");
    expect(result.skill.source.path).toBe("");
  });

  test("retains the executable bit from the git mode", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "s/SKILL.md", type: "blob", mode: "100644" },
        { path: "s/run.sh", type: "blob", mode: "100755" },
      ],
      blobs: { "s/SKILL.md": skillMd("s"), "s/run.sh": "#!/bin/sh\n" },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r/tree/main/s", fetcher });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    const files = Object.fromEntries(result.skill.files.map((f) => [f.path, f.executable]));
    expect(files["run.sh"]).toBe(true);
    expect(files["SKILL.md"]).toBe(false);
  });

  test("retains binary bytes and empty files without decoding them", async () => {
    const binary = Uint8Array.from([0x00, 0xff, 0x10, 0x80]);
    const fetcher = fakeFetcher({
      tree: [
        { path: "s/SKILL.md", type: "blob", mode: "100644" },
        { path: "s/logo.bin", type: "blob", mode: "100644" },
        { path: "s/empty.txt", type: "blob", mode: "100644" },
      ],
      blobs: { "s/SKILL.md": skillMd("s"), "s/logo.bin": binary, "s/empty.txt": enc.encode("") },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r/tree/main/s", fetcher });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    const binFile = result.skill.files.find((f) => f.path === "logo.bin");
    expect(binFile?.content).toEqual(binary);
    const emptyFile = result.skill.files.find((f) => f.path === "empty.txt");
    expect(emptyFile?.content.length).toBe(0);
  });

  test("returns candidates when the repo has multiple valid skills", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/b/SKILL.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "skills/a/SKILL.md": skillMd("a"),
        "skills/b/SKILL.md": skillMd("b"),
      },
    });
    const result = await resolveSkill({ url: "https://github.com/o/r", fetcher });
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates.map((c) => c.path)).toEqual(["skills/a", "skills/b"]);
    expect(result.candidates.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("resolves a chosen candidate by path", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/b/SKILL.md", type: "blob", mode: "100644" },
      ],
      blobs: { "skills/a/SKILL.md": skillMd("a"), "skills/b/SKILL.md": skillMd("b") },
    });
    const result = await resolveSkill({
      url: "https://github.com/o/r",
      fetcher,
      selectedPath: "skills/b",
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.name).toBe("b");
    expect(result.skill.source.path).toBe("skills/b");
  });

  test("skills.sh name filter picks the matching skill", async () => {
    const fetcher = fakeFetcher({
      tree: [
        { path: "skills/a/SKILL.md", type: "blob", mode: "100644" },
        { path: "skills/improve-codebase-architecture/SKILL.md", type: "blob", mode: "100644" },
      ],
      blobs: {
        "skills/a/SKILL.md": skillMd("a"),
        "skills/improve-codebase-architecture/SKILL.md": skillMd("improve-codebase-architecture"),
      },
    });
    const result = await resolveSkill({
      url: "https://www.skills.sh/o/r/improve-codebase-architecture",
      fetcher,
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.skill.name).toBe("improve-codebase-architecture");
  });
});

describe("resolveSkill: rejection fixtures", () => {
  type Rejection = {
    label: string;
    tree: SkillTreeEntry[];
    blobs: Record<string, Blob>;
    truncated?: boolean;
    match: RegExp;
  };

  const cases: Rejection[] = [
    {
      label: "no SKILL.md anywhere",
      tree: [{ path: "README.md", type: "blob", mode: "100644" }],
      blobs: {},
      match: /No SKILL\.md/,
    },
    {
      label: "truncated github tree",
      tree: [{ path: "s/SKILL.md", type: "blob", mode: "100644" }],
      blobs: { "s/SKILL.md": skillMd("s") },
      truncated: true,
      match: /too large to read completely/,
    },
    {
      label: "symlink inside the skill folder",
      tree: [
        { path: "s/SKILL.md", type: "blob", mode: "100644" },
        { path: "s/link", type: "blob", mode: "120000" },
      ],
      blobs: { "s/SKILL.md": skillMd("s"), "s/link": "../secret" },
      match: /Symlink/i,
    },
    {
      label: "submodule inside the skill folder",
      tree: [
        { path: "s/SKILL.md", type: "blob", mode: "100644" },
        { path: "s/vendor", type: "commit", mode: "160000" },
      ],
      blobs: { "s/SKILL.md": skillMd("s") },
      match: /submodule/i,
    },
    {
      label: ".git path inside the skill folder",
      tree: [
        { path: "s/SKILL.md", type: "blob", mode: "100644" },
        { path: "s/.git/config", type: "blob", mode: "100644" },
      ],
      blobs: { "s/SKILL.md": skillMd("s"), "s/.git/config": "x" },
      match: /\.git/,
    },
    {
      label: "directory-name mismatch",
      tree: [{ path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }],
      blobs: { "skills/foo/SKILL.md": skillMd("bar") },
      match: /must match its directory name/,
    },
    {
      label: "unknown frontmatter field",
      tree: [{ path: "skills/foo/SKILL.md", type: "blob", mode: "100644" }],
      blobs: {
        "skills/foo/SKILL.md": "---\nname: foo\ndescription: d\nunexpected: 1\n---\nbody",
      },
      match: /Unknown frontmatter field/,
    },
    {
      label: "oversize single file",
      tree: [
        { path: "s/SKILL.md", type: "blob", mode: "100644" },
        { path: "s/big.txt", type: "blob", mode: "100644" },
      ],
      blobs: {
        "s/SKILL.md": skillMd("s"),
        "s/big.txt": enc.encode("a".repeat(512 * 1024 + 1)),
      },
      match: /too large/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.label, async () => {
      const fetcher = fakeFetcher({
        tree: testCase.tree,
        blobs: testCase.blobs,
        ...(testCase.truncated ? { truncated: true } : {}),
      });
      await expect(resolveSkill({ url: "https://github.com/o/r", fetcher })).rejects.toThrow(
        testCase.match,
      );
    });
  }

  test("too many files exceeds the skill file-count limit", async () => {
    const tree: SkillTreeEntry[] = [{ path: "s/SKILL.md", type: "blob", mode: "100644" }];
    const blobs: Record<string, Blob> = { "s/SKILL.md": skillMd("s") };
    for (let i = 0; i < 64; i++) {
      tree.push({ path: `s/f${i}.txt`, type: "blob", mode: "100644" });
      blobs[`s/f${i}.txt`] = "x";
    }
    const fetcher = fakeFetcher({ tree, blobs });
    await expect(
      resolveSkill({ url: "https://github.com/o/r/tree/main/s", fetcher }),
    ).rejects.toThrow(/too many files/);
  });
});

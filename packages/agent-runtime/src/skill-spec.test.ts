import { describe, expect, test } from "vitest";
import { parseSkillDocument, SkillSpecError } from "./skill-spec";

describe("parseSkillDocument: accepted documents", () => {
  test("parses all six frontmatter fields and returns the exact body", () => {
    const content = [
      "---",
      "name: my-skill",
      "description: Does the thing.",
      "license: MIT",
      "compatibility: node>=20",
      "metadata:",
      "  team: platform",
      "  tier: gold",
      "allowed-tools: read write",
      "---",
      "Body line one.",
      "Body line two.",
    ].join("\n");
    const parsed = parseSkillDocument(content, "my-skill");
    expect(parsed.frontmatter).toEqual({
      name: "my-skill",
      description: "Does the thing.",
      license: "MIT",
      compatibility: "node>=20",
      metadata: { team: "platform", tier: "gold" },
      allowedTools: "read write",
    });
    expect(parsed.body).toBe("Body line one.\nBody line two.");
    expect(content.slice(parsed.bodyStart)).toBe(parsed.body);
  });

  test("omits optional fields that are absent", () => {
    const parsed = parseSkillDocument("---\nname: foo\ndescription: bar\n---\nbody", "foo");
    expect(parsed.frontmatter).toEqual({ name: "foo", description: "bar" });
    expect(parsed.frontmatter).not.toHaveProperty("license");
    expect(parsed.frontmatter).not.toHaveProperty("metadata");
  });

  type BoundaryCase = { label: string; content: string; body: string };
  const boundaryCases: BoundaryCase[] = [
    {
      label: "LF newlines",
      content: "---\nname: foo\ndescription: bar\n---\nHello.",
      body: "Hello.",
    },
    {
      label: "CRLF newlines",
      content: "---\r\nname: foo\r\ndescription: bar\r\n---\r\nHello.",
      body: "Hello.",
    },
    {
      label: "UTF-8 BOM before the opening delimiter",
      content: "\uFEFF---\nname: foo\ndescription: bar\n---\nHello.",
      body: "Hello.",
    },
    {
      label: "no trailing newline after the body",
      content: "---\nname: foo\ndescription: bar\n---\nNo trailing newline",
      body: "No trailing newline",
    },
    {
      label: "no body at all (closing delimiter at EOF)",
      content: "---\nname: foo\ndescription: bar\n---",
      body: "",
    },
    {
      label: "empty body after closing newline",
      content: "---\nname: foo\ndescription: bar\n---\n",
      body: "",
    },
  ];

  for (const boundary of boundaryCases) {
    test(`body boundary: ${boundary.label}`, () => {
      const parsed = parseSkillDocument(boundary.content, "foo");
      expect(parsed.frontmatter.name).toBe("foo");
      expect(parsed.body).toBe(boundary.body);
      expect(boundary.content.slice(parsed.bodyStart)).toBe(parsed.body);
    });
  }
});

describe("parseSkillDocument: rejected documents", () => {
  type Rejection = { label: string; content: string; expected: string; match: RegExp };
  const cases: Rejection[] = [
    {
      label: "no frontmatter block",
      content: "just a body with no frontmatter",
      expected: "foo",
      match: /must begin with a YAML frontmatter block/,
    },
    {
      label: "unterminated frontmatter",
      content: "---\nname: foo\ndescription: bar\n",
      expected: "foo",
      match: /must begin with a YAML frontmatter block/,
    },
    {
      label: "missing required name",
      content: "---\ndescription: bar\n---\nbody",
      expected: "foo",
      match: /`name` must be a string/,
    },
    {
      label: "missing required description",
      content: "---\nname: foo\n---\nbody",
      expected: "foo",
      match: /`description` must be a string/,
    },
    {
      label: "empty description",
      content: "---\nname: foo\ndescription: '   '\n---\nbody",
      expected: "foo",
      match: /`description` must be 1-1024/,
    },
    {
      label: "name with uppercase",
      content: "---\nname: Foo\ndescription: bar\n---\nbody",
      expected: "Foo",
      match: /`name` must be 1-64 lowercase/,
    },
    {
      label: "name with consecutive hyphens",
      content: "---\nname: foo--bar\ndescription: bar\n---\nbody",
      expected: "foo--bar",
      match: /`name` must be 1-64 lowercase/,
    },
    {
      label: "name not matching directory",
      content: "---\nname: foo\ndescription: bar\n---\nbody",
      expected: "different-dir",
      match: /must match its directory name/,
    },
    {
      label: "unknown top-level field",
      content: "---\nname: foo\ndescription: bar\nauthor: someone\n---\nbody",
      expected: "foo",
      match: /Unknown frontmatter field `author`/,
    },
    {
      label: "legacy command extension",
      content: "---\nname: foo\ndescription: bar\ncommand: run\n---\nbody",
      expected: "foo",
      match: /Unknown frontmatter field `command`/,
    },
    {
      label: "metadata with a non-string value",
      content: "---\nname: foo\ndescription: bar\nmetadata:\n  count: 3\n---\nbody",
      expected: "foo",
      match: /metadata\.count` must be a string/,
    },
    {
      label: "compatibility with the wrong type",
      content: "---\nname: foo\ndescription: bar\ncompatibility: 3\n---\nbody",
      expected: "foo",
      match: /`compatibility` must be a string/,
    },
    {
      label: "allowed-tools with the wrong type",
      content: "---\nname: foo\ndescription: bar\nallowed-tools:\n  - read\n---\nbody",
      expected: "foo",
      match: /`allowed-tools` must be a string/,
    },
  ];

  for (const testCase of cases) {
    test(testCase.label, () => {
      expect(() => parseSkillDocument(testCase.content, testCase.expected)).toThrow(SkillSpecError);
      expect(() => parseSkillDocument(testCase.content, testCase.expected)).toThrow(testCase.match);
    });
  }

  test("rejects a description longer than 1024 characters", () => {
    const content = `---\nname: foo\ndescription: ${"x".repeat(1025)}\n---\nbody`;
    expect(() => parseSkillDocument(content, "foo")).toThrow(/`description` must be 1-1024/);
  });
});

import { describe, expect, it } from "vitest";
import { contextReference, contextReferenceRanges, referenceMarkdown } from "./context-references";

describe("cosmetic context references", () => {
  it("preserves exact offsets, escaped labels, and repeated targets", () => {
    const reference = { label: "Team [Slack]", href: "/plugins/slack" };
    const link = referenceMarkdown(reference);
    const text = `Ask ${link}, then ${link}.`;
    const ranges = contextReferenceRanges(text);
    expect(ranges).toHaveLength(2);
    for (const range of ranges) {
      expect(text.slice(range.start, range.end)).toBe(link);
      expect(range.label).toBe(reference.label);
      expect(range.href).toBe(reference.href);
    }
  });
  it("keeps Markdown punctuation in reference labels literal", () => {
    const label = "team/_repo_";
    const href = "https://github.com/team/_repo_";
    const ranges = contextReferenceRanges(referenceMarkdown({ label, href }));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ label, href });
  });
  it("leaves prose, code, escaped links, and unsupported URLs literal", () => {
    const link = "[Slack](/plugins/slack)";
    expect(
      contextReferenceRanges(
        `Slack @slack \`${link}\`\n\n\`\`\`\n${link}\n\`\`\`\n\n\\${link}\n[Other](https://example.com)`,
      ),
    ).toEqual([]);
    for (const href of [
      "javascript:alert(1)",
      "//github.com/org/repo",
      "https://github.com.evil/org/repo",
      "/plugins/../settings",
      "https://github.com/org/repo/issues/1",
    ])
      expect(contextReference(href, "label")).toBeNull();
  });
  it("recognizes a repository without any installation or agent metadata", () => {
    expect(
      contextReferenceRanges("Review [org/repo](https://github.com/org/repo)")[0],
    ).toMatchObject({
      kind: "repository",
      label: "org/repo",
      href: "https://github.com/org/repo",
      plugin: "github",
    });
  });
});

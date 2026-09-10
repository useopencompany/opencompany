import { describe, expect, it } from "vitest";
import { extractWorkflowSkillMentionRefs } from "./workflow-skill-mentions";

describe("extractWorkflowSkillMentionRefs", () => {
  it("deduplicates plain and Markdown-escaped installation IDs", () => {
    expect(
      extractWorkflowSkillMentionRefs(
        String.raw`Use @skill/skill_installation_abc and @skill/skill\_installation\_abc, then @skill/WRITING.`,
      ),
    ).toEqual([{ id: "skill_installation_abc" }, { id: "writing" }]);
  });

  it("finds mentions in formatted prose, lists, and tables", () => {
    expect(
      extractWorkflowSkillMentionRefs(
        [
          "**@skill/research** and [@skill/writing](https://example.com).",
          "",
          "- @skill/review",
          "",
          "| Step |",
          "| --- |",
          "| @skill/publish |",
        ].join("\n"),
      ),
    ).toEqual([{ id: "research" }, { id: "writing" }, { id: "review" }, { id: "publish" }]);
  });

  it("does not activate examples in code, HTML comments, or link destinations", () => {
    expect(
      extractWorkflowSkillMentionRefs(
        [
          "Example: `use @skill/inline-example`.",
          "",
          "```text",
          "@skill/fenced-example",
          "```",
          "",
          "    @skill/indented-example",
          "",
          "<!-- @skill/comment-example -->",
          "",
          '[Documentation](https://example.com/@skill/url-example " @skill/title-example")',
          "",
          "Use @skill/real-skill.",
        ].join("\n"),
      ),
    ).toEqual([{ id: "real-skill" }]);
  });

  it("preserves the ID length limit without accepting a truncated prefix", () => {
    const longestId = "a".repeat(200);
    expect(extractWorkflowSkillMentionRefs(`@skill/${longestId}`)).toEqual([{ id: longestId }]);
    expect(extractWorkflowSkillMentionRefs(`@skill/${longestId}a`)).toEqual([]);
  });
});

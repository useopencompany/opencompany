import { extractWorkflowSkillMentionRefs } from "@opencompany/agent/workflow-skill-mentions";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import { describe, expect, it } from "vitest";
import { filterSkillMentionItems, skillMentionInsertText } from "./SkillMentionSuggestion";

const STANDUP_NOTES = {
  scope: "company" as const,
  id: "standup-notes",
  name: "Standup notes",
  description: "Summarize yesterday's activity",
};
const RELEASE_NOTES = {
  scope: "company" as const,
  id: "release-notes",
  name: "Release notes",
  description: "Draft a changelog entry",
};
const CUSTOMER_DIGEST = {
  scope: "company" as const,
  id: "customer-digest",
  name: "Customer digest",
  description: "Summarize support threads",
};
const SKILLS = [STANDUP_NOTES, RELEASE_NOTES, CUSTOMER_DIGEST];

describe("filterSkillMentionItems", () => {
  it("returns every skill for an empty query", () => {
    expect(filterSkillMentionItems(SKILLS, "")).toEqual(SKILLS);
  });

  it("matches on id, name, or description, case-insensitively", () => {
    expect(filterSkillMentionItems(SKILLS, "RELEASE")).toEqual([RELEASE_NOTES]);
    expect(filterSkillMentionItems(SKILLS, "changelog")).toEqual([RELEASE_NOTES]);
    expect(filterSkillMentionItems(SKILLS, "support")).toEqual([CUSTOMER_DIGEST]);
  });

  it("returns nothing when no skill matches", () => {
    expect(filterSkillMentionItems(SKILLS, "nonexistent")).toEqual([]);
  });

  it("caps results at 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      scope: "company" as const,
      id: `skill-${i}`,
      name: `Skill ${i}`,
      description: "",
    }));
    expect(filterSkillMentionItems(many, "")).toHaveLength(8);
  });
});

describe("skillMentionInsertText", () => {
  it("produces the @skill/<id> token workflow-tasks.ts resolves at fire time", () => {
    expect(skillMentionInsertText(STANDUP_NOTES)).toBe("@skill/standup-notes ");
  });

  it("resolves the selected installation after saving and reopening Markdown", () => {
    const skill = { ...STANDUP_NOTES, id: "skill_installation_0123456789abcdef" };
    const editor = new Editor({
      extensions: [StarterKit, Markdown],
      content: "",
    });
    try {
      editor.commands.insertContent(skillMentionInsertText(skill));
      const markdown = editor.getMarkdown();
      expect(markdown).toContain(String.raw`@skill/skill\_installation\_0123456789abcdef`);
      expect(extractWorkflowSkillMentionRefs(markdown)).toEqual([{ id: skill.id }]);

      editor.commands.setContent(markdown, { contentType: "markdown" });
      expect(editor.getText().trim()).toBe(`@skill/${skill.id}`);
      expect(extractWorkflowSkillMentionRefs(editor.getMarkdown())).toEqual([{ id: skill.id }]);
    } finally {
      editor.destroy();
    }
  });
});

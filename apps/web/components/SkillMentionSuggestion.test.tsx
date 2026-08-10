import { describe, expect, it } from "vitest";
import { filterSkillMentionItems, skillMentionInsertText } from "./SkillMentionSuggestion";

const STANDUP_NOTES = {
  id: "standup-notes",
  name: "Standup notes",
  description: "Summarize yesterday's activity",
};
const RELEASE_NOTES = {
  id: "release-notes",
  name: "Release notes",
  description: "Draft a changelog entry",
};
const CUSTOMER_DIGEST = {
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
});

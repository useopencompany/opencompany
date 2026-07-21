import { describe, expect, it } from "vitest";
import { parseGoatBrainDocument, serializeGoatBrainDocument } from "./document";
import { goatBrainSkillFromDocument, serializeGoatBrainSkillMarkdown } from "./skills";

function skillDocument(
  overrides: { id?: string; description?: string; instructions?: string; status?: string } = {},
) {
  return parseGoatBrainDocument(
    serializeGoatBrainDocument({
      frontmatter: {
        id: overrides.id ?? "coding-work",
        folder: "skills/engineering",
        kind: "page",
        type: "note",
        status: (overrides.status ?? "draft") as "draft",
        title: "Coding work",
        ...(overrides.description === undefined
          ? { description: "How coding work should happen." }
          : overrides.description
            ? { description: overrides.description }
            : {}),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Coding work",
      compiledTruth: overrides.instructions ?? "Inspect, implement, and verify.",
      timeline: [],
    }),
  );
}

describe("Goat Brain skills", () => {
  it("materializes a complete draft or active page as a standard SKILL.md", () => {
    const skill = goatBrainSkillFromDocument(skillDocument());
    expect(skill).toEqual({
      id: "coding-work",
      name: "Coding work",
      description: "How coding work should happen.",
      instructions: "Inspect, implement, and verify.",
    });
    expect(serializeGoatBrainSkillMarkdown(skill!)).toBe(
      '---\nname: "coding-work"\ndescription: "How coding work should happen."\n---\n\nInspect, implement, and verify.\n',
    );
    expect(goatBrainSkillFromDocument(skillDocument({ status: "active" }))).not.toBeNull();
  });

  it("materializes a skill without a description", () => {
    const skill = goatBrainSkillFromDocument(skillDocument({ description: "" }));
    expect(skill).toEqual({
      id: "coding-work",
      name: "Coding work",
      description: "",
      instructions: "Inspect, implement, and verify.",
    });
    expect(serializeGoatBrainSkillMarkdown(skill!)).toBe(
      '---\nname: "coding-work"\n---\n\nInspect, implement, and verify.\n',
    );
  });

  it("excludes incomplete, archived, and merged pages", () => {
    expect(goatBrainSkillFromDocument(skillDocument({ instructions: "" }))).toBeNull();
    expect(goatBrainSkillFromDocument(skillDocument({ id: "Coding work" }))).toBeNull();
    expect(goatBrainSkillFromDocument(skillDocument({ id: `s${"x".repeat(64)}` }))).toBeNull();
    expect(
      goatBrainSkillFromDocument(skillDocument({ description: "Use <unsafe> markup." })),
    ).toBeNull();
    expect(goatBrainSkillFromDocument(skillDocument({ description: "x".repeat(1025) }))).toBeNull();
    expect(goatBrainSkillFromDocument(skillDocument({ status: "archived" }))).toBeNull();
    expect(goatBrainSkillFromDocument(skillDocument({ status: "merged" }))).toBeNull();
  });
});

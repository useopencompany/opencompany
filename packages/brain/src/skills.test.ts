import { describe, expect, it } from "vitest";
import { parseBrainDocument, serializeBrainDocument } from "./document";
import { brainSkillFromDocument, serializeBrainSkillMarkdown } from "./skills";

function skillDocument(
  overrides: { id?: string; description?: string; instructions?: string; status?: string } = {},
) {
  return parseBrainDocument(
    serializeBrainDocument({
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

describe("opencompany Brain skills", () => {
  it("materializes a complete draft or active page as a standard SKILL.md", () => {
    const skill = brainSkillFromDocument(skillDocument());
    expect(skill).toEqual({
      id: "coding-work",
      name: "Coding work",
      description: "How coding work should happen.",
      instructions: "Inspect, implement, and verify.",
    });
    expect(serializeBrainSkillMarkdown(skill!)).toBe(
      '---\nname: "coding-work"\ndescription: "How coding work should happen."\n---\n\nInspect, implement, and verify.\n',
    );
    expect(brainSkillFromDocument(skillDocument({ status: "active" }))).not.toBeNull();
  });

  it("materializes a skill without a description", () => {
    const skill = brainSkillFromDocument(skillDocument({ description: "" }));
    expect(skill).toEqual({
      id: "coding-work",
      name: "Coding work",
      description: "",
      instructions: "Inspect, implement, and verify.",
    });
    expect(serializeBrainSkillMarkdown(skill!)).toBe(
      '---\nname: "coding-work"\n---\n\nInspect, implement, and verify.\n',
    );
  });

  it("excludes incomplete, archived, and merged pages", () => {
    expect(brainSkillFromDocument(skillDocument({ instructions: "" }))).toBeNull();
    expect(brainSkillFromDocument(skillDocument({ id: "Coding work" }))).toBeNull();
    expect(brainSkillFromDocument(skillDocument({ id: `s${"x".repeat(64)}` }))).toBeNull();
    expect(
      brainSkillFromDocument(skillDocument({ description: "Use <unsafe> markup." })),
    ).toBeNull();
    expect(brainSkillFromDocument(skillDocument({ description: "x".repeat(1025) }))).toBeNull();
    expect(brainSkillFromDocument(skillDocument({ status: "archived" }))).toBeNull();
    expect(brainSkillFromDocument(skillDocument({ status: "merged" }))).toBeNull();
  });
});

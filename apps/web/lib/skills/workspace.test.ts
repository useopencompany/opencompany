import { describe, expect, it } from "vitest";
import {
  agentReferencesWorkspaceSkill,
  nextWorkspaceSkillId,
  serializeWorkspaceSkill,
  toWorkspaceSkillReference,
  workspaceSkillRepoPath,
} from "@/lib/skills/workspace";

describe("workspace skills", () => {
  it("serializes fields into a valid SKILL.md", () => {
    const result = serializeWorkspaceSkill({
      name: " Brand Voice ",
      description: " Use when writing copy. ",
      body: "# Rules\n\n- Be concrete.\n",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("Brand Voice");
    expect(result.description).toBe("Use when writing copy.");
    expect(result.content).toContain("name: Brand Voice");
    expect(result.content).toContain("description: Use when writing copy.");
    expect(result.content).toContain("# Rules");
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("rejects missing required fields", () => {
    expect(serializeWorkspaceSkill({ name: "", description: "x", body: "" })).toEqual({
      ok: false,
      error: "Skill name is required.",
    });
    expect(serializeWorkspaceSkill({ name: "x", description: "", body: "" })).toEqual({
      ok: false,
      error: "Skill description is required.",
    });
  });

  it("allocates ids without colliding with reserved ids", () => {
    const reserved = new Set(["brand-voice", "brand-voice-2"]);
    expect(nextWorkspaceSkillId("brand-voice", reserved)).toBe("brand-voice-3");
  });

  it("detects body and config references before deletion", () => {
    expect(
      agentReferencesWorkspaceSkill({
        body: "Use @skill/brand-voice.",
        config: { skills: [] },
        skillId: "brand-voice",
      }),
    ).toBe(true);
    expect(
      agentReferencesWorkspaceSkill({
        body: "No mention.",
        config: {
          skills: [
            {
              id: "brand-voice",
              name: "Brand Voice",
              description: "Use when writing copy.",
              source: { type: "workspace", path: "skills/brand-voice" },
            },
          ],
        },
        skillId: "brand-voice",
      }),
    ).toBe(true);
  });

  it("builds repo paths and agent references", () => {
    expect(workspaceSkillRepoPath("brand-voice")).toBe("skills/brand-voice/SKILL.md");
    expect(
      toWorkspaceSkillReference({
        skillId: "brand-voice",
        name: "Brand Voice",
        description: "Use when writing copy.",
      }),
    ).toEqual({
      id: "brand-voice",
      name: "Brand Voice",
      description: "Use when writing copy.",
      source: { type: "workspace", path: "skills/brand-voice" },
    });
  });
});

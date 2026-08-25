import { describe, expect, it } from "vitest";
import { createWorkspaceSkillArtifact } from "./workspace-skill";

describe("createWorkspaceSkillArtifact", () => {
  it("creates a standard, integrity-bound SKILL.md without host-only command frontmatter", async () => {
    const artifact = await createWorkspaceSkillArtifact({
      name: "investigate-bug",
      description: "Investigate reported bugs: reproduce them and identify the root cause.",
      instructions: "Reproduce the issue first.\n\nThen trace the failing boundary.",
    });

    const content = new TextDecoder().decode(artifact.files[0]!.content);
    expect(artifact).toMatchObject({
      name: "investigate-bug",
      source: { type: "workspace" },
      body: "Reproduce the issue first.\n\nThen trace the failing boundary.\n",
      fileCount: 1,
    });
    expect(artifact.integrity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(content).toContain("name: investigate-bug");
    expect(content).not.toContain("command:");
  });

  it("rejects invalid standard names and empty instructions", async () => {
    await expect(
      createWorkspaceSkillArtifact({
        name: "Invalid Name",
        description: "Valid",
        instructions: "Do it.",
      }),
    ).rejects.toThrow(/lowercase alphanumeric/u);
    await expect(
      createWorkspaceSkillArtifact({ name: "valid", description: "Valid", instructions: "  " }),
    ).rejects.toThrow(/instructions must not be empty/u);
  });
});

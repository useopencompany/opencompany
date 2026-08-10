import { beforeEach, describe, expect, it, vi } from "vitest";
import { importGoatSkillAction, previewGoatSkillImportAction } from "@/lib/skill-actions";

const mocks = vi.hoisted(() => ({
  currentGoatUser: vi.fn(),
  previewGoatSkillImport: vi.fn(),
  createImportedGoatSkill: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ currentGoatUser: mocks.currentGoatUser }));
vi.mock("@/lib/skill-import", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skill-import")>("@/lib/skill-import");
  return { ...actual, previewGoatSkillImport: mocks.previewGoatSkillImport };
});
vi.mock("@/lib/skills", () => ({
  archiveGoatSkill: vi.fn(),
  createGoatSkill: vi.fn(),
  createImportedGoatSkill: mocks.createImportedGoatSkill,
  updateGoatSkill: vi.fn(),
}));

const resolvedCommit = "a".repeat(40);
const integrity = `sha256:${"b".repeat(64)}`;
const resolvedSkill = {
  status: "resolved" as const,
  proposedSlug: "my-skill",
  name: "My Skill",
  description: "Does things.",
  instructions: "Do the thing.",
  source: {
    type: "github" as const,
    url: "https://github.com/o/r",
    ref: "main",
    path: "",
  },
  resolvedCommit,
  integrity,
  extraFiles: [] as string[],
};

describe("Goat skill import actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentGoatUser.mockResolvedValue({
      role: "admin",
      workspace: { id: "workspace_1" },
      user: { workosUserId: "user_1" },
    });
    mocks.previewGoatSkillImport.mockResolvedValue(resolvedSkill);
    mocks.createImportedGoatSkill.mockResolvedValue({ ok: true, slug: "my-skill" });
  });

  it("returns the commit and integrity that the confirmation must bind to", async () => {
    await expect(previewGoatSkillImportAction({ url: "github.com/o/r" })).resolves.toEqual({
      status: "resolved",
      proposedSlug: "my-skill",
      name: "My Skill",
      description: "Does things.",
      instructions: "Do the thing.",
      extraFiles: [],
      resolvedCommit,
      integrity,
    });
  });

  it("rejects an import when the source changed after preview", async () => {
    const result = await importGoatSkillAction({
      url: "github.com/o/r",
      expectedResolvedCommit: "c".repeat(40),
      expectedIntegrity: integrity,
    });

    expect(result).toEqual({
      status: "error",
      message: "This skill changed since the preview. Preview it again before importing.",
    });
    expect(mocks.createImportedGoatSkill).not.toHaveBeenCalled();
  });

  it("imports the exact content that was previewed", async () => {
    const result = await importGoatSkillAction({
      url: "github.com/o/r",
      expectedResolvedCommit: resolvedCommit,
      expectedIntegrity: integrity,
    });

    expect(result).toEqual({ status: "imported", slug: "my-skill" });
    expect(mocks.createImportedGoatSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        instructions: "Do the thing.",
        resolvedCommit,
        integrity,
      }),
    );
  });
});

import type { HarnessSpec } from "@opencompany/db/product-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ name: "db" })),
  loadImmutableSkillBundles: vi.fn(async () => []),
  resolveLegacyWorkflowSkillAccess: vi.fn(async () => "company" as const),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("@opencompany/db/skill-bundle-repository", () => ({
  loadImmutableSkillBundles: mocks.loadImmutableSkillBundles,
}));
vi.mock("@opencompany/db/harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/harness")>();
  return {
    ...actual,
    resolveLegacyWorkflowSkillAccess: mocks.resolveLegacyWorkflowSkillAccess,
  };
});

const { loadWorkflowTaskSkillBundles } = await import("./workflow-skill-bundles");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ name: "db" });
  mocks.loadImmutableSkillBundles.mockResolvedValue([]);
  mocks.resolveLegacyWorkflowSkillAccess.mockResolvedValue("company");
});

describe("loadWorkflowTaskSkillBundles", () => {
  it("loads actor-authorized bundles for a Personal workflow", async () => {
    await loadWorkflowTaskSkillBundles(harness("actor"), "user_1");

    expect(mocks.resolveLegacyWorkflowSkillAccess).not.toHaveBeenCalled();
    expect(mocks.loadImmutableSkillBundles).toHaveBeenCalledWith(
      { name: "db" },
      {
        workspaceId: "workspace_1",
        userId: "user_1",
        bundleIds: ["skill_bundle_private_v1"],
      },
    );
  });

  it("keeps Company workflows company-only", async () => {
    await loadWorkflowTaskSkillBundles(harness("company"), "user_1");

    expect(mocks.loadImmutableSkillBundles).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ skillAccess: "company" }),
    );
  });

  it("uses the guarded workflow lookup for a persisted legacy harness", async () => {
    mocks.resolveLegacyWorkflowSkillAccess.mockResolvedValue("actor");
    await loadWorkflowTaskSkillBundles(harness(), "user_1");

    expect(mocks.resolveLegacyWorkflowSkillAccess).toHaveBeenCalledWith(
      { name: "db" },
      { workspaceId: "workspace_1", workflowId: "private-report", userId: "user_1" },
    );
    expect(mocks.loadImmutableSkillBundles).toHaveBeenCalledWith(
      { name: "db" },
      expect.not.objectContaining({ skillAccess: "company" }),
    );
  });
});

function harness(skillAccess?: "company" | "actor"): HarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: "moonshotai/kimi-k2.6",
    systemPrompt: "Prepare the report.",
    initialUserMessage: "Prepare the report.",
    tools: [],
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
    workflow: {
      id: "private-report",
      workspaceId: "workspace_1",
      ...(skillAccess ? { skillAccess } : {}),
      skillIds: ["private-notes"],
      skillBundleIds: ["skill_bundle_private_v1"],
      pluginIds: [],
      currentStepIndex: 0,
      completedStepCount: 0,
      steps: [
        {
          index: 0,
          title: "Prepare",
          engine: "opencompany",
          model: "moonshotai/kimi-k2.6",
          systemPrompt: "Prepare the report.",
          systemBlocks: ["Prepare the report."],
          skillIds: ["private-notes"],
          skillBundleIds: ["skill_bundle_private_v1"],
        },
      ],
    },
  };
}

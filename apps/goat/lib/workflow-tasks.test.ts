import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGoatTaskForUser: vi.fn(),
  isGoatCodexConnectedForUser: vi.fn(),
  getGoatAvailableHarnessTools: vi.fn(),
  resolveGoatSkillMentions: vi.fn(),
  resolveGoatWorkflowMention: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({ createGoatTaskForUser: mocks.createGoatTaskForUser }));
vi.mock("@/lib/codex-auth", () => ({
  isGoatCodexConnectedForUser: mocks.isGoatCodexConnectedForUser,
}));
vi.mock("@/lib/integrations/google-data", () => ({
  getGoatAvailableHarnessTools: mocks.getGoatAvailableHarnessTools,
}));
vi.mock("@/lib/chat-title", () => ({ generateGoatChatTitle: vi.fn() }));
vi.mock("@/lib/skills", () => ({ resolveGoatSkillMentions: mocks.resolveGoatSkillMentions }));
vi.mock("@/lib/workflows", () => ({
  resolveGoatWorkflowMention: mocks.resolveGoatWorkflowMention,
  GoatWorkflowMentionError: class GoatWorkflowMentionError extends Error {},
}));
vi.mock("@opencompany/db/client", () => ({ getDb: vi.fn() }));

const {
  compileGoatWorkflowHarnessSpec,
  createGoatTaskFromWorkflow,
  extractGoatWorkflowSkillMentionRefs,
  resolveGoatWorkflowStepSelection,
} = await import("@/lib/workflow-tasks");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isGoatCodexConnectedForUser.mockResolvedValue(true);
  mocks.getGoatAvailableHarnessTools.mockResolvedValue(["exa_search"]);
  mocks.resolveGoatSkillMentions.mockResolvedValue([]);
});

describe("resolveGoatWorkflowStepSelection", () => {
  it("defaults to the opencompany engine on Kimi", () => {
    expect(resolveGoatWorkflowStepSelection({ model: "", instructions: "Do the work." })).toEqual({
      engine: "opencompany",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("prefers the step model field over inline mentions", () => {
    expect(
      resolveGoatWorkflowStepSelection({
        model: "sonnet-5",
        instructions: "Fix the bug with @codex.",
      }),
    ).toEqual({
      engine: "opencompany",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("uses an inline model mention for a backfilled step", () => {
    expect(
      resolveGoatWorkflowStepSelection({
        model: "",
        instructions: "Fix the bug with @codex.",
      }),
    ).toEqual({
      engine: "codex",
      model: "openai/gpt-5.5",
    });
  });

  it("rejects unavailable and ambiguous step models", () => {
    expect(() =>
      resolveGoatWorkflowStepSelection({ model: "gpt-9", instructions: "Do it." }),
    ).toThrowError(/not available/);
    expect(() =>
      resolveGoatWorkflowStepSelection({
        model: "",
        instructions: "Try @codex or @sonnet-5.",
      }),
    ).toThrowError(/more than one model/);
  });
});

describe("extractGoatWorkflowSkillMentionRefs", () => {
  it("collects deduped skill mentions from one step", () => {
    expect(
      extractGoatWorkflowSkillMentionRefs(
        "Use @skill/research and @skill/writing then @skill/research again.",
      ),
    ).toEqual([{ id: "research" }, { id: "writing" }]);
  });
});

describe("compileGoatWorkflowHarnessSpec", () => {
  it("compiles independent step models and skills with a step-zero compatibility mirror", () => {
    const spec = compileGoatWorkflowHarnessSpec({
      workflow: {
        id: "weekly-report",
        name: "Weekly report",
        description: "Compiles the weekly report.",
        trigger: "manual",
        steps: [
          {
            id: "step-1",
            title: "Research",
            model: "kimi-k2.6",
            instructions: "Collect updates with @skill/research.",
          },
          {
            id: "step-2",
            title: "Implement",
            model: "codex",
            instructions: "Apply the findings with @skill/coding-work.",
          },
        ],
      },
      workspaceId: "ws_1",
      skills: [
        {
          id: "research",
          name: "Research",
          description: "How to research",
          instructions: "Search broadly.",
        },
        {
          id: "coding-work",
          name: "Coding work",
          description: "How to implement",
          instructions: "Inspect, implement, and verify.",
        },
      ],
      tools: ["exa_search"],
      description: "Prepare this week's report",
    });

    expect(spec).toMatchObject({
      schemaVersion: "goat.harness.v1",
      engine: "opencompany",
      model: "moonshotai/kimi-k2.6",
      initialUserMessage: expect.stringContaining("Prepare this week's report"),
      workflow: {
        id: "weekly-report",
        workspaceId: "ws_1",
        skillIds: ["research", "coding-work"],
        currentStepIndex: 0,
      },
    });
    expect(spec.systemPrompt).toBe(spec.workflow?.steps?.[0]?.systemPrompt);
    expect(spec.systemBlocks).toEqual(spec.workflow?.steps?.[0]?.systemBlocks);
    expect(spec.workflow?.steps).toHaveLength(2);
    expect(spec.workflow?.steps?.[0]).toMatchObject({
      index: 0,
      title: "Research",
      engine: "opencompany",
      model: "moonshotai/kimi-k2.6",
      skillIds: ["research"],
    });
    expect(spec.workflow?.steps?.[0]?.systemPrompt).toContain('name: "research"');
    expect(spec.workflow?.steps?.[0]?.systemPrompt).not.toContain('name: "coding-work"');
    expect(spec.workflow?.steps?.[1]).toMatchObject({
      index: 1,
      title: "Implement",
      engine: "codex",
      model: "openai/gpt-5.5",
      skillIds: ["coding-work"],
    });
    expect(spec.workflow?.steps?.[1]?.systemPrompt).not.toContain("<workflow_skills>");
    expect(spec.workflow?.skillSnapshots).toEqual([
      {
        id: "research",
        name: "Research",
        description: "How to research",
        instructions: "Search broadly.",
      },
      {
        id: "coding-work",
        name: "Coding work",
        description: "How to implement",
        instructions: "Inspect, implement, and verify.",
      },
    ]);
  });
});

describe("createGoatTaskFromWorkflow", () => {
  it("requires Codex connectivity when any workflow step uses Codex", async () => {
    mocks.resolveGoatWorkflowMention.mockResolvedValue({
      id: "mixed-workflow",
      name: "Mixed workflow",
      description: "",
      trigger: "manual",
      steps: [
        {
          id: "step-1",
          title: "Research",
          model: "kimi-k2.6",
          instructions: "Research.",
        },
        {
          id: "step-2",
          title: "Code",
          model: "codex",
          instructions: "Implement.",
        },
      ],
    });
    mocks.isGoatCodexConnectedForUser.mockResolvedValue(false);

    await expect(
      createGoatTaskFromWorkflow({
        userWorkosId: "user_1",
        workspaceId: "ws_1",
        mention: { id: "mixed-workflow" },
        description: "Run it",
      }),
    ).rejects.toThrow(/uses Codex/);

    expect(mocks.isGoatCodexConnectedForUser).toHaveBeenCalledWith("user_1");
    expect(mocks.createGoatTaskForUser).not.toHaveBeenCalled();
  });

  it("resolves the union of step skills once and queues step zero's model", async () => {
    mocks.resolveGoatWorkflowMention.mockResolvedValue({
      id: "mixed-workflow",
      name: "Mixed workflow",
      description: "",
      trigger: "manual",
      steps: [
        {
          id: "step-1",
          title: "Research",
          model: "kimi-k2.6",
          instructions: "Use @skill/research.",
        },
        {
          id: "step-2",
          title: "Write",
          model: "sonnet-5",
          instructions: "Use @skill/writing and @skill/research.",
        },
      ],
    });
    mocks.resolveGoatSkillMentions.mockResolvedValue([
      { id: "research", name: "Research", description: "", instructions: "Research well." },
      { id: "writing", name: "Writing", description: "", instructions: "Write clearly." },
    ]);
    mocks.createGoatTaskForUser.mockResolvedValue({ id: "task_1" });

    await createGoatTaskFromWorkflow({
      userWorkosId: "user_1",
      workspaceId: "ws_1",
      mention: { id: "mixed-workflow" },
      description: "Run it",
    });

    expect(mocks.resolveGoatSkillMentions).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      mentions: [{ id: "research" }, { id: "writing" }],
    });
    expect(mocks.createGoatTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "moonshotai/kimi-k2.6",
        workflowId: "mixed-workflow",
      }),
    );
  });
});

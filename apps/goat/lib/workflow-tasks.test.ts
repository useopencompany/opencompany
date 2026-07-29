import { describe, expect, it, vi } from "vitest";

// workflow-tasks pulls in server-only modules (auth, db, tasks); the pure
// parsing/compile functions under test never touch them.
vi.mock("@/lib/tasks", () => ({ createGoatTaskForUser: vi.fn() }));
vi.mock("@/lib/codex-auth", () => ({ isGoatCodexConnectedForUser: vi.fn() }));
vi.mock("@/lib/integrations/google-data", () => ({ getGoatAvailableHarnessTools: vi.fn() }));
vi.mock("@/lib/chat-title", () => ({ generateGoatChatTitle: vi.fn() }));
vi.mock("@/lib/skills", () => ({ resolveGoatSkillMentions: vi.fn() }));
vi.mock("@/lib/workflows", () => ({
  resolveGoatWorkflowMention: vi.fn(),
  GoatWorkflowMentionError: class GoatWorkflowMentionError extends Error {},
}));
vi.mock("@opencompany/db/client", () => ({ getDb: vi.fn() }));

const {
  compileGoatWorkflowHarnessSpec,
  extractGoatWorkflowSkillMentionRefs,
  parseGoatWorkflowEngineSelection,
} = await import("@/lib/workflow-tasks");

describe("parseGoatWorkflowEngineSelection", () => {
  it("defaults to the opencompany engine on kimi when nothing is selected", () => {
    expect(parseGoatWorkflowEngineSelection({ instructions: "Just do the work." })).toEqual({
      engine: "opencompany",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("prefers the frontmatter model over instruction mentions", () => {
    expect(
      parseGoatWorkflowEngineSelection({
        model: "sonnet-5",
        instructions: "Fix the bug with @codex please",
      }),
    ).toEqual({
      engine: "opencompany",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("throws on an unknown frontmatter model", () => {
    expect(() =>
      parseGoatWorkflowEngineSelection({ model: "gpt-9", instructions: "Do it." }),
    ).toThrowError(/not available/);
  });

  it("selects codex from an @codex mention", () => {
    expect(
      parseGoatWorkflowEngineSelection({ instructions: "Fix the bug with @codex please" }),
    ).toEqual({
      engine: "codex",
      model: "openai/gpt-5.5",
    });
  });

  it("selects a goat model from a model mention", () => {
    expect(parseGoatWorkflowEngineSelection({ instructions: "Write it on @sonnet-5." })).toEqual({
      engine: "opencompany",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("ignores skill mentions and unknown tokens", () => {
    expect(
      parseGoatWorkflowEngineSelection({ instructions: "Use @skill/research and email @louis" }),
    ).toEqual({
      engine: "opencompany",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("throws when more than one model is mentioned", () => {
    expect(() =>
      parseGoatWorkflowEngineSelection({ instructions: "Try @codex or @sonnet-5" }),
    ).toThrowError(/more than one model/);
  });

  it("tolerates repeating the same model mention", () => {
    expect(
      parseGoatWorkflowEngineSelection({ instructions: "@codex first, then @codex again" }).engine,
    ).toBe("codex");
  });
});

describe("extractGoatWorkflowSkillMentionRefs", () => {
  it("collects deduped skill mentions", () => {
    expect(
      extractGoatWorkflowSkillMentionRefs(
        "Use @skill/research and @skill/writing then @skill/research again.",
      ),
    ).toEqual([{ id: "research" }, { id: "writing" }]);
  });

  it("ignores non-skill tokens", () => {
    expect(extractGoatWorkflowSkillMentionRefs("Ping @codex and #weekly")).toEqual([]);
  });
});

describe("compileGoatWorkflowHarnessSpec", () => {
  it("compiles a preplanned spec that skips the runner planner", () => {
    const spec = compileGoatWorkflowHarnessSpec({
      workflow: {
        id: "weekly-report",
        name: "Weekly report",
        description: "Compiles the weekly report.",
        instructions: "Collect updates and summarize. Use @skill/research on @kimi-k2.6.",
        model: "",
      },
      workspaceId: "ws_1",
      skills: [
        {
          id: "research",
          name: "Research",
          description: "How to research",
          instructions: "Search broadly.",
        },
      ],
      tools: ["exa_search"],
      selection: { engine: "opencompany", model: "moonshotai/kimi-k2.6" },
      description: "Prepare this week's report",
    });

    // Mirrors the runner's hasPreplannedHarnessSpec gate.
    expect(spec.schemaVersion).toBe("goat.harness.v1");
    expect(spec.systemPrompt.trim().length).toBeGreaterThan(0);
    expect(spec.initialUserMessage.trim().length).toBeGreaterThan(0);
    expect(spec.tools.length).toBeGreaterThan(0);

    expect(spec.systemPrompt).toContain("<workflow_instructions>");
    expect(spec.systemPrompt).toContain("Collect updates and summarize.");
    expect(spec.systemPrompt).toContain('name: "research"');
    expect(spec.initialUserMessage).toContain("Prepare this week's report");
    expect(spec.workflow).toEqual({
      id: "weekly-report",
      workspaceId: "ws_1",
      skillIds: ["research"],
    });
    expect(spec.skills).toEqual([]);
  });

  it("snapshots Codex workflow skills without duplicating them into the text prompt", () => {
    const spec = compileGoatWorkflowHarnessSpec({
      workflow: {
        id: "code-review",
        name: "Code review",
        description: "",
        instructions: "Review the implementation with @skill/review-work.",
        model: "codex",
      },
      workspaceId: "ws_1",
      skills: [
        {
          id: "review-work",
          name: "Review work",
          description: "How to review changes",
          instructions: "Inspect the diff and run focused tests.",
        },
      ],
      tools: ["github_shell"],
      selection: { engine: "codex", model: "openai/gpt-5.5" },
      description: "Review pull request 123",
    });

    expect(spec.systemPrompt).not.toContain("<workflow_skills>");
    expect(spec.systemPrompt).not.toContain("Inspect the diff and run focused tests.");
    expect(spec.workflow?.skillSnapshots).toEqual([
      {
        id: "review-work",
        name: "Review work",
        description: "How to review changes",
        instructions: "Inspect the diff and run focused tests.",
      },
    ]);
  });
});

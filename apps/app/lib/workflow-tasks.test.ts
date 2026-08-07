import { getDb } from "@opencompany/db/client";
import {
  type GoatChatMessageAttachment,
  goatChatSessions,
  goatTasks,
} from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateGoatChatTitle } from "@/lib/chat-title";

const mocks = vi.hoisted(() => ({
  createGoatTaskForUser: vi.fn(),
  isGoatClaudeCodeConnectedForUser: vi.fn(),
  isGoatCodexConnectedForUser: vi.fn(),
  getGoatAvailableHarnessTools: vi.fn(),
  resolveGoatSkillMentions: vi.fn(),
  resolveGoatWorkflowMention: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({ createGoatTaskForUser: mocks.createGoatTaskForUser }));
vi.mock("@/lib/claude-code-auth", () => ({
  isGoatClaudeCodeConnectedForUser: mocks.isGoatClaudeCodeConnectedForUser,
}));
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
  generateGoatWorkflowTaskTitle,
  resolveGoatWorkflowStepSelection,
} = await import("@/lib/workflow-tasks");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isGoatClaudeCodeConnectedForUser.mockResolvedValue(true);
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
      reasoningEffort: "high",
    });
  });

  it("uses Claude Code when the step selects the Claude Code sandbox", () => {
    expect(
      resolveGoatWorkflowStepSelection({
        model: "claude-code",
        instructions: "Fix the bug.",
      }),
    ).toEqual({
      engine: "claude_code",
      model: "anthropic/claude-sonnet-5",
      reasoningEffort: "high",
    });
  });

  it("uses configured coding model and effort for cloud coding steps", () => {
    expect(
      resolveGoatWorkflowStepSelection({
        model: "codex",
        runtimeModel: "openai/gpt-5.6-luna",
        reasoningEffort: "medium",
        instructions: "Fix the bug.",
      }),
    ).toEqual({
      engine: "codex",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "medium",
    });
    expect(
      resolveGoatWorkflowStepSelection({
        model: "claude-code",
        runtimeModel: "anthropic/claude-opus-4.8",
        reasoningEffort: "xhigh",
        instructions: "Fix the bug.",
      }),
    ).toEqual({
      engine: "claude_code",
      model: "anthropic/claude-opus-4.8",
      reasoningEffort: "xhigh",
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
  it("compiles configured cloud coding model and effort onto the active step", () => {
    const spec = compileGoatWorkflowHarnessSpec({
      workflow: {
        id: "ship-feature",
        name: "Ship feature",
        description: "Ships product changes.",
        steps: [
          {
            id: "step-1",
            title: "Implement",
            model: "codex",
            runtimeModel: "openai/gpt-5.6-luna",
            reasoningEffort: "medium",
            instructions: "Make the change.",
          },
        ],
      },
      workspaceId: "ws_1",
      skills: [],
      tools: ["exa_search"],
      description: "Add the control.",
    });

    expect(spec).toMatchObject({
      engine: "codex",
      model: "openai/gpt-5.6-luna",
      codex: { reasoningEffort: "medium" },
      workflow: {
        steps: [
          expect.objectContaining({
            engine: "codex",
            model: "openai/gpt-5.6-luna",
            reasoningEffort: "medium",
          }),
        ],
      },
    });
  });

  it("compiles independent step models and skills with a step-zero compatibility mirror", () => {
    const spec = compileGoatWorkflowHarnessSpec({
      workflow: {
        id: "weekly-report",
        name: "Weekly report",
        description: "Compiles the weekly report.",
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
            model: "claude-code",
            runtimeModel: "anthropic/claude-opus-4.8",
            reasoningEffort: "xhigh",
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
        completedStepCount: 0,
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
      engine: "claude_code",
      model: "anthropic/claude-opus-4.8",
      reasoningEffort: "xhigh",
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

  it("requires Claude Code connectivity when any workflow step uses Claude Code", async () => {
    mocks.resolveGoatWorkflowMention.mockResolvedValue({
      id: "mixed-workflow",
      name: "Mixed workflow",
      description: "",
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
          model: "claude-code",
          instructions: "Implement.",
        },
      ],
    });
    mocks.isGoatClaudeCodeConnectedForUser.mockResolvedValue(false);

    await expect(
      createGoatTaskFromWorkflow({
        userWorkosId: "user_1",
        workspaceId: "ws_1",
        mention: { id: "mixed-workflow" },
        description: "Run it",
      }),
    ).rejects.toThrow(/uses Claude Code/);

    expect(mocks.isGoatClaudeCodeConnectedForUser).toHaveBeenCalledWith("user_1");
    expect(mocks.createGoatTaskForUser).not.toHaveBeenCalled();
  });

  it("resolves the union of step skills once and queues step zero's model", async () => {
    mocks.resolveGoatWorkflowMention.mockResolvedValue({
      id: "mixed-workflow",
      name: "Mixed workflow",
      description: "",
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
      attachments: [attachment],
      attachmentTexts: { [attachment.id]: "Extracted report text." },
    });

    expect(mocks.resolveGoatSkillMentions).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      mentions: [{ id: "research" }, { id: "writing" }],
    });
    expect(mocks.createGoatTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "moonshotai/kimi-k2.6",
        workflowId: "mixed-workflow",
        attachments: [attachment],
        attachmentTexts: { [attachment.id]: "Extracted report text." },
      }),
    );
  });
});

describe("generateGoatWorkflowTaskTitle", () => {
  it("keeps the task chat session title in sync with the generated task title", async () => {
    vi.mocked(generateGoatChatTitle).mockResolvedValue("Acme interview follow-up");
    const updateTask = updateBuilder([{ sessionId: "goat_chat_task_1" }]);
    const updateChat = updateBuilder([]);
    const update = vi.fn().mockReturnValueOnce(updateTask).mockReturnValueOnce(updateChat);
    vi.mocked(getDb).mockReturnValue({ update } as never);

    await generateGoatWorkflowTaskTitle({
      taskId: "goat_task_1",
      userWorkosId: "user_1",
      workflowName: "Customer interview synthesis",
      description: "Synthesize the Acme interview using the confirmed pricing concern.",
      apiKey: "test-key",
    });

    expect(generateGoatChatTitle).toHaveBeenCalledWith({
      content: "Synthesize the Acme interview using the confirmed pricing concern.",
      fallbackTitle: "Customer interview synthesis",
      apiKey: "test-key",
      userWorkosId: "user_1",
    });
    expect(update).toHaveBeenNthCalledWith(1, goatTasks);
    expect(updateTask.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme interview follow-up" }),
    );
    expect(update).toHaveBeenNthCalledWith(2, goatChatSessions);
    expect(updateChat.set).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Acme interview follow-up" }),
    );
  });

  it("skips the task chat session update when the task has no backing session", async () => {
    vi.mocked(generateGoatChatTitle).mockResolvedValue("Acme interview follow-up");
    const updateTask = updateBuilder([{ sessionId: null }]);
    const update = vi.fn().mockReturnValueOnce(updateTask);
    vi.mocked(getDb).mockReturnValue({ update } as never);

    await generateGoatWorkflowTaskTitle({
      taskId: "goat_task_1",
      userWorkosId: "user_1",
      workflowName: "Customer interview synthesis",
      description: "Synthesize the Acme interview using the confirmed pricing concern.",
      apiKey: "test-key",
    });

    expect(update).toHaveBeenCalledOnce();
  });
});

function updateBuilder<T>(result: T) {
  const builder = {
    set: vi.fn(() => builder),
    where: vi.fn(() => builder),
    returning: vi.fn(async () => result),
  };
  return builder;
}

const attachment: GoatChatMessageAttachment = {
  id: "goat_chat_att_1",
  kind: "docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  filename: "report.docx",
  sizeBytes: 1024,
  blobPathname: "goat-chat/user_1/report.docx",
  blobUrl: "https://blob.test/goat-chat/user_1/report.docx",
};

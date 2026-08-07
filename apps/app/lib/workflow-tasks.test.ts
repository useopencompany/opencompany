import { getDb } from "@opencompany/db/client";
import { type ChatMessageAttachment, chatSessions, tasks } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateChatTitle } from "@/lib/chat-title";

const mocks = vi.hoisted(() => ({
  createTaskForUser: vi.fn(),
  isClaudeCodeConnectedForUser: vi.fn(),
  isCodexConnectedForUser: vi.fn(),
  getAvailableHarnessTools: vi.fn(),
  resolveSkillMentions: vi.fn(),
  resolveWorkflowMention: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({ createTaskForUser: mocks.createTaskForUser }));
vi.mock("@/lib/claude-code-auth", () => ({
  isClaudeCodeConnectedForUser: mocks.isClaudeCodeConnectedForUser,
}));
vi.mock("@/lib/codex-auth", () => ({
  isCodexConnectedForUser: mocks.isCodexConnectedForUser,
}));
vi.mock("@/lib/integrations/google-data", () => ({
  getAvailableHarnessTools: mocks.getAvailableHarnessTools,
}));
vi.mock("@/lib/chat-title", () => ({ generateChatTitle: vi.fn() }));
vi.mock("@/lib/skills", () => ({ resolveSkillMentions: mocks.resolveSkillMentions }));
vi.mock("@/lib/workflows", () => ({
  resolveWorkflowMention: mocks.resolveWorkflowMention,
  WorkflowMentionError: class WorkflowMentionError extends Error {},
}));
vi.mock("@opencompany/db/client", () => ({ getDb: vi.fn() }));

const {
  compileWorkflowHarnessSpec,
  createTaskFromWorkflow,
  extractWorkflowSkillMentionRefs,
  generateWorkflowTaskTitle,
  resolveWorkflowStepSelection,
} = await import("@/lib/workflow-tasks");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isClaudeCodeConnectedForUser.mockResolvedValue(true);
  mocks.isCodexConnectedForUser.mockResolvedValue(true);
  mocks.getAvailableHarnessTools.mockResolvedValue(["exa_search"]);
  mocks.resolveSkillMentions.mockResolvedValue([]);
});

describe("resolveWorkflowStepSelection", () => {
  it("defaults to the opencompany engine on Kimi", () => {
    expect(resolveWorkflowStepSelection({ model: "", instructions: "Do the work." })).toEqual({
      engine: "opencompany",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("prefers the step model field over inline mentions", () => {
    expect(
      resolveWorkflowStepSelection({
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
      resolveWorkflowStepSelection({
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
      resolveWorkflowStepSelection({
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
      resolveWorkflowStepSelection({
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
      resolveWorkflowStepSelection({
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
      resolveWorkflowStepSelection({ model: "gpt-9", instructions: "Do it." }),
    ).toThrowError(/not available/);
    expect(() =>
      resolveWorkflowStepSelection({
        model: "",
        instructions: "Try @codex or @sonnet-5.",
      }),
    ).toThrowError(/more than one model/);
  });
});

describe("extractWorkflowSkillMentionRefs", () => {
  it("collects deduped skill mentions from one step", () => {
    expect(
      extractWorkflowSkillMentionRefs(
        "Use @skill/research and @skill/writing then @skill/research again.",
      ),
    ).toEqual([{ id: "research" }, { id: "writing" }]);
  });
});

describe("compileWorkflowHarnessSpec", () => {
  it("compiles configured cloud coding model and effort onto the active step", () => {
    const spec = compileWorkflowHarnessSpec({
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
    const spec = compileWorkflowHarnessSpec({
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

  it("applies explicitly invoked skills to the first workflow step", () => {
    const spec = compileWorkflowHarnessSpec({
      workflow: {
        id: "ship-feature",
        name: "Ship feature",
        description: "",
        steps: [
          {
            id: "step-1",
            title: "Implement",
            model: "claude-code",
            instructions: "Use @skill/product-work.",
          },
          {
            id: "step-2",
            title: "Review",
            model: "claude-code",
            instructions: "Review the implementation.",
          },
        ],
      },
      workspaceId: "ws_1",
      skills: [
        {
          id: "product-work",
          name: "Product work",
          description: "Ship product changes",
          instructions: "Implement and verify the feature.",
        },
        {
          id: "smooth-shadow-ring",
          name: "Smooth shadow ring",
          description: "Polish elevation styles",
          instructions: "Use layered shadows and a crisp ring.",
        },
      ],
      invokedSkillIds: ["smooth-shadow-ring"],
      tools: [],
      description: "Improve the shadows.",
    });

    expect(spec.workflow?.steps?.[0]?.skillIds).toEqual(["product-work", "smooth-shadow-ring"]);
    expect(spec.workflow?.steps?.[1]?.skillIds).toEqual([]);
    expect(spec.workflow?.skillSnapshots).toEqual([
      expect.objectContaining({ id: "product-work" }),
      expect.objectContaining({ id: "smooth-shadow-ring" }),
    ]);
  });
});

describe("createTaskFromWorkflow", () => {
  it("requires Codex connectivity when any workflow step uses Codex", async () => {
    mocks.resolveWorkflowMention.mockResolvedValue({
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
    mocks.isCodexConnectedForUser.mockResolvedValue(false);

    await expect(
      createTaskFromWorkflow({
        userWorkosId: "user_1",
        workspaceId: "ws_1",
        mention: { id: "mixed-workflow" },
        description: "Run it",
      }),
    ).rejects.toThrow(/uses Codex/);

    expect(mocks.isCodexConnectedForUser).toHaveBeenCalledWith("user_1");
    expect(mocks.createTaskForUser).not.toHaveBeenCalled();
  });

  it("requires Claude Code connectivity when any workflow step uses Claude Code", async () => {
    mocks.resolveWorkflowMention.mockResolvedValue({
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
    mocks.isClaudeCodeConnectedForUser.mockResolvedValue(false);

    await expect(
      createTaskFromWorkflow({
        userWorkosId: "user_1",
        workspaceId: "ws_1",
        mention: { id: "mixed-workflow" },
        description: "Run it",
      }),
    ).rejects.toThrow(/uses Claude Code/);

    expect(mocks.isClaudeCodeConnectedForUser).toHaveBeenCalledWith("user_1");
    expect(mocks.createTaskForUser).not.toHaveBeenCalled();
  });

  it("resolves workflow and invocation skills once and queues step zero's model", async () => {
    mocks.resolveWorkflowMention.mockResolvedValue({
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
    mocks.resolveSkillMentions.mockResolvedValue([
      { id: "research", name: "Research", description: "", instructions: "Research well." },
      { id: "writing", name: "Writing", description: "", instructions: "Write clearly." },
      {
        id: "smooth-shadow-ring",
        name: "Smooth shadow ring",
        description: "",
        instructions: "Polish elevation styles.",
      },
    ]);
    mocks.createTaskForUser.mockResolvedValue({ id: "task_1" });

    await createTaskFromWorkflow({
      userWorkosId: "user_1",
      workspaceId: "ws_1",
      mention: { id: "mixed-workflow" },
      skillMentions: [{ id: "smooth-shadow-ring" }],
      description: "Run it",
      attachments: [attachment],
      attachmentTexts: { [attachment.id]: "Extracted report text." },
    });

    expect(mocks.resolveSkillMentions).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      mentions: [{ id: "research" }, { id: "writing" }, { id: "smooth-shadow-ring" }],
    });
    expect(mocks.createTaskForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "moonshotai/kimi-k2.6",
        workflowId: "mixed-workflow",
        harnessSpec: expect.objectContaining({
          workflow: expect.objectContaining({
            skillIds: ["research", "writing", "smooth-shadow-ring"],
            steps: [
              expect.objectContaining({ skillIds: ["research", "smooth-shadow-ring"] }),
              expect.objectContaining({ skillIds: ["writing", "research"] }),
            ],
          }),
        }),
        attachments: [attachment],
        attachmentTexts: { [attachment.id]: "Extracted report text." },
      }),
    );
  });
});

describe("generateWorkflowTaskTitle", () => {
  it("keeps the task chat session title in sync with the generated task title", async () => {
    vi.mocked(generateChatTitle).mockResolvedValue("Acme interview follow-up");
    const updateTask = updateBuilder([{ sessionId: "goat_chat_task_1" }]);
    const updateChat = updateBuilder([]);
    const update = vi.fn().mockReturnValueOnce(updateTask).mockReturnValueOnce(updateChat);
    vi.mocked(getDb).mockReturnValue({ update } as never);

    await generateWorkflowTaskTitle({
      taskId: "goat_task_1",
      userWorkosId: "user_1",
      workflowName: "Customer interview synthesis",
      description: "Synthesize the Acme interview using the confirmed pricing concern.",
      apiKey: "test-key",
    });

    expect(generateChatTitle).toHaveBeenCalledWith({
      content: "Synthesize the Acme interview using the confirmed pricing concern.",
      fallbackTitle: "Customer interview synthesis",
      apiKey: "test-key",
      userWorkosId: "user_1",
    });
    expect(update).toHaveBeenNthCalledWith(1, tasks);
    expect(updateTask.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme interview follow-up" }),
    );
    expect(update).toHaveBeenNthCalledWith(2, chatSessions);
    expect(updateChat.set).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Acme interview follow-up" }),
    );
  });

  it("skips the task chat session update when the task has no backing session", async () => {
    vi.mocked(generateChatTitle).mockResolvedValue("Acme interview follow-up");
    const updateTask = updateBuilder([{ sessionId: null }]);
    const update = vi.fn().mockReturnValueOnce(updateTask);
    vi.mocked(getDb).mockReturnValue({ update } as never);

    await generateWorkflowTaskTitle({
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

const attachment: ChatMessageAttachment = {
  id: "goat_chat_att_1",
  kind: "docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  filename: "report.docx",
  sizeBytes: 1024,
  blobPathname: "goat-chat/user_1/report.docx",
  blobUrl: "https://blob.test/goat-chat/user_1/report.docx",
};

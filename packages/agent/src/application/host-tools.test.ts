import { describe, expect, it, vi } from "vitest";
import {
  type ChatHostContext,
  type ChatHostToolServiceDependencies,
  executeChatHostToolService,
} from "./host-tools";

const context: ChatHostContext = {
  actorId: "user_1",
  workspaceId: "workspace_1",
  workspaceName: "Analytical Engines",
  conversationId: "conversation_1",
  messageId: "message_1",
  brainRef: null,
  email: "ada@example.test",
  firstName: "Ada",
  lastName: "Lovelace",
  timezone: "Europe/London",
  taskToolsEnabled: true,
  wikiEnabled: true,
};

describe("opencompany Chat Task host tools", () => {
  it("activates a catalog skill before returning its snapshotted instructions", async () => {
    const resolveSkillMentions = vi.fn(async () => [
      {
        id: "research",
        bundleId: "skill_bundle_research_v1",
        name: "research",
        description: "Research carefully.",
        instructions: "Current instructions.",
      },
    ]);
    const activateAndListSkills = vi.fn(async () => [
      {
        skillId: "research",
        name: "research",
        description: "Research carefully.",
        instructions: "Chat-fixed instructions.",
      },
    ]);
    const dependencies = testDependencies({ resolveSkillMentions, activateAndListSkills });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "use_skill",
          sessionId: "runtime_1",
          runId: "run_1",
          input: { skill: "research" },
        },
        dependencies,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { skill: { id: "research", instructions: "Chat-fixed instructions." } },
    });
    expect(activateAndListSkills).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      messageId: "message_1",
      workspaceId: "workspace_1",
      skills: [expect.objectContaining({ id: "research" })],
    });
  });

  it("reads one bounded file chunk through the authorized Chat snapshot", async () => {
    const readSkillFile = vi.fn(async () => ({
      path: "references/guide.md",
      executable: false,
      sizeBytes: 10,
      offset: 4,
      nextOffset: 10,
      eof: true,
      encoding: "utf8" as const,
      content: "guide",
    }));
    const dependencies = testDependencies({ readSkillFile });

    await executeChatHostToolService({
      command: {
        operation: "read_skill_file",
        sessionId: "runtime_1",
        runId: "run_1",
        input: { skill: "research", path: "references/guide.md", offset: 4, maxBytes: 64 },
      },
      dependencies,
    });

    expect(readSkillFile).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      skill: "research",
      path: "references/guide.md",
      offset: 4,
      maxBytes: 64,
    });
  });

  it("delegates an agent-created Task through the authenticated Task creator", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_task",
          sessionId: "runtime_1",
          runId: "run_1",
          input: {
            name: "Market research",
            prompt: "Research the market.",
            model: "moonshotai/kimi-k2.6",
            engine: "opencompany",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({ ok: true, result: taskResult });

    expect(createTask).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      brainRef: "brain_1",
      name: "Market research",
      prompt: "Research the market.",
      model: "moonshotai/kimi-k2.6",
      engine: "opencompany",
    });
  });

  it("rejects a task model that the selected coding engine cannot run", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_task",
          sessionId: "runtime_1",
          runId: "run_1",
          input: {
            name: "Review code",
            prompt: "Review the code.",
            model: "anthropic/claude-sonnet-5",
            engine: "codex",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Model "anthropic/claude-sonnet-5" is not available for the Codex engine.',
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("delegates an agent-created Workflow invocation through the Workflow Task creator", async () => {
    const createWorkflowTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createWorkflowTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_workflow",
          sessionId: "runtime_1",
          runId: "run_1",
          input: { workflowId: "weekly-report", prompt: "Prepare this week's report." },
        },
        dependencies,
      }),
    ).resolves.toEqual({ ok: true, result: taskResult });

    expect(createWorkflowTask).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      mention: { id: "weekly-report" },
      description: "Prepare this week's report.",
    });
  });

  it("binds an agent-created schedule to the active workspace", async () => {
    const createSchedule = vi.fn(async () => ({
      id: "schedule_1",
      name: "Daily briefing",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      nextRunAt: new Date("2026-08-12T08:00:00.000Z"),
      prompt: "Prepare the briefing.",
    }));
    const dependencies = testDependencies({ createSchedule });

    await executeChatHostToolService({
      command: {
        operation: "schedule_task",
        sessionId: "runtime_1",
        runId: "run_1",
        input: {
          name: "Daily briefing",
          cron: "0 9 * * *",
          prompt: "Prepare the briefing.",
        },
      },
      dependencies,
    });

    expect(createSchedule).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      name: "Daily briefing",
      sourceDescription: "",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      prompt: "Prepare the briefing.",
    });
  });

  it("runs a wiki command with a turn+toolCall idempotency key", async () => {
    const runWikiTool = vi.fn(async () => ({ ok: true, result: {} }));
    const dependencies = testDependencies({ runWikiTool });
    await executeChatHostToolService({
      command: {
        operation: "wiki",
        sessionId: "runtime_1",
        runId: "turn_7",
        toolCallId: "call_42",
        input: { command: "write", path: "projects/plan", body: "# Plan" },
      },
      dependencies,
    });
    expect(runWikiTool).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      actorId: "user_1",
      toolInput: { command: "write", path: "projects/plan", body: "# Plan" },
      idempotencyKey: "agent-wiki:turn_7:call_42",
    });
  });

  it("gives two wiki calls in one turn different idempotency keys", async () => {
    const runWikiTool = vi.fn(async () => ({ ok: true, result: {} }));
    const dependencies = testDependencies({ runWikiTool });
    for (const toolCallId of ["call_a", "call_b"]) {
      await executeChatHostToolService({
        command: {
          operation: "wiki",
          sessionId: "runtime_1",
          runId: "turn_7",
          toolCallId,
          input: { command: "tree" },
        },
        dependencies,
      });
    }
    const keys = (runWikiTool.mock.calls as unknown as Array<[{ idempotencyKey: string }]>).map(
      ([call]) => call.idempotencyKey,
    );
    expect(keys).toEqual(["agent-wiki:turn_7:call_a", "agent-wiki:turn_7:call_b"]);
  });
});

const taskResult = {
  id: "task_1",
  displayId: "TASK-1",
  name: "Market research",
  prompt: "Research the market.",
};

function testDependencies(
  overrides: Partial<ChatHostToolServiceDependencies>,
): ChatHostToolServiceDependencies {
  return {
    loadContext: vi.fn(async () => context),
    listBrains: vi.fn(async () => [{ id: "brain_1", slug: "home" }]),
    defaultBrainSlug: "home",
    browserProfilesAvailable: () => false,
    createAgentSession: vi.fn(),
    endAgentSession: vi.fn(),
    listBrowserProfiles: vi.fn(async () => []),
    resolveActiveAgentSession: vi.fn(async () => null),
    resolveSkillMentions: vi.fn(async () => []),
    listSkillCatalog: vi.fn(async () => []),
    activateAndListSkills: vi.fn(async () => []),
    readSkillFile: vi.fn(),
    createTask: vi.fn(async () => taskResult),
    listSchedules: vi.fn(async () => []),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    createWorkflowTask: vi.fn(async () => taskResult),
    listWorkflowCatalog: vi.fn(async () => []),
    executeBrowserTool: vi.fn(),
    runWikiTool: vi.fn(),
    ...overrides,
  };
}

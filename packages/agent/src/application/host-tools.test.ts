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

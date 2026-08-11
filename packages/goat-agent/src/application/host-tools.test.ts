import { describe, expect, it, vi } from "vitest";
import {
  executeGoatChatHostToolService,
  type GoatChatHostContext,
  type GoatChatHostToolServiceDependencies,
} from "./host-tools";

const context: GoatChatHostContext = {
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

describe("Goat Chat Task host tools", () => {
  it("delegates an agent-created Task through the authenticated Task creator", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createTask });

    await expect(
      executeGoatChatHostToolService({
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
      executeGoatChatHostToolService({
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
});

const taskResult = {
  id: "task_1",
  displayId: "TASK-1",
  name: "Market research",
  prompt: "Research the market.",
};

function testDependencies(
  overrides: Partial<GoatChatHostToolServiceDependencies>,
): GoatChatHostToolServiceDependencies {
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

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTaskFromWorkflow: vi.fn(),
  refineWorkflowTaskTitle: vi.fn(),
  updateTaskForActor: vi.fn(),
}));

vi.mock("../workflow-tasks", () => ({
  createTaskFromWorkflow: mocks.createTaskFromWorkflow,
}));
vi.mock("../workflow-task-title", () => ({
  refineWorkflowTaskTitle: mocks.refineWorkflowTaskTitle,
}));
vi.mock("./task-creation", () => ({
  createTaskForActor: vi.fn(),
  updateTaskForActor: mocks.updateTaskForActor,
}));

const { executePersistedChatHostTool } = await import("./persisted-host-tools");

describe("persisted workflow host tools", () => {
  it("refines an agent-created Workflow Task before returning it to Chat", async () => {
    const createdTask = {
      id: "task_1",
      displayId: "TASK-1",
      name: "Weekly report",
      prompt: "Prepare this week's report.",
      sessionId: "conversation_1",
    };
    mocks.createTaskFromWorkflow.mockResolvedValue(createdTask);
    mocks.updateTaskForActor.mockResolvedValue({ task: { name: "Customer health report" } });
    mocks.refineWorkflowTaskTitle.mockImplementation(async (_input, dependencies) =>
      dependencies.updateTaskName("Customer health report"),
    );

    const response = await executePersistedChatHostTool({
      request: {
        operation: "start_workflow",
        sessionId: "runtime_1",
        turnId: "run_1",
        input: { workflowId: "weekly-report", prompt: "Prepare this week's report." },
      },
      runtime: {
        wakeTaskWorker: vi.fn(),
        defer: vi.fn(),
        gatewayApiKey: "gateway-key",
        planHarness: vi.fn(),
      },
      dependencies: {
        loadContext: vi.fn(async () => ({
          actorId: "user_1",
          workspaceId: "workspace_1",
          workspaceName: "Acme",
          conversationId: "conversation_1",
          messageId: "message_1",
          brainRef: null,
          email: "ada@example.test",
          firstName: "Ada",
          lastName: "Lovelace",
          timezone: "Europe/London",
          taskToolsEnabled: true,
          skillToolsEnabled: true,
          wikiEnabled: true,
        })),
      },
    });

    expect(mocks.refineWorkflowTaskTitle).toHaveBeenCalledWith(
      {
        taskId: "task_1",
        conversationId: "conversation_1",
        workflowName: "Weekly report",
        description: "Prepare this week's report.",
        apiKey: "gateway-key",
        actorId: "user_1",
      },
      { updateTaskName: expect.any(Function) },
    );
    expect(mocks.updateTaskForActor).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      taskId: "task_1",
      name: "Customer health report",
    });
    expect(response).toMatchObject({
      ok: true,
      result: { id: "task_1", displayId: "TASK-1", name: "Customer health report" },
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { GoatBrainWorkflowMentionError } from "@/lib/brain-workflows";
import { createGoatTaskFromWorkflow, generateGoatWorkflowTaskTitle } from "@/lib/workflow-tasks";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ currentGoatUser: vi.fn() }));
vi.mock("@/lib/brain-workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brain-workflows")>();
  return { ...actual, listGoatBrainWorkflowCatalog: vi.fn() };
});
vi.mock("@/lib/workflow-tasks", () => ({
  createGoatTaskFromWorkflow: vi.fn(),
  generateGoatWorkflowTaskTitle: vi.fn(),
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: vi.fn((work: Promise<unknown>) => work) };
});

describe("/api/brain/workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("requires authentication when starting a task", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue(null as never);

    const response = await POST(workflowRequest({}));

    expect(response.status).toBe(401);
    expect(createGoatTaskFromWorkflow).not.toHaveBeenCalled();
  });

  it("starts a workflow task without creating a chat turn", async () => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-key");
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: { workosUserId: "user_1" },
      activeBrain: { id: "brain_1" },
    } as never);
    vi.mocked(createGoatTaskFromWorkflow).mockResolvedValue({
      id: "task_1",
      displayId: "TASK-1",
      name: "Morning Test",
    } as never);
    vi.mocked(generateGoatWorkflowTaskTitle).mockResolvedValue();

    const response = await POST(
      workflowRequest({
        workflow: {
          kind: "workflow",
          brainRef: "brain_1",
          id: "morning-test",
        },
        description: "#morning-test run today's checks",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      task: {
        id: "task_1",
        displayId: "TASK-1",
        name: "Morning Test",
      },
    });
    expect(createGoatTaskFromWorkflow).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      activeBrainRef: "brain_1",
      mention: { brainRef: "brain_1", id: "morning-test" },
      description: "#morning-test run today's checks",
    });
    expect(generateGoatWorkflowTaskTitle).toHaveBeenCalledWith({
      taskId: "task_1",
      userWorkosId: "user_1",
      workflowName: "Morning Test",
      description: "#morning-test run today's checks",
      apiKey: "test-key",
    });
  });

  it("returns a validation error when the selected workflow is unavailable", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue({
      user: { workosUserId: "user_1" },
      activeBrain: { id: "brain_1" },
    } as never);
    vi.mocked(createGoatTaskFromWorkflow).mockRejectedValue(
      new GoatBrainWorkflowMentionError('Workflow "#missing" is unavailable or incomplete.'),
    );

    const response = await POST(
      workflowRequest({
        workflow: {
          kind: "workflow",
          brainRef: "brain_1",
          id: "missing",
        },
        description: "#missing",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Workflow "#missing" is unavailable or incomplete.',
    });
  });
});

function workflowRequest(body: unknown) {
  return new Request("https://goat.test/api/brain/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

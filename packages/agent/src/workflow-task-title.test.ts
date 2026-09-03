import { describe, expect, it, vi } from "vitest";
import { refineWorkflowTaskTitle } from "./workflow-task-title";

const input = {
  taskId: "goat_task_1",
  conversationId: "conversation_1",
  workflowName: "Weekly research",
  description: "Focus on competitor launches.",
  apiKey: "gateway-key",
  actorId: "user_1",
};

describe("refineWorkflowTaskTitle", () => {
  it("persists and returns a generated workflow Task title", async () => {
    const updateTaskName = vi.fn(async (name: string) => ({ name }));
    const generateTitle = vi.fn(async () => "Competitor launch review");

    await expect(
      refineWorkflowTaskTitle(input, { updateTaskName, generateTitle }),
    ).resolves.toEqual({ name: "Competitor launch review" });

    expect(generateTitle).toHaveBeenCalledWith({
      content: "Focus on competitor launches.",
      fallbackTitle: "Weekly research",
      apiKey: "gateway-key",
      userWorkosId: "user_1",
      chatSessionId: "conversation_1",
    });
    expect(updateTaskName).toHaveBeenCalledWith("Competitor launch review");
  });

  it("keeps the workflow fallback when generation is unavailable or unchanged", async () => {
    const updateTaskName = vi.fn(async () => ({}));
    const generateTitle = vi.fn(async () => "Weekly research");
    const { apiKey: _apiKey, ...inputWithoutApiKey } = input;

    await expect(
      refineWorkflowTaskTitle(inputWithoutApiKey, { updateTaskName, generateTitle }),
    ).resolves.toBeNull();
    await expect(
      refineWorkflowTaskTitle(input, { updateTaskName, generateTitle }),
    ).resolves.toBeNull();

    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(updateTaskName).not.toHaveBeenCalled();
  });

  it("keeps the workflow fallback when generation fails", async () => {
    const updateTaskName = vi.fn(async () => ({}));
    const generateTitle = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      refineWorkflowTaskTitle(input, { updateTaskName, generateTitle }),
    ).resolves.toBeNull();

    expect(updateTaskName).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Workflow Task title refinement failed.",
      expect.objectContaining({
        event: "opencompany.workflow_task_title_failed",
        task_id: "goat_task_1",
      }),
    );
    warn.mockRestore();
  });
});

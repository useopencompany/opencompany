import type { Actor } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { refineWorkflowTaskTitle } from "./automations";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: ["task:write"],
  authenticationMethod: "session",
};

describe("automation behavior adapters", () => {
  it("refines a Workflow Task title through the canonical Task service", async () => {
    const updateTask = vi.fn(async () => ({}));
    const generateTitle = vi.fn(async () => "Competitor launch review");

    await refineWorkflowTaskTitle({
      service: { updateTask } as never,
      actor,
      taskId: "task_1",
      conversationId: "conversation_1",
      workflowName: "Weekly research",
      description: "Focus on competitor launches.",
      apiKey: "gateway-key",
      generateTitle,
    });

    expect(generateTitle).toHaveBeenCalledWith({
      content: "Focus on competitor launches.",
      fallbackTitle: "Weekly research",
      apiKey: "gateway-key",
      userWorkosId: "user_1",
      chatSessionId: "conversation_1",
    });
    expect(updateTask).toHaveBeenCalledWith(actor, "task_1", {
      name: "Competitor launch review",
    });
  });

  it("keeps the Workflow name when title generation is unavailable or unchanged", async () => {
    const updateTask = vi.fn(async () => ({}));
    const generateTitle = vi.fn(async () => "Weekly research");
    const input = {
      service: { updateTask } as never,
      actor,
      taskId: "task_1",
      conversationId: "conversation_1",
      workflowName: "Weekly research",
      description: "Research changes.",
      generateTitle,
    };

    await refineWorkflowTaskTitle(input);
    await refineWorkflowTaskTitle({ ...input, apiKey: "gateway-key" });

    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
  });
});

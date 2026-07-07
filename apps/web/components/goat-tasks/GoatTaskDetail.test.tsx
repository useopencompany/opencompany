import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoatTaskDetail } from "@/components/goat-tasks/GoatTaskDetail";
import type { GoatTaskDetailPayload } from "@/lib/goat-tasks/service";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/goat-tasks/actions", () => ({
  continueGoatTask: vi.fn(),
}));

describe("GoatTaskDetail", () => {
  it.each(["succeeded", "failed"] as const)("shows an enabled composer for %s tasks", (status) => {
    render(<GoatTaskDetail detail={detail({ status })} />);

    const input = screen.getByPlaceholderText("Steer this task worker");
    expect(input).toBeEnabled();
  });

  it.each([
    "queued",
    "running",
    "canceled",
  ] as const)("does not show a composer for %s tasks", (status) => {
    render(<GoatTaskDetail detail={detail({ status })} />);

    expect(screen.queryByPlaceholderText("Steer this task worker")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Task worker is running")).not.toBeInTheDocument();
  });
});

function detail(overrides: Partial<GoatTaskDetailPayload["task"]> = {}): GoatTaskDetailPayload {
  const status = overrides.status ?? "succeeded";
  return {
    task: {
      id: "goat_task_1",
      displayId: "TASK-1",
      name: "Research Marseille",
      prompt: "Research Marseille.",
      model: "openai/gpt-5.4-mini",
      status,
      stage:
        status === "succeeded"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "canceled"
              ? "canceled"
              : status,
      result: status === "succeeded" ? "Done." : null,
      error: status === "failed" ? "Failed." : null,
      codexEngineSessionId: null,
      sandboxId: null,
      attempts: 1,
      createdAt: "2026-07-07T10:00:00.000Z",
      updatedAt: "2026-07-07T10:05:00.000Z",
      ...overrides,
    },
    messages: [
      {
        id: "msg_user",
        role: "user",
        status: "completed",
        content: "Research Marseille.",
        toolName: null,
        toolCallId: null,
        responseToMessageId: null,
        createdAt: "2026-07-07T10:00:00.000Z",
        completedAt: "2026-07-07T10:00:00.000Z",
      },
      {
        id: "msg_assistant",
        role: "assistant",
        status: "completed",
        content: "Done.",
        toolName: null,
        toolCallId: null,
        responseToMessageId: "msg_user",
        createdAt: "2026-07-07T10:01:00.000Z",
        completedAt: "2026-07-07T10:05:00.000Z",
      },
    ],
    events: [],
    artifacts: [],
  };
}

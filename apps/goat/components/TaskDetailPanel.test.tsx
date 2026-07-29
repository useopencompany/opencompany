import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoatChatSessionView } from "@/lib/chat-ui";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { TaskDetailPanel } from "./TaskDetailPanel";

const mocks = vi.hoisted(() => ({
  surfaceProps: null as Record<string, unknown> | null,
}));

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => ({
    user: {
      workosUserId: "user_1",
      email: "ada@example.com",
      firstName: "Ada",
    },
    activeBrain: null,
    tasks: [],
    schedules: [],
    recentChats: [],
    archivedChats: [],
    codexConnected: false,
    claudeCodeConnected: false,
    chatResumeEnabled: true,
    featureFlags: {
      taskSpawning: true,
    },
  }),
}));

vi.mock("@/components/TaskRunPanel", () => ({
  TaskRunLiveProvider: ({
    initialRun,
    children,
  }: {
    initialRun: unknown;
    children: (run: unknown) => React.ReactNode;
  }) => children(initialRun),
}));

vi.mock("@/components/GoatSurface", () => ({
  GoatSurface: (props: Record<string, unknown>) => {
    mocks.surfaceProps = props;
    const chat = props.initialChat as GoatChatSessionView;
    return <div data-testid="goat-surface">{chat.title}</div>;
  },
}));

beforeEach(() => {
  mocks.surfaceProps = null;
});

describe("TaskDetailPanel", () => {
  it("projects a workflow run into the standard chat surface", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [
        message({ id: "user_1", role: "user", content: "Run the morning workflow" }),
        message({
          id: "assistant_1",
          role: "assistant",
          content: "The workflow is complete.",
          created_at: "2026-01-01T00:00:01.000Z",
        }),
      ],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByTestId("goat-surface")).toHaveTextContent("Morning workflow");
    const chat = mocks.surfaceProps?.initialChat as GoatChatSessionView;
    expect(chat.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(mocks.surfaceProps?.taskConversation).toMatchObject({
      taskId: "goat_task_1",
      status: "succeeded",
    });
    expect(mocks.surfaceProps).toMatchObject({
      taskSpawningEnabled: true,
      chatResumeEnabled: false,
      userName: "Ada",
      userWorkosId: "user_1",
    });
  });
});

function task() {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Morning workflow",
    prompt: "Run the morning workflow",
    model: "openai/gpt-5.4-mini",
    status: "succeeded" as const,
    stage: "completed" as const,
    result: "The workflow is complete.",
    error: null,
    workflowId: "morning-workflow",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:02.000Z"),
  };
}

function message(overrides: Record<string, unknown>) {
  return {
    id: "msg_1",
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    role: "assistant" as const,
    status: "completed" as const,
    content: "",
    model_message: null,
    tool_name: null,
    tool_call_id: null,
    response_to_message_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

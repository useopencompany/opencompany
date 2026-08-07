import "@testing-library/jest-dom/vitest";
import type { ChatSessionView } from "@opencompany/core/chat-ui";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHarnessRun } from "@/lib/task-harness-run";
import { TaskDetailPanel } from "./TaskDetailPanel";

const mocks = vi.hoisted(() => ({
  surfaceProps: null as Record<string, unknown> | null,
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({
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
      autoModelRouting: false,
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

vi.mock("@/components/ChatSurface", () => ({
  ChatSurface: (props: Record<string, unknown>) => {
    mocks.surfaceProps = props;
    const chat = props.initialChat as ChatSessionView;
    return <div data-testid="goat-surface">{chat.title}</div>;
  },
}));

beforeEach(() => {
  mocks.surfaceProps = null;
});

describe("TaskDetailPanel", () => {
  it("projects a workflow run into the standard chat surface", () => {
    const run = buildHarnessRun({
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
    const chat = mocks.surfaceProps?.initialChat as ChatSessionView;
    expect(chat.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(mocks.surfaceProps?.taskConversation).toMatchObject({
      taskId: "goat_task_1",
      status: "succeeded",
      sessionBacked: true,
    });
    expect(mocks.surfaceProps).toMatchObject({
      taskSpawningEnabled: true,
      chatResumeEnabled: false,
      userName: "Ada",
      userWorkosId: "user_1",
    });
  });

  it("uses the task name over a stale workflow chat title", () => {
    const run = buildHarnessRun({
      task: {
        ...task(),
        name: "Acme interview follow-up",
        sessionId: "goat_chat_task_1",
      },
      messages: [],
      events: [],
      chat: {
        id: "goat_chat_task_1",
        title: "Customer interview synthesis",
        model: "openai/gpt-5.4-mini",
        engine: "opencompany",
        messages: [],
      },
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByTestId("goat-surface")).toHaveTextContent("Acme interview follow-up");
    expect(mocks.surfaceProps?.initialChat).toMatchObject({
      id: "goat_chat_task_1",
      title: "Acme interview follow-up",
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
    sessionId: "goat_chat_task_1",
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

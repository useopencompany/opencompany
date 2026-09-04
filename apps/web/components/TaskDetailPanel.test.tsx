import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionView } from "@/lib/chat-ui";
import { buildHarnessRun } from "@/lib/task-harness-run";
import { TaskDetailPanel } from "./TaskDetailPanel";

const mocks = vi.hoisted(() => ({
  surfaceProps: null as Record<string, unknown> | null,
  tasks: [] as Record<string, unknown>[],
  hydrated: true,
  runRows: [] as Record<string, unknown>[],
  getHeadlessChatRuns: vi.fn(() => ({})),
  useLiveQuery: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => mocks.hydrated,
}));

vi.mock("@/lib/headless-chat-collections", () => ({
  getHeadlessChatRuns: mocks.getHeadlessChatRuns,
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({
    user: {
      workosUserId: "user_1",
      email: "ada@example.com",
      firstName: "Ada",
    },
    activeBrain: null,
    workspace: { id: "workspace_1" },
    tasks: mocks.tasks,
    schedules: [],
    recentChats: [],
    archivedChats: [],
    codexConnected: false,
    claudeCodeConnected: false,
    featureFlags: {
      taskSpawning: true,
      autoModelRouting: false,
      legacyBrain: false,
    },
  }),
}));

vi.mock("@/components/Surface", () => ({
  Surface: (props: Record<string, unknown>) => {
    mocks.surfaceProps = props;
    const chat = props.initialChat as ChatSessionView;
    return <div data-testid="opencompany-surface">{chat.title}</div>;
  },
}));

beforeEach(() => {
  mocks.surfaceProps = null;
  mocks.tasks = [];
  mocks.hydrated = true;
  mocks.runRows = [];
  mocks.getHeadlessChatRuns.mockClear();
  mocks.useLiveQuery.mockReset();
  mocks.useLiveQuery.mockImplementation(() => ({ data: mocks.runRows }));
});

describe("TaskDetailPanel", () => {
  it("server-renders canonical task data without starting the Run collection", () => {
    mocks.hydrated = false;

    const html = renderToString(
      <TaskDetailPanel initialRun={buildHarnessRun({ task: task(), messages: [], events: [] })} />,
    );

    expect(html).toContain("Morning workflow");
    expect(mocks.getHeadlessChatRuns).not.toHaveBeenCalled();
    expect(mocks.useLiveQuery).not.toHaveBeenCalled();
  });

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

    expect(screen.getByTestId("opencompany-surface")).toHaveTextContent("Morning workflow");
    const chat = mocks.surfaceProps?.initialChat as ChatSessionView;
    expect(chat.messages).toEqual([]);
    expect(mocks.surfaceProps?.taskConversation).toMatchObject({
      taskId: "goat_task_1",
      status: "succeeded",
    });
    expect(mocks.surfaceProps).toMatchObject({
      taskSpawningEnabled: true,
      workspaceId: "workspace_1",
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

    expect(screen.getByTestId("opencompany-surface")).toHaveTextContent("Acme interview follow-up");
    expect(mocks.surfaceProps?.initialChat).toMatchObject({
      id: "goat_chat_task_1",
      title: "Acme interview follow-up",
    });
  });

  it("shows a generated Task title that arrives after the page loads", () => {
    const initialRun = buildHarnessRun({ task: task(), messages: [], events: [] });
    const view = render(<TaskDetailPanel initialRun={initialRun} />);

    expect(screen.getByTestId("opencompany-surface")).toHaveTextContent("Morning workflow");

    mocks.tasks = [
      {
        id: "goat_task_1",
        name: "Acme interview follow-up",
        status: "succeeded",
      },
    ];
    view.rerender(<TaskDetailPanel initialRun={initialRun} />);

    expect(screen.getByTestId("opencompany-surface")).toHaveTextContent("Acme interview follow-up");
  });

  it("isolates sessionless history behind the read-only compatibility boundary", () => {
    const run = buildHarnessRun({
      task: { ...task(), sessionId: null },
      messages: [
        message({ id: "user_1", role: "user", content: "Research the market" }),
        message({
          id: "assistant_1",
          role: "assistant",
          content: "Historical result",
          created_at: "2026-01-01T00:00:01.000Z",
        }),
      ],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    const chat = mocks.surfaceProps?.initialChat as ChatSessionView;
    expect(chat.messages.map((entry) => entry.id)).toEqual(["user_1", "assistant_1"]);
    expect(mocks.surfaceProps?.readOnlyNotice).toMatch(/pre-cutover task/i);
    expect(mocks.surfaceProps?.taskConversation).toMatchObject({
      taskId: run.task.id,
      status: "succeeded",
    });
  });

  it("adopts the live canonical Task status after its active Run completes", () => {
    const initialTask = { ...task(), status: "running" as const, stage: "running" as const };
    mocks.tasks = [
      {
        ...initialTask,
        status: "succeeded",
        stage: "completed",
      },
    ];

    render(
      <TaskDetailPanel
        initialRun={buildHarnessRun({ task: initialTask, messages: [], events: [] })}
      />,
    );

    expect(mocks.surfaceProps?.taskConversation).toMatchObject({
      taskId: "goat_task_1",
      status: "succeeded",
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

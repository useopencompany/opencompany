import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoatTaskCommentRow } from "@/lib/task-collections";
import { TaskActivitySection } from "./TaskActivityFeed";

const liveQueryMock = vi.hoisted(() => ({
  rows: [] as GoatTaskCommentRow[],
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: () => ({ data: liveQueryMock.rows, isLoading: false }),
}));
vi.mock("@/lib/task-collections", () => ({
  createGoatCollections: () => ({ taskComments: () => ({}) }),
}));
vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => true,
}));
vi.mock("@/components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

function comment(overrides: Partial<GoatTaskCommentRow>): GoatTaskCommentRow {
  return {
    id: "goat_task_comment_1",
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    author: "agent",
    kind: "status",
    content: "",
    metadata: {},
    created_at: "2026-07-21T10:00:00.000Z",
    updated_at: "2026-07-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("TaskActivitySection", () => {
  afterEach(() => {
    vi.clearAllMocks();
    liveQueryMock.rows = [];
  });

  it("renders an Electric-backed empty state with the run session link", () => {
    render(<TaskActivitySection taskId="goat_task_1" isActive={false} />);

    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("No activity recorded.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open session" })).toHaveAttribute(
      "href",
      "/chat/goat_chat_task_goat_task_1",
    );
  });

  it("renders task comments in chronological order", () => {
    liveQueryMock.rows = [
      comment({
        id: "c2",
        kind: "result",
        content: "# Result\nAll done.",
        created_at: "2026-07-21T10:05:00.000Z",
      }),
      comment({
        id: "c1",
        metadata: { status: "started" },
        content: "Run started.",
        created_at: "2026-07-21T10:00:00.000Z",
      }),
    ];

    render(<TaskActivitySection taskId="goat_task_1" isActive />);

    expect(screen.getByRole("link", { name: /Open session/ })).toHaveTextContent("steer the run");
    const entries = screen.getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("Run started");
    expect(entries[1]).toHaveTextContent("Agent posted the result");
    expect(screen.getByTestId("markdown")).toHaveTextContent("All done.");
  });

  it("shows failure detail on failed status comments", () => {
    liveQueryMock.rows = [
      comment({ id: "c3", metadata: { status: "failed", error: "Sandbox exploded." } }),
    ];

    render(<TaskActivitySection taskId="goat_task_1" isActive={false} />);

    expect(screen.getByText("Run failed")).toBeInTheDocument();
    expect(screen.getByText("Sandbox exploded.")).toBeInTheDocument();
  });
});

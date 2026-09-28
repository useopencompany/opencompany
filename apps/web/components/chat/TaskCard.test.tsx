import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPullRequest } from "@/lib/session-pull-requests";
import { TaskCard } from "./TaskCard";

const pullRequests = vi.hoisted(() => ({ value: new Map<string, SessionPullRequest>() }));
vi.mock("@/lib/use-session-pull-requests", () => ({
  useSessionPullRequests: () => pullRequests.value,
}));

const task = {
  id: "task_7",
  displayId: "TASK-7",
  title: "Review PR #7",
  status: "running" as const,
  conversationId: "conversation_7",
};

beforeEach(() => {
  pullRequests.value = new Map();
});

describe("TaskCard", () => {
  it("follows the pull request the started Task opened, next to the Task link", () => {
    pullRequests.value = new Map([
      [
        "conversation_7",
        {
          conversationId: "conversation_7",
          repository: "acme/app",
          number: 42,
          url: "https://github.com/acme/app/pull/42",
          state: "merged",
        },
      ],
    ]);
    render(<TaskCard task={task} />);

    expect(screen.getByRole("link", { name: /Review PR #7/ }).getAttribute("href")).toBe(
      "/tasks/TASK-7",
    );
    const pill = screen.getByTestId("task-card-pull-request");
    expect(pill.getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
    expect(pill.textContent).toBe("#42Merged");
    expect(screen.getByText("TASK-7 · Running")).toBeTruthy();
  });

  it("shows the Task id until a pull request exists", () => {
    render(<TaskCard task={task} />);
    expect(screen.queryByTestId("task-card-pull-request")).toBeNull();
    expect(screen.getByText("TASK-7")).toBeTruthy();
  });

  it("does not look up pull requests on a shared read-only transcript", () => {
    pullRequests.value = new Map([
      [
        "conversation_7",
        {
          conversationId: "conversation_7",
          repository: "acme/app",
          number: 42,
          url: "https://github.com/acme/app/pull/42",
          state: "open",
        },
      ],
    ]);
    render(<TaskCard task={task} readOnly />);
    expect(screen.queryByTestId("task-card-pull-request")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

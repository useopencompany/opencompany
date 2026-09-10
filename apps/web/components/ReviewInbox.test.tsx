import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@/lib/review-inbox";
import { ReviewInboxRoute } from "./ReviewInbox";

const reviewItemsMock = vi.hoisted(() => ({ value: [] as ReviewItem[] }));
const transcriptMock = vi.hoisted(() => ({
  messages: [] as Array<{
    role: "user" | "assistant";
    parts: Array<{ type: string; text: string }>;
  }>,
  isLoading: false,
  syncFailed: false,
}));
const updateConversationMock = vi.hoisted(() => vi.fn(async () => ({ transactionId: "1" })));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({ reviewItems: reviewItemsMock.value }),
}));

vi.mock("@/components/Routes", () => ({
  formatRelativeTime: () => "2m ago",
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));

vi.mock("@/components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock("@/components/useHeadlessChatTranscript", () => ({
  useHeadlessChatTranscript: () => transcriptMock,
}));

vi.mock("@/lib/headless-chat-commands", () => ({
  updateHeadlessChatConversation: updateConversationMock,
}));

function chatItem(id: string, title: string, updatedAt: string): ReviewItem {
  return { conversationId: id, title, updatedAt, source: { kind: "chat" } };
}

function taskItem(id: string, title: string, updatedAt: string): ReviewItem {
  return {
    conversationId: id,
    title,
    updatedAt,
    source: { kind: "task", taskId: `task_${id}`, displayId: "TASK-7" },
  };
}

describe("ReviewInboxRoute", () => {
  afterEach(() => {
    vi.clearAllMocks();
    reviewItemsMock.value = [];
    transcriptMock.messages = [];
    transcriptMock.isLoading = false;
    transcriptMock.syncFailed = false;
  });

  it("shows an empty state when there is nothing to review", () => {
    render(<ReviewInboxRoute />);

    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it("groups task results above chat replies", () => {
    reviewItemsMock.value = [
      taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z"),
      chatItem("c2", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(["Task results", "Chat replies", "Pick something to read"]);
    expect(screen.getByText("TASK-7")).toBeInTheDocument();
  });

  it("marks a conversation seen when it is opened and renders its last assistant turn", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [
      { role: "user", parts: [{ type: "text", text: "Write it" }] },
      { role: "assistant", parts: [{ type: "text", text: "Here is the draft." }] },
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));

    expect(updateConversationMock).toHaveBeenCalledWith("c1", { markSeen: true });
    expect(screen.getByTestId("markdown")).toHaveTextContent("Here is the draft.");
  });

  it("keeps an opened item in the list after it leaves the unread queue", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    const view = render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));
    expect(screen.getByTestId("review-item-read")).toBeInTheDocument();

    // The live query drops the row once markSeen lands; the reader should not lose their place.
    reviewItemsMock.value = [];
    view.rerender(<ReviewInboxRoute />);

    expect(screen.getByRole("button", { name: /Draft the investor update/ })).toBeInTheDocument();
  });

  it("marks unopened items unread", () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);

    expect(screen.getByTestId("review-item-unread")).toBeInTheDocument();
  });

  it("links a task to its task route and a chat to its chat route", async () => {
    reviewItemsMock.value = [taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z")];
    transcriptMock.messages = [
      { role: "assistant", parts: [{ type: "text", text: "Scan complete." }] },
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Weekly competitor scan/ }));

    expect(screen.getByRole("link", { name: "Open task" })).toHaveAttribute(
      "href",
      "/tasks/task_c1",
    );
  });

  it("explains a turn that finished without text instead of rendering an empty pane", async () => {
    reviewItemsMock.value = [chatItem("c1", "Silent run", "2026-09-10T11:00:00.000Z")];
    transcriptMock.messages = [{ role: "user", parts: [{ type: "text", text: "Go" }] }];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Silent run/ }));

    expect(screen.getByText(/finished without a text result/)).toBeInTheDocument();
  });

  it("surfaces a sync failure rather than showing a blank result", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.syncFailed = true;

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));

    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });

  it("returns to the list from the detail pane", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));
    await userEvent.click(screen.getByRole("button", { name: "Back to the review list" }));

    expect(screen.getByText("Pick something to read")).toBeInTheDocument();
  });

  it("orders the queue newest first", () => {
    reviewItemsMock.value = [
      chatItem("older", "Older reply", "2026-09-10T08:00:00.000Z"),
      chatItem("newer", "Newer reply", "2026-09-10T12:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);

    const list = screen.getByRole("heading", { name: "Chat replies" }).parentElement;
    const titles = within(list as HTMLElement)
      .getAllByRole("button")
      .map((node) => node.textContent);
    expect(titles[0]).toContain("Newer reply");
    expect(titles[1]).toContain("Older reply");
  });
});

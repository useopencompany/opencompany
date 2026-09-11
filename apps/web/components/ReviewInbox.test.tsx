import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@/lib/review-inbox";
import { ReviewInboxRoute } from "./ReviewInbox";

type TranscriptPart = { type: string; text?: string };

const reviewItemsMock = vi.hoisted(() => ({ value: [] as ReviewItem[] }));
const transcriptMock = vi.hoisted(() => ({
  messages: [] as Array<{ role: "user" | "assistant"; parts: TranscriptPart[] }>,
  isLoading: false,
  syncFailed: false,
}));
const updateConversationMock = vi.hoisted(() => vi.fn(async () => ({ transactionId: "1" })));
const markTaskSeenMock = vi.hoisted(() => vi.fn(async () => ({ id: "task_c1" })));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({
    reviewItems: reviewItemsMock.value,
    workspace: { id: "workspace_1" },
    user: { firstName: "Ada", email: "ada@example.com", workosUserId: "user_1" },
    recentChats: [],
    archivedChats: [],
    tasks: [],
    allTasks: [],
    schedules: [],
    featureFlags: { taskSpawning: true, autoModelRouting: false },
    activeBrain: null,
    codexConnected: false,
    claudeCodeConnected: false,
  }),
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

// The detail pane is the canonical conversation surface. These stubs assert which surface it
// mounts for a queue item; the surfaces themselves are covered by their own tests.
vi.mock("@/components/Surface", () => ({
  Surface: ({ initialChat }: { initialChat: { id: string; title: string; model: string } }) => (
    <div
      data-testid="chat-conversation"
      data-conversation-id={initialChat.id}
      data-model={initialChat.model}
    >
      {initialChat.title}
    </div>
  ),
}));

vi.mock("@/components/TaskDetailPanel", () => ({
  TaskDetailPanel: ({ initialRun }: { initialRun: { task: { id: string } } }) => (
    <div data-testid="task-conversation" data-task-id={initialRun.task.id} />
  ),
}));

vi.mock("@/components/useTaskRun", () => ({
  useTaskRun: (taskId: string) => ({ task: { id: taskId } }),
}));

vi.mock("@/components/useHeadlessChatTranscript", () => ({
  useHeadlessChatTranscript: () => transcriptMock,
}));

vi.mock("@/lib/headless-chat-commands", () => ({
  updateHeadlessChatConversation: updateConversationMock,
}));

vi.mock("@/lib/headless-task-commands", () => ({
  markHeadlessTaskSeen: markTaskSeenMock,
}));

function chatItem(
  id: string,
  title: string,
  updatedAt: string,
  source: Partial<Extract<ReviewItem["source"], { kind: "chat" }>> = {},
): ReviewItem {
  return {
    conversationId: id,
    title,
    updatedAt,
    source: { kind: "chat", model: "claude-opus-5", engine: "opencompany", ...source },
  };
}

function taskItem(id: string, title: string, updatedAt: string): ReviewItem {
  return {
    conversationId: id,
    title,
    updatedAt,
    source: { kind: "task", taskId: `task_${id}`, displayId: "TASK-7" },
  };
}

function assistantReply(text: string) {
  return { role: "assistant" as const, parts: [{ type: "text", text }] };
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

  // Tasks and chats are one queue, newest first: to the reader they are the same thing, a
  // finished turn waiting on them.
  it("lists tasks and chats together in one recency-ordered list", () => {
    reviewItemsMock.value = [
      taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z"),
      chatItem("c2", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
      chatItem("c3", "Newest reply", "2026-09-10T13:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);

    const titles = screen.getAllByRole("button").map((node) => node.textContent);
    expect(titles[0]).toContain("Newest reply");
    expect(titles[1]).toContain("Weekly competitor scan");
    expect(titles[2]).toContain("Draft the investor update");
    // One list, no task/chat split — the task id is the only distinction the reader needs.
    expect(screen.queryByRole("heading", { level: 2, name: /Task results|Chats/ })).toBeNull();
    expect(screen.getByText("TASK-7")).toBeInTheDocument();
  });

  it("opens a chat as the live conversation, not a rendered result", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Here is the draft.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));

    expect(screen.getByTestId("chat-conversation")).toHaveAttribute("data-conversation-id", "c1");
  });

  // A cloud engine runs on its own model ids, which the opencompany catalog does not contain.
  // Normalizing without the engine would rewrite the model the composer then sends.
  it("keeps a cloud engine's own model when it opens the conversation", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Ship the migration", "2026-09-10T11:00:00.000Z", {
        model: "openai/gpt-5.6-sol",
        engine: "codex",
      }),
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Ship the migration/ }));

    expect(screen.getByTestId("chat-conversation")).toHaveAttribute(
      "data-model",
      "openai/gpt-5.6-sol",
    );
  });

  it("opens a task as its task conversation, which resumes on a comment", async () => {
    reviewItemsMock.value = [taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z")];
    transcriptMock.messages = [assistantReply("Scan complete.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Weekly competitor scan/ }));

    expect(screen.getByTestId("task-conversation")).toHaveAttribute("data-task-id", "task_c1");
  });

  it("marks a chat seen once its conversation renders", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [
      { role: "user", parts: [{ type: "text", text: "Write it" }] },
      assistantReply("Here is the draft."),
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));

    expect(updateConversationMock).toHaveBeenCalledWith("c1", { markSeen: true });
  });

  // A Task's seen state lives behind the Task command: the conversation command rejects a
  // conversation of kind 'task', so acknowledging one through it would silently do nothing.
  it("marks a task seen through the task command, not the conversation command", async () => {
    reviewItemsMock.value = [taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z")];
    transcriptMock.messages = [assistantReply("Scan complete.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Weekly competitor scan/ }));

    expect(markTaskSeenMock).toHaveBeenCalledWith("task_c1", { scopeKey: "workspace_1" });
    expect(updateConversationMock).not.toHaveBeenCalled();
  });

  it("does not acknowledge a conversation that failed to sync", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.syncFailed = true;

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));

    expect(updateConversationMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-item-unread")).toBeInTheDocument();
  });

  it("does not acknowledge a transcript that has not delivered its turns yet", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.isLoading = true;

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));

    expect(updateConversationMock).not.toHaveBeenCalled();
  });

  it("keeps an opened item in the list after it leaves the unread queue", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Here is the draft.")];

    const view = render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));
    await waitFor(() => expect(screen.getByTestId("review-item-read")).toBeInTheDocument());

    // The live query drops the row once the acknowledgment lands; the reader keeps their place.
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

  // The detail pane embeds the same surface the task and chat routes render, which draws the
  // conversation's own header. A second row of host chrome above it duplicated that header and
  // sent the reader out of the queue to an identical view.
  it("adds no navigation chrome above the embedded conversation", async () => {
    reviewItemsMock.value = [
      taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z"),
      chatItem("c2", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Scan complete.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /Weekly competitor scan/ }));
    expect(screen.getByTestId("task-conversation")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Draft the investor update/ }));
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
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
});

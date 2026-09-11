import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOptimisticReviewArchives } from "@/lib/optimistic-review-archive";
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
const toastErrorMock = vi.hoisted(() => vi.fn());
const markTaskSeenMock = vi.hoisted(() => vi.fn(async () => ({ id: "task_c1" })));
const archiveTaskMock = vi.hoisted(() => vi.fn(async () => ({ id: "task_c1" })));

// The provider applies the reader's pending archives to the queue it publishes, so the mock does
// the same: these tests are about what the list shows between the click and the projection.
vi.mock("@/components/AppDataProvider", async () => {
  const { useOptimisticReviewArchives } = await import("@/lib/optimistic-review-archive");
  return {
    useAppData: () => {
      const pendingArchives = useOptimisticReviewArchives();
      return {
        reviewItems: reviewItemsMock.value.filter(
          (item) => !pendingArchives.has(item.conversationId),
        ),
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
      };
    },
  };
});

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
  QuickChatComposer: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="review-composer" data-workspace-id={workspaceId} />
  ),
}));

vi.mock("@/components/chat/useCreditBalance", () => ({
  useCreditBalance: () => ({ balance: null, refetch: vi.fn() }),
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
  archiveHeadlessTask: archiveTaskMock,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({ toast: { error: toastErrorMock } }));

function chatItem(
  id: string,
  title: string,
  updatedAt: string,
  source: Partial<Extract<ReviewItem["source"], { kind: "chat" }>> = {},
  unread = true,
): ReviewItem {
  return {
    conversationId: id,
    title,
    updatedAt,
    unread,
    source: { kind: "chat", model: "claude-opus-5", engine: "opencompany", ...source },
  };
}

function taskItem(id: string, title: string, updatedAt: string, unread = true): ReviewItem {
  return {
    conversationId: id,
    title,
    updatedAt,
    unread,
    source: { kind: "task", taskId: `task_${id}`, displayId: "TASK-7" },
  };
}

// The archive control adds a second button per row, so the reader's own rows are the ones named
// after the item they open.
function rowTitles() {
  return screen
    .getAllByRole("button")
    .filter((node) => !node.getAttribute("aria-label")?.startsWith("Archive "))
    .map((node) => node.textContent);
}

function assistantReply(text: string) {
  return { role: "assistant" as const, parts: [{ type: "text", text }] };
}

describe("ReviewInboxRoute", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearOptimisticReviewArchives();
    reviewItemsMock.value = [];
    transcriptMock.messages = [];
    transcriptMock.isLoading = false;
    transcriptMock.syncFailed = false;
  });

  it("shows an empty state when there is nothing to review", () => {
    render(<ReviewInboxRoute />);

    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  // Tasks and chats are one queue: to the reader they are the same thing, a finished turn waiting
  // on them. The queue's order is the selector's (see lib/review-inbox.test.ts); the list renders
  // it as given.
  it("lists tasks and chats together in one list, in queue order", () => {
    reviewItemsMock.value = [
      chatItem("c3", "Newest reply", "2026-09-10T13:00:00.000Z"),
      taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z"),
      chatItem("c2", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);

    const titles = rowTitles();
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
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));

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
    await userEvent.click(screen.getByRole("button", { name: /^Ship the migration/ }));

    expect(screen.getByTestId("chat-conversation")).toHaveAttribute(
      "data-model",
      "openai/gpt-5.6-sol",
    );
  });

  it("opens a task as its task conversation, which resumes on a comment", async () => {
    reviewItemsMock.value = [taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z")];
    transcriptMock.messages = [assistantReply("Scan complete.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Weekly competitor scan/ }));

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
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));

    expect(updateConversationMock).toHaveBeenCalledWith("c1", { markSeen: true });
  });

  // A Task's seen state lives behind the Task command: the conversation command rejects a
  // conversation of kind 'task', so acknowledging one through it would silently do nothing.
  it("marks a task seen through the task command, not the conversation command", async () => {
    reviewItemsMock.value = [taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z")];
    transcriptMock.messages = [assistantReply("Scan complete.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Weekly competitor scan/ }));

    expect(markTaskSeenMock).toHaveBeenCalledWith("task_c1", { scopeKey: "workspace_1" });
    expect(updateConversationMock).not.toHaveBeenCalled();
  });

  it("does not acknowledge a conversation that failed to sync", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.syncFailed = true;

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));

    expect(updateConversationMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-item-unread")).toBeInTheDocument();
  });

  it("does not acknowledge a transcript that has not delivered its turns yet", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.isLoading = true;

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));

    expect(updateConversationMock).not.toHaveBeenCalled();
  });

  // Reading is not the same as being done with it: the queue keeps the item so the reader can come
  // back to it, and archiving is what removes it.
  it("keeps an item in the list after reading it", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Here is the draft.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));
    await waitFor(() => expect(screen.getByTestId("review-item-read")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /^Draft the investor update/ })).toBeInTheDocument();
  });

  // Replying to an item puts its conversation back to work, which takes it out of the queue. The
  // pane the reader is replying in must not close under them when that happens.
  it("keeps the open item on screen when it leaves the queue", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Here is the draft.")];

    const view = render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));

    reviewItemsMock.value = [];
    view.rerender(<ReviewInboxRoute />);

    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Draft the investor update/ })).toBeInTheDocument();
  });

  // A read item recedes instead of disappearing, so unread work still reads as the top of the list.
  it("dims a read item and leaves an unread one at full weight", () => {
    reviewItemsMock.value = [
      chatItem("c1", "Already read", "2026-09-10T12:00:00.000Z", {}, false),
      chatItem("c2", "Still unread", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);

    const read = screen.getByRole("button", { name: /^Already read/ });
    const unread = screen.getByRole("button", { name: /^Still unread/ });
    expect(read.querySelector('[class*="opacity-"]')).not.toBeNull();
    expect(unread.querySelector('[class*="opacity-"]')).toBeNull();
  });

  it("archives a chat from its row", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: "Archive Draft the investor update" }),
    );

    expect(updateConversationMock).toHaveBeenCalledWith("c1", { archived: true });
  });

  // The write and the projection behind it take about a second. The reader has already decided,
  // so the row leaves on the click rather than sitting there under a spinner.
  it("drops the row before the archive settles", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
      chatItem("c2", "Review the pricing page", "2026-09-10T10:00:00.000Z"),
    ];
    let settleArchive = () => {};
    updateConversationMock.mockReturnValueOnce(
      new Promise((resolve) => {
        settleArchive = () => resolve({ transactionId: "1" });
      }),
    );

    render(<ReviewInboxRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: "Archive Draft the investor update" }),
    );

    expect(screen.queryByRole("button", { name: /^Draft the investor update/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Review the pricing page/ })).toBeInTheDocument();
    settleArchive();
  });

  // A double click that beats the re-render must not send the command twice.
  it("sends one archive command per item", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);
    const archiveButton = screen.getByRole("button", {
      name: "Archive Draft the investor update",
    });
    await userEvent.dblClick(archiveButton);

    expect(updateConversationMock).toHaveBeenCalledTimes(1);
  });

  // A Task is archived through the Task command; the conversation command would leave the Task
  // itself listed on the Tasks board.
  it("archives a task through the task command", async () => {
    reviewItemsMock.value = [taskItem("c1", "Weekly competitor scan", "2026-09-10T12:00:00.000Z")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: "Archive Weekly competitor scan" }));

    expect(archiveTaskMock).toHaveBeenCalledWith("task_c1", { scopeKey: "workspace_1" });
    expect(updateConversationMock).not.toHaveBeenCalled();
  });

  // Archiving the item being read has to close the pane: the conversation it showed is no longer
  // in the queue behind it.
  it("closes the detail pane when the open item is archived", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Here is the draft.")];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Archive Draft the investor update" }),
    );

    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it("keeps the item and reports the failure when archiving does not land", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    updateConversationMock.mockRejectedValueOnce(new Error("offline"));

    render(<ReviewInboxRoute />);
    await userEvent.click(
      screen.getByRole("button", { name: "Archive Draft the investor update" }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Could not archive "Draft the investor update".'),
    );
    // The row comes back: the queue still owes the reader an item the write never removed.
    expect(screen.getByRole("button", { name: /^Draft the investor update/ })).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: /^Weekly competitor scan/ }));
    expect(screen.getByTestId("task-conversation")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // The queue is where the next piece of work often gets thought of, so the reading pane keeps a
  // composer until it has a conversation to show instead.
  it("offers the composer while nothing is open and hands it back to the conversation", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];
    transcriptMock.messages = [assistantReply("Here is the draft.")];

    render(<ReviewInboxRoute />);
    expect(screen.getByTestId("review-composer")).toHaveAttribute(
      "data-workspace-id",
      "workspace_1",
    );

    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));

    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("review-composer")).not.toBeInTheDocument();
  });

  it("keeps the composer when the queue is empty", () => {
    reviewItemsMock.value = [];

    render(<ReviewInboxRoute />);

    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.getByTestId("review-composer")).toBeInTheDocument();
  });

  it("returns to the list from the detail pane", async () => {
    reviewItemsMock.value = [
      chatItem("c1", "Draft the investor update", "2026-09-10T11:00:00.000Z"),
    ];

    render(<ReviewInboxRoute />);
    await userEvent.click(screen.getByRole("button", { name: /^Draft the investor update/ }));
    await userEvent.click(screen.getByRole("button", { name: "Back to the review list" }));

    expect(screen.getByText("Pick something to read")).toBeInTheDocument();
  });
});

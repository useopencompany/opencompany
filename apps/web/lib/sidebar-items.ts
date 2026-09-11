import type { TaskStatus } from "@opencompany/core/tasks";
import { isRecentChatActivity } from "@/lib/chat-activity";
import {
  type ChatState,
  type ChatSummaryView,
  chatSummaryState,
  PINNED_CHAT_LIMIT,
} from "@/lib/chat-ui";
import { taskHasReadableResult } from "@/lib/review-inbox";

export const RECENT_SIDEBAR_CHAT_LIMIT = 8;
export const RECENT_SIDEBAR_TASK_LIMIT = 8;

type SidebarChatCandidate = {
  id: string;
  activityState?: "working" | "idle";
  archived?: boolean;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  updatedAt: string;
};

export function selectSidebarChats<T extends SidebarChatCandidate>(
  chats: readonly T[],
  now = Date.now(),
): T[] {
  const openChats = chats.filter((chat) => !chat.archived && !chat.archivedAt);
  const pinned = openChats
    .filter((chat) => chat.pinnedAt)
    .toSorted((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime())
    .slice(0, PINNED_CHAT_LIMIT);
  const working = openChats
    .filter((chat) => !chat.pinnedAt && chat.activityState === "working")
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const recent = openChats
    .filter(
      (chat) =>
        !chat.pinnedAt &&
        chat.activityState !== "working" &&
        isRecentChatActivity(chat.updatedAt, now),
    )
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, RECENT_SIDEBAR_CHAT_LIMIT);

  return [...pinned, ...working, ...recent];
}

// The Task the sidebar lists. It is deliberately narrower than the Tasks board's row: the sidebar
// needs a title to show, a route to open, and the two signals the state dot is derived from.
export type SidebarTaskView = {
  id: string;
  // The Task's conversation, which is the key the optimistic archive store tracks: a Task archived
  // from its row has to leave the review queue on the same click.
  conversationId: string;
  displayId: string;
  name: string;
  status: TaskStatus;
  hasUnseen: boolean;
  updatedAt: string;
};

type SidebarTaskCandidate = {
  status: TaskStatus;
  archivedAt?: string | null;
  updatedAt: string;
};

/**
 * The Tasks the sidebar lists, under the same policy its chats follow.
 *
 * Archived Tasks are out, unfinished ones are in however old they are, and finished ones stay
 * while they are still recent. A `waiting` run counts as unfinished: it has paused for an
 * approval, so it is blocked on the reader and must not age out of the list underneath them.
 * The board at /tasks remains the full history; this list is the work still in view.
 */
export function selectSidebarTasks<T extends SidebarTaskCandidate>(
  tasks: readonly T[],
  now = Date.now(),
): T[] {
  const openTasks = tasks.filter((task) => !task.archivedAt);
  // Bounded like every other bucket: a workflow fan-out of concurrent Tasks must not push the
  // reader's chats out of a 256px column. The board holds the rest.
  const unfinished = openTasks
    .filter((task) => isTaskUnfinished(task.status))
    .toSorted(byUpdatedAtDescending)
    .slice(0, RECENT_SIDEBAR_TASK_LIMIT);
  const recent = openTasks
    .filter((task) => !isTaskUnfinished(task.status) && isRecentChatActivity(task.updatedAt, now))
    .toSorted(byUpdatedAtDescending)
    .slice(0, RECENT_SIDEBAR_TASK_LIMIT);

  return [...unfinished, ...recent];
}

// Work the reader is still owed something from, whether the agent is mid-run or blocked on an
// approval. Distinct from `isTaskRunning`, which decides whether the row spins.
export function isTaskUnfinished(status: TaskStatus) {
  return isTaskRunning(status) || status === "waiting";
}

/**
 * A Task's row state, in the same vocabulary chat rows use.
 *
 * Chats and Tasks raise the same unread flag on the same column, so the dot has one meaning and
 * one implementation across both: something happened here that you have not dealt with.
 *
 * It only claims what the reader can still act on, though. A settled run has a result to read and
 * a `waiting` one has an approval to answer, and both clear as soon as that is done. A canceled
 * run raises the same flag on its way out with neither, so a dot for it would be one nothing in
 * the product could ever turn off.
 */
export function sidebarTaskState(task: Pick<SidebarTaskView, "status" | "hasUnseen">): ChatState {
  if (isTaskRunning(task.status)) return "working";
  const resolvable = taskHasReadableResult(task.status) || task.status === "waiting";
  return task.hasUnseen && resolvable ? "done_unseen" : "done_seen";
}

// One list of the work in view, whatever shape it took. Chats and Tasks are two ways to run the
// same errand, so the sidebar sorts them together instead of stacking one group on top of the
// other and making the reader merge them by eye.
type SidebarWorkItemBase = {
  id: string;
  title: string;
  updatedAt: string;
  state: ChatState;
  // Still owed something: a streaming chat, a running Task, a Task blocked on an approval. These
  // lead the list however old they are, which is why both selectors keep them past the recency
  // window in the first place.
  unfinished: boolean;
};

export type SidebarWorkItem =
  | (SidebarWorkItemBase & { kind: "chat"; chat: ChatSummaryView })
  | (SidebarWorkItemBase & { kind: "task"; task: SidebarTaskView });

export function orderSidebarWorkItems(input: {
  chats: readonly ChatSummaryView[];
  tasks: readonly SidebarTaskView[];
}): SidebarWorkItem[] {
  const chats = input.chats.map<SidebarWorkItem>((chat) => ({
    kind: "chat",
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    state: chatSummaryState(chat),
    unfinished: chat.activityState === "working",
    chat,
  }));
  const tasks = input.tasks.map<SidebarWorkItem>((task) => ({
    kind: "task",
    id: task.id,
    title: task.name,
    updatedAt: task.updatedAt,
    state: sidebarTaskState(task),
    unfinished: isTaskUnfinished(task.status),
    task,
  }));
  return [...chats, ...tasks].toSorted((left, right) => {
    const byUnfinished = Number(right.unfinished) - Number(left.unfinished);
    if (byUnfinished !== 0) return byUnfinished;
    return updatedAtMs(right.updatedAt) - updatedAtMs(left.updatedAt);
  });
}

function isTaskRunning(status: TaskStatus) {
  return status === "queued" || status === "running";
}

function byUpdatedAtDescending(left: { updatedAt: string }, right: { updatedAt: string }) {
  return updatedAtMs(right.updatedAt) - updatedAtMs(left.updatedAt);
}

function updatedAtMs(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

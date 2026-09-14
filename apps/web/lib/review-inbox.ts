import type { ChatEngine } from "@opencompany/core";
import type { TaskReadModel } from "@opencompany/protocol";
import { chatSummaryState } from "@/lib/chat-ui";

// An agent turn waiting on the user. Chats and Tasks reach this queue through separate
// projections: chats through the conversation read model, Tasks through the Task read model.
// They cannot share one feed because `refresh_conversation_read_model_v1` only projects
// conversations of kind 'chat', so a Task's own conversation never appears there.
export type ReviewItem = {
  conversationId: string;
  title: string;
  updatedAt: string;
  // Reading an item does not remove it from the queue, so the row carries its own read state:
  // unread items lead, read ones stay behind at a lower emphasis until they are archived.
  unread: boolean;
  // The run is parked on an approval or a question. Reading does not clear this one — only
  // answering does — so it outranks `unread` for both ordering and the sidebar count.
  awaitingInput: boolean;
  source: ReviewItemSource;
};

// A chat carries the model and engine it runs on because the review surface opens the live
// conversation, composer included, and the sidebar summary it could otherwise read from is
// bounded by recency — an older unread chat is missing from it.
export type ReviewItemSource =
  | { kind: "chat"; model: string; engine: ChatEngine }
  | { kind: "task"; taskId: string; displayId: string };

type ConversationCandidate = {
  id: string;
  title: string;
  model: string;
  engine: ChatEngine;
  updatedAt: string;
  archivedAt?: string | null;
  lastSeenAt?: string | null;
  activityState?: "working" | "idle";
  hasUnseen?: boolean;
  awaitingInput?: boolean;
};

export type TaskCandidate = Pick<
  TaskReadModel,
  | "id"
  | "displayId"
  | "name"
  | "conversationId"
  | "status"
  | "hasUnseen"
  | "awaitingInput"
  | "archivedAt"
> & { updatedAt: string };

// A Task carries a readable result only once its run settled with one. `waiting` is not one of
// those: it is a request for input. It enters the queue through the awaiting-input path instead,
// which is what keeps it at the front and keeps it there after it has been read.
const TASK_RESULT_STATUSES = new Set<TaskReadModel["status"]>(["succeeded", "failed"]);
const TASK_UPDATE_STATUSES = new Set<TaskReadModel["status"]>([...TASK_RESULT_STATUSES, "waiting"]);

/**
 * Whether a Task's unread flag stands for a result someone can read.
 *
 * Distinct from being awaiting input: a `waiting` Task has a request to answer, not a result, and
 * reaches the queue through `isTaskAwaitingInput` instead.
 */
export function taskHasReadableResult(status: TaskReadModel["status"]): boolean {
  return TASK_RESULT_STATUSES.has(status);
}

/** Whether opening a Task shows the update represented by its unread flag. */
export function taskHasReadableUpdate(status: TaskReadModel["status"]): boolean {
  return TASK_UPDATE_STATUSES.has(status);
}

// Read items stay until they are archived, so the queue needs its own tail: every unread item is
// kept, and read ones beyond this many fall off the bottom. Without it the list would grow into
// the workspace's entire finished history, which is a log, not a queue.
const READ_ITEM_LIMIT = 50;

/**
 * The review queue: agent turns that finished with something to read, and runs parked on the
 * reader.
 *
 * Tasks and chats share one recency-ordered list. They are different projections, not different
 * kinds of work to the reader: both are a turn waiting on them.
 *
 * Parked runs lead, ahead of everything finished. A finished turn can wait; a parked one is
 * holding a run open and is the only thing here the reader can unblock. It also does not leave
 * the front of the queue when they read it — only answering the request moves it.
 *
 * Reading an item keeps it in the list — archiving is what removes it. That makes the queue a
 * place the reader can come back to instead of one that empties itself under them, and it makes
 * "done with this" an explicit act rather than a side effect of having opened something.
 */
export function selectReviewItems(input: {
  conversations: readonly ConversationCandidate[];
  tasks: readonly TaskCandidate[];
}): ReviewItem[] {
  const chats = input.conversations.filter(isChatInReview).map(
    (conversation): ReviewItem => ({
      conversationId: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      unread: isChatUnread(conversation),
      awaitingInput: Boolean(conversation.awaitingInput),
      source: {
        kind: "chat",
        model: conversation.model,
        engine: conversation.engine,
      },
    }),
  );

  const tasks = input.tasks.filter(isTaskInReview).map(
    (task): ReviewItem => ({
      conversationId: task.conversationId,
      title: task.name,
      updatedAt: task.updatedAt,
      unread: Boolean(task.hasUnseen),
      awaitingInput: isTaskAwaitingInput(task),
      source: { kind: "task", taskId: task.id, displayId: task.displayId },
    }),
  );

  const ordered = [...tasks, ...chats].toSorted((left, right) => {
    const byAwaitingInput = Number(right.awaitingInput) - Number(left.awaitingInput);
    if (byAwaitingInput !== 0) return byAwaitingInput;
    return updatedAtMs(right) - updatedAtMs(left);
  });

  const items: ReviewItem[] = [];
  let readItems = 0;
  for (const item of ordered) {
    if (!item.unread && !item.awaitingInput) {
      if (readItems >= READ_ITEM_LIMIT) continue;
      readItems += 1;
    }
    items.push(item);
  }
  return items;
}

// A chat belongs in the queue once its run settled: still-`working` conversations have nothing
// finished to read yet. A chat the user has neither read nor been notified about never carried a
// result in the first place — a new conversation nobody has written in — so it stays out.
//
// A parked run is the exception on both counts. It has not settled and it may never have been
// read, but it is blocked on the reader, which is the strongest reason to list something here.
function isChatInReview(conversation: ConversationCandidate) {
  if (conversation.archivedAt) return false;
  if (conversation.awaitingInput) return true;
  if (chatSummaryState(conversation) === "working") return false;
  return Boolean(conversation.hasUnseen) || Boolean(conversation.lastSeenAt);
}

function isChatUnread(conversation: ConversationCandidate) {
  return chatSummaryState(conversation) === "done_unseen";
}

function isTaskInReview(task: TaskCandidate) {
  if (task.archivedAt) return false;
  return taskHasReadableResult(task.status) || isTaskAwaitingInput(task);
}

// `waiting` and a pending approval are two records of the same situation: the runner parks the
// Task for the durable pause, while the coding engine holds a `running` Task open as it polls for
// a permission decision.
function isTaskAwaitingInput(task: TaskCandidate) {
  return task.status === "waiting" || Boolean(task.awaitingInput);
}

// The sidebar badge counts work the user still has to get to: unread results, plus every parked
// run. Read results drop out — they keep their place in the queue but are dealt with. A parked run
// does not, because reading it changes nothing; it is still holding a run open until they answer.
export function countAwaitingReview(input: {
  conversations: readonly ConversationCandidate[];
  tasks: readonly TaskCandidate[];
}): number {
  const chats = input.conversations.filter(
    (conversation) =>
      isChatInReview(conversation) &&
      (Boolean(conversation.awaitingInput) || isChatUnread(conversation)),
  ).length;
  const tasks = input.tasks.filter(
    (task) => isTaskInReview(task) && (isTaskAwaitingInput(task) || task.hasUnseen),
  ).length;
  return chats + tasks;
}

function updatedAtMs(item: ReviewItem) {
  const timestamp = new Date(item.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

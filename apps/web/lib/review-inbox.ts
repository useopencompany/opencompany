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
};

export type TaskCandidate = Pick<
  TaskReadModel,
  "id" | "displayId" | "name" | "conversationId" | "status" | "hasUnseen" | "archivedAt"
> & { updatedAt: string };

// A Task carries a readable result only once its run settled with one. `waiting` is excluded on
// purpose: settlement raises the same unread flag when a run pauses for an action approval, and
// that is a request for input rather than a result to read. `canceled` had no result to produce.
const TASK_RESULT_STATUSES = new Set<TaskReadModel["status"]>(["succeeded", "failed"]);

// Read items stay until they are archived, so the queue needs its own tail: every unread item is
// kept, and read ones beyond this many fall off the bottom. Without it the list would grow into
// the workspace's entire finished history, which is a log, not a queue.
const READ_ITEM_LIMIT = 50;

/**
 * The review queue: agent turns that finished with something to read.
 *
 * Tasks and chats share one recency-ordered list. They are different projections, not different
 * kinds of work to the reader: both are a finished turn waiting on them.
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
      source: { kind: "task", taskId: task.id, displayId: task.displayId },
    }),
  );

  const ordered = [...tasks, ...chats].toSorted(
    (left, right) => updatedAtMs(right) - updatedAtMs(left),
  );

  const items: ReviewItem[] = [];
  let readItems = 0;
  for (const item of ordered) {
    if (!item.unread) {
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
function isChatInReview(conversation: ConversationCandidate) {
  if (conversation.archivedAt) return false;
  if (chatSummaryState(conversation) === "working") return false;
  return Boolean(conversation.hasUnseen) || Boolean(conversation.lastSeenAt);
}

function isChatUnread(conversation: ConversationCandidate) {
  return chatSummaryState(conversation) === "done_unseen";
}

function isTaskInReview(task: TaskCandidate) {
  return !task.archivedAt && TASK_RESULT_STATUSES.has(task.status);
}

// The sidebar badge counts genuinely unread work only: read items keep their place in the queue
// but are no longer something the user has to get to.
export function countAwaitingReview(input: {
  conversations: readonly ConversationCandidate[];
  tasks: readonly TaskCandidate[];
}): number {
  const chats = input.conversations.filter(
    (conversation) => isChatInReview(conversation) && isChatUnread(conversation),
  ).length;
  return chats + input.tasks.filter((task) => isTaskInReview(task) && task.hasUnseen).length;
}

function updatedAtMs(item: ReviewItem) {
  const timestamp = new Date(item.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

import { chatSummaryState } from "@/lib/chat-ui";

// An agent turn the user has not read yet. Both chats and Tasks land here through the same
// signal: every Task owns a conversation, and `hasUnseen` flips to true on that conversation
// when its run settles (apps/runner/src/task-turn.ts) exactly as it does for a chat reply.
export type ReviewItem = {
  conversationId: string;
  title: string;
  updatedAt: string;
  source: ReviewItemSource;
};

export type ReviewItemSource =
  | { kind: "chat" }
  | { kind: "task"; taskId: string; displayId: string };

export type ReviewGroup = {
  kind: "task" | "chat";
  label: string;
  items: ReviewItem[];
};

type ConversationCandidate = {
  id: string;
  title: string;
  updatedAt: string;
  archivedAt?: string | null;
  activityState?: "working" | "idle";
  hasUnseen?: boolean;
};

type TaskCandidate = {
  id: string;
  display_id: string;
  session_id: string | null;
  archived_at: string | null;
};

/**
 * The review queue: conversations whose last agent turn finished and has not been read.
 *
 * Items leave this list as soon as they are marked seen. ReviewInbox holds the ones the reader
 * opened during a visit so the list does not resequence under the cursor.
 */
export function selectReviewItems(input: {
  conversations: readonly ConversationCandidate[];
  tasks: readonly TaskCandidate[];
}): ReviewItem[] {
  const taskByConversationId = new Map<string, TaskCandidate>();
  for (const task of input.tasks) {
    if (!task.session_id || task.archived_at) continue;
    taskByConversationId.set(task.session_id, task);
  }

  return input.conversations
    .filter((conversation) => !conversation.archivedAt)
    .filter(isAwaitingReview)
    .map((conversation) => {
      const task = taskByConversationId.get(conversation.id);
      return {
        conversationId: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        source: task
          ? ({ kind: "task", taskId: task.id, displayId: task.display_id } as const)
          : ({ kind: "chat" } as const),
      };
    })
    .toSorted((left, right) => updatedAtMs(right) - updatedAtMs(left));
}

// A conversation is ready for review once its run settled (`done_unseen`). Still-`working`
// conversations are deliberately excluded: there is nothing finished to read yet.
function isAwaitingReview(conversation: ConversationCandidate) {
  return chatSummaryState(conversation) === "done_unseen";
}

export function groupReviewItems(items: readonly ReviewItem[]): ReviewGroup[] {
  const tasks = items.filter((item) => item.source.kind === "task");
  const chats = items.filter((item) => item.source.kind === "chat");
  return [
    { kind: "task" as const, label: "Task results", items: tasks },
    { kind: "chat" as const, label: "Chat replies", items: chats },
  ].filter((group) => group.items.length > 0);
}

// The sidebar badge counts only genuinely unread work, so it does not keep counting items the
// user already opened and is holding in place on the review surface.
export function countAwaitingReview(input: {
  conversations: readonly ConversationCandidate[];
}): number {
  return input.conversations.filter(
    (conversation) => !conversation.archivedAt && isAwaitingReview(conversation),
  ).length;
}

function updatedAtMs(item: ReviewItem) {
  const timestamp = new Date(item.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

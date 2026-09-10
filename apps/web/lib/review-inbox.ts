import type { TaskReadModel } from "@opencompany/protocol";
import { type ChatUiMessage, chatSummaryState } from "@/lib/chat-ui";

// An agent turn the user has not read yet. Chats and Tasks reach this queue through separate
// projections: chats through the conversation read model, Tasks through the Task read model.
// They cannot share one feed because `refresh_conversation_read_model_v1` only projects
// conversations of kind 'chat', so a Task's own conversation never appears there.
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

export type TaskCandidate = Pick<
  TaskReadModel,
  "id" | "displayId" | "name" | "conversationId" | "status" | "hasUnseen" | "archivedAt"
> & { updatedAt: string };

// A Task carries a readable result only once its run settled with one. `waiting` is excluded on
// purpose: settlement raises the same unread flag when a run pauses for an action approval, and
// that is a request for input rather than a result to read. `canceled` had no result to produce.
const TASK_RESULT_STATUSES = new Set<TaskReadModel["status"]>(["succeeded", "failed"]);

/**
 * The review queue: agent turns that finished with something to read and have not been read yet.
 *
 * Items leave this list as soon as they are marked seen. ReviewInbox holds the ones the reader
 * opened during a visit so the list does not resequence under the cursor.
 */
export function selectReviewItems(input: {
  conversations: readonly ConversationCandidate[];
  tasks: readonly TaskCandidate[];
}): ReviewItem[] {
  const chats = input.conversations
    .filter((conversation) => !conversation.archivedAt)
    .filter(isChatAwaitingReview)
    .map(
      (conversation): ReviewItem => ({
        conversationId: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        source: { kind: "chat" },
      }),
    );

  const tasks = input.tasks.filter(isTaskAwaitingReview).map(
    (task): ReviewItem => ({
      conversationId: task.conversationId,
      title: task.name,
      updatedAt: task.updatedAt,
      source: { kind: "task", taskId: task.id, displayId: task.displayId },
    }),
  );

  return [...tasks, ...chats].toSorted((left, right) => updatedAtMs(right) - updatedAtMs(left));
}

// A chat is ready for review once its run settled (`done_unseen`). Still-`working` conversations
// are deliberately excluded: there is nothing finished to read yet.
function isChatAwaitingReview(conversation: ConversationCandidate) {
  return chatSummaryState(conversation) === "done_unseen";
}

function isTaskAwaitingReview(task: TaskCandidate) {
  return task.hasUnseen && !task.archivedAt && TASK_RESULT_STATUSES.has(task.status);
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
  tasks: readonly TaskCandidate[];
}): number {
  const chats = input.conversations.filter(
    (conversation) => !conversation.archivedAt && isChatAwaitingReview(conversation),
  ).length;
  return chats + input.tasks.filter(isTaskAwaitingReview).length;
}

function updatedAtMs(item: ReviewItem) {
  const timestamp = new Date(item.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Whether an assistant turn is still asking the reader to approve an action.
 *
 * Pausing for an approval settles the run and raises the same unread flag a finished result does,
 * so the queue cannot tell the two apart from the conversation projection alone. The transcript
 * can: a part stays `approval-requested` until the decision is recorded as `approval-responded`.
 * Both the opencompany action tool and the Codex approval tool use that state.
 */
export function hasPendingApproval(message: Pick<ChatUiMessage, "parts">): boolean {
  return message.parts.some((part) => "state" in part && part.state === "approval-requested");
}

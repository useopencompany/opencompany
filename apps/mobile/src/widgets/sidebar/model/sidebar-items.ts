import type { PullRequestState } from "@opencompany/core/pull-requests";
import type { SessionPullRequestDto } from "@opencompany/protocol/schemas";
import type { StoredConversation } from "@/widgets/chat/model/chat-store";
import { PINNED_CHAT_LIMIT } from "@/widgets/chat/model/conversation-actions";

/** Finished work older than this leaves Recents, matching the web sidebar. */
const RECENT_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The same four states web's sidebar marker shows, in the same priority order. */
export type SidebarRowState = "awaiting_input" | "working" | "done_unseen" | "done_seen";

export interface SessionPullRequest {
  conversationId: string;
  repository: string;
  number: number;
  url: string;
  state: PullRequestState;
}

export interface SidebarItem {
  conversation: StoredConversation;
  state: SidebarRowState;
  /** Still owed something: working, or parked on the reader. These lead Recents at any age. */
  unfinished: boolean;
}

export interface SidebarSections {
  pinned: SidebarItem[];
  recents: SidebarItem[];
}

const isTaskRunning = (status: string) => status === "queued" || status === "running";

// A Task's unread flag only means something the reader can act on: a result, or a request.
const TASK_READABLE_STATUSES = new Set(["succeeded", "failed", "waiting"]);

export const sidebarRowState = (conversation: StoredConversation): SidebarRowState => {
  const task = conversation.task;
  if (conversation.kind === "task" && task) {
    if (conversation.awaitingInput || task.status === "waiting") return "awaiting_input";
    if (isTaskRunning(task.status) || conversation.hasLocalWork) return "working";
    return conversation.hasUnseen && TASK_READABLE_STATUSES.has(task.status)
      ? "done_unseen"
      : "done_seen";
  }
  if (conversation.awaitingInput) return "awaiting_input";
  if (
    conversation.activityState === "working" ||
    conversation.hasLocalWork ||
    conversation.provisional
  )
    return "working";
  return conversation.hasUnseen ? "done_unseen" : "done_seen";
};

const updatedAtMs = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const matchesSearch = (conversation: StoredConversation, query: string) =>
  conversation.title.toLocaleLowerCase().includes(query) ||
  Boolean(conversation.task?.displayId.toLocaleLowerCase().includes(query));

/**
 * Pinned chats newest pin first, then one Recents list mixing chats and Tasks: unfinished work
 * first, then latest activity. Finished work drops out after seven days; pins and unfinished work
 * never age out. Search narrows these two sections and never reaches archives or older history.
 */
export const buildSidebarSections = (
  conversations: readonly StoredConversation[],
  options: { now: number; search: string },
): SidebarSections => {
  const query = options.search.trim().toLocaleLowerCase();
  const eligible = conversations
    .filter((conversation) => conversation.inSidebar || conversation.provisional)
    .map((conversation) => {
      const state = sidebarRowState(conversation);
      return {
        conversation,
        state,
        unfinished: state === "working" || state === "awaiting_input",
      };
    });

  const pinned = eligible
    .filter((item) => item.conversation.kind === "chat" && item.conversation.pinnedAt)
    .sort(
      (left, right) =>
        updatedAtMs(right.conversation.pinnedAt ?? "") -
        updatedAtMs(left.conversation.pinnedAt ?? ""),
    )
    .slice(0, PINNED_CHAT_LIMIT);
  const pinnedIds = new Set(pinned.map((item) => item.conversation.id));

  const recents = eligible
    .filter(
      (item) =>
        !pinnedIds.has(item.conversation.id) &&
        (item.unfinished ||
          updatedAtMs(item.conversation.updatedAt) >= options.now - RECENT_ACTIVITY_WINDOW_MS),
    )
    .sort((left, right) => {
      const byUnfinished = Number(right.unfinished) - Number(left.unfinished);
      if (byUnfinished !== 0) return byUnfinished;
      return updatedAtMs(right.conversation.updatedAt) - updatedAtMs(left.conversation.updatedAt);
    });

  if (!query) return { pinned, recents };
  return {
    pinned: pinned.filter((item) => matchesSearch(item.conversation, query)),
    recents: recents.filter((item) => matchesSearch(item.conversation, query)),
  };
};

// Higher wins: how far through review a PR is, with a red `blocked` PR above a healthy `open` one.
const PULL_REQUEST_PRECEDENCE: Record<PullRequestState, number> = {
  closed: 0,
  draft: 1,
  open: 2,
  blocked: 3,
  merged: 4,
};

const PULL_REQUEST_STATES = new Set<string>(Object.keys(PULL_REQUEST_PRECEDENCE));

/**
 * One PR per conversation, as on web: the one furthest along wins, and ties keep the first link.
 * A state this build does not know is dropped rather than drawn without a color.
 */
export const indexPullRequestsByConversation = (
  links: readonly SessionPullRequestDto[],
): ReadonlyMap<string, SessionPullRequest> => {
  const byConversation = new Map<string, SessionPullRequest>();
  for (const link of links) {
    if (!PULL_REQUEST_STATES.has(link.state)) continue;
    const candidate: SessionPullRequest = {
      conversationId: link.conversationId,
      repository: link.repository,
      number: link.number,
      url: link.url,
      state: link.state as PullRequestState,
    };
    const current = byConversation.get(link.conversationId);
    if (
      !current ||
      PULL_REQUEST_PRECEDENCE[candidate.state] > PULL_REQUEST_PRECEDENCE[current.state]
    ) {
      byConversation.set(link.conversationId, candidate);
    }
  }
  return byConversation;
};

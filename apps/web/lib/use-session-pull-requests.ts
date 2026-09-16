"use client";

import type { PullRequestState } from "@opencompany/core/pull-requests";
import { useEffect, useState } from "react";
import { listSessionPullRequests, type SessionPullRequest } from "./session-pull-requests";

/**
 * How often the client re-asks for PR status while the tab is in the foreground.
 *
 * Matches the server's own refresh TTL, so a poll that lands inside the server's cache window is
 * answered from it rather than reaching GitHub. A hidden tab does not poll at all: nobody is
 * looking at the sidebar, and a background tab quietly spending a user's GitHub rate limit is
 * exactly the kind of cost that is invisible until it is a problem.
 */
const POLL_INTERVAL_MS = 60_000;

/** Linked PRs keyed by the conversation that opened them. */
export type SessionPullRequestsByConversation = ReadonlyMap<string, SessionPullRequest>;

const EMPTY: SessionPullRequestsByConversation = new Map();

export function useSessionPullRequests(): SessionPullRequestsByConversation {
  const [byConversation, setByConversation] = useState<SessionPullRequestsByConversation>(EMPTY);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "visible") {
        try {
          const links = await listSessionPullRequests({
            fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }),
          });
          if (controller.signal.aborted) return;
          setByConversation(indexByConversation(links));
        } catch {
          // The badge is ambient: a failed poll leaves the last known states on screen and the
          // next tick tries again. Surfacing this would put an error in front of the reader for
          // something they did not ask for and cannot act on.
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    // Coming back to a tab that has been hidden for a while should not wait out the interval.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return byConversation;
}

/**
 * One PR per conversation: the sidebar row has room for a single badge.
 *
 * A session that opened several PRs shows the one furthest along, because that is the one whose
 * state the reader is most likely acting on — a merged follow-up outranks the stale original.
 */
export function indexByConversation(
  links: readonly SessionPullRequest[],
): SessionPullRequestsByConversation {
  const byConversation = new Map<string, SessionPullRequest>();
  for (const link of links) {
    const current = byConversation.get(link.conversationId);
    if (!current || statePrecedence(link.state) > statePrecedence(current.state)) {
      byConversation.set(link.conversationId, link);
    }
  }
  return byConversation;
}

// Higher wins. Ordered by how far through review a PR is, with `blocked` above plain `open`
// because a red PR is the one asking for attention.
function statePrecedence(state: PullRequestState) {
  switch (state) {
    case "closed":
      return 0;
    case "draft":
      return 1;
    case "open":
      return 2;
    case "blocked":
      return 3;
    case "merged":
      return 4;
  }
}

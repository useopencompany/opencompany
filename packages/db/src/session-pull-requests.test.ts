import { describe, expect, it } from "vitest";
import {
  type SessionPullRequestView,
  selectStaleSessionPullRequests,
} from "./session-pull-requests";

const TTL_MS = 60_000;
const NOW = new Date("2026-09-16T12:00:00Z").getTime();

function link(overrides: Partial<SessionPullRequestView>): SessionPullRequestView {
  return {
    id: "link-1",
    chatSessionId: "conversation_1",
    repository: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    state: "open",
    checkedAt: new Date(NOW),
    ...overrides,
  };
}

describe("selectStaleSessionPullRequests", () => {
  it("always reads a link that has never been checked", () => {
    const links = [link({ checkedAt: null, state: "merged" })];
    expect(selectStaleSessionPullRequests(links, TTL_MS, NOW)).toEqual(links);
  });

  it("never re-reads a merged or closed PR, however old", () => {
    const ancient = new Date(NOW - 30 * 24 * 60 * 60 * 1000);
    const links = [
      link({ id: "merged", state: "merged", checkedAt: ancient }),
      link({ id: "closed", state: "closed", checkedAt: ancient }),
    ];
    expect(selectStaleSessionPullRequests(links, TTL_MS, NOW)).toEqual([]);
  });

  it("re-reads a non-terminal PR once the TTL has elapsed", () => {
    const links = [
      link({ id: "fresh", checkedAt: new Date(NOW - TTL_MS + 1) }),
      link({ id: "stale", checkedAt: new Date(NOW - TTL_MS) }),
      link({ id: "blocked", state: "blocked", checkedAt: new Date(NOW - TTL_MS * 5) }),
      link({ id: "draft", state: "draft", checkedAt: new Date(NOW - TTL_MS * 2) }),
    ];
    expect(selectStaleSessionPullRequests(links, TTL_MS, NOW).map((row) => row.id)).toEqual([
      "stale",
      "blocked",
      "draft",
    ]);
  });
});

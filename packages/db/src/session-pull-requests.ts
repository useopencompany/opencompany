import { randomUUID } from "node:crypto";
import {
  isTerminalPullRequestState,
  type PullRequestRef,
  type PullRequestState,
} from "@opencompany/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./product-schema";
import { chatSessions, sessionPullRequests } from "./product-schema";

type DbSchema = typeof schema;
export type SessionPullRequestDb = Pick<
  PgDatabase<PgQueryResultHKT, DbSchema>,
  "delete" | "insert" | "select" | "update"
>;

/** A linked PR as the API hands it to the client. */
export type SessionPullRequestView = {
  id: string;
  chatSessionId: string;
  repository: string;
  number: number;
  url: string;
  state: PullRequestState;
  checkedAt: Date | null;
};

/**
 * Records that a session opened a PR.
 *
 * Called from the turn projection, so it has to be cheap and it must not care about being called
 * again: the same `gh pr create` output is re-scanned on every delta that follows it within one
 * command, and a replayed turn attempt scans the same events over. The unique index makes the
 * repeat a no-op rather than something callers have to guard.
 *
 * The row lands with the default `open` state and a NULL `checked_at`. Nothing renders it until a
 * status read has confirmed the PR against GitHub.
 */
export async function linkSessionPullRequest(input: {
  db: SessionPullRequestDb;
  chatSessionId: string;
  userWorkosId: string;
  ref: PullRequestRef;
}): Promise<void> {
  await input.db
    .insert(sessionPullRequests)
    .values({
      id: `session_pull_request_${randomUUID()}`,
      chatSessionId: input.chatSessionId,
      userWorkosId: input.userWorkosId,
      repositoryFullName: input.ref.repository,
      number: input.ref.number,
      url: input.ref.url,
    })
    .onConflictDoNothing({
      target: [
        sessionPullRequests.chatSessionId,
        sessionPullRequests.repositoryFullName,
        sessionPullRequests.number,
      ],
    });
}

/**
 * Every PR linked to a session the user owns.
 *
 * Scoped to the caller's own rows rather than to a workspace: the status read behind this uses the
 * caller's GitHub token, so showing them a PR they cannot read would only produce a badge that can
 * never resolve.
 */
export async function listSessionPullRequests(input: {
  db: SessionPullRequestDb;
  userWorkosId: string;
}): Promise<SessionPullRequestView[]> {
  const rows = await input.db
    .select({
      id: sessionPullRequests.id,
      chatSessionId: sessionPullRequests.chatSessionId,
      repository: sessionPullRequests.repositoryFullName,
      number: sessionPullRequests.number,
      url: sessionPullRequests.url,
      state: sessionPullRequests.state,
      checkedAt: sessionPullRequests.checkedAt,
    })
    .from(sessionPullRequests)
    .innerJoin(chatSessions, eq(chatSessions.id, sessionPullRequests.chatSessionId))
    .where(
      and(
        eq(sessionPullRequests.userWorkosId, input.userWorkosId),
        // An archived session has no sidebar row, so its PR has nothing to render on.
        sql`${chatSessions.closedAt} IS NULL`,
      ),
    );
  return rows;
}

/**
 * Which of `links` need a fresh read from GitHub.
 *
 * Merged and closed are final, so those are never re-read however old they are. Everything else
 * ages out after `ttlMs`, and a link that has never been checked is always due.
 */
export function selectStaleSessionPullRequests(
  links: readonly SessionPullRequestView[],
  ttlMs: number,
  now: number,
): SessionPullRequestView[] {
  return links.filter((link) => {
    if (link.checkedAt === null) return true;
    if (isTerminalPullRequestState(link.state)) return false;
    return now - link.checkedAt.getTime() >= ttlMs;
  });
}

/** Writes back what GitHub said, stamping `checked_at` so the TTL restarts. */
export async function recordSessionPullRequestState(input: {
  db: SessionPullRequestDb;
  id: string;
  state: PullRequestState;
  checkedAt: Date;
}): Promise<void> {
  await input.db
    .update(sessionPullRequests)
    .set({ state: input.state, checkedAt: input.checkedAt, updatedAt: input.checkedAt })
    .where(eq(sessionPullRequests.id, input.id));
}

/**
 * Drops links GitHub would not return.
 *
 * A PR that 404s is one the caller can no longer read — the repository went private, the PR was
 * deleted with its branch, or access was revoked. Keeping the row would leave a badge that retries
 * forever and never resolves, so the link is removed and the row goes back to having no badge.
 */
export async function unlinkSessionPullRequests(input: {
  db: SessionPullRequestDb;
  ids: readonly string[];
}): Promise<void> {
  if (input.ids.length === 0) return;
  await input.db.delete(sessionPullRequests).where(inArray(sessionPullRequests.id, [...input.ids]));
}

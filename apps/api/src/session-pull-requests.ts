import {
  type PullRequestStatusQuery,
  readPullRequestStatuses,
} from "@opencompany/agent/integrations/github-pull-request-status";
import {
  GitHubUserAccessAuthError,
  getGitHubUserAccessToken,
  loadGitHubUserIntegration,
} from "@opencompany/agent/integrations/github-user";
import { getDb } from "@opencompany/db/client";
import {
  listSessionPullRequests,
  recordSessionPullRequestState,
  type SessionPullRequestView,
  selectStaleSessionPullRequests,
  unlinkSessionPullRequests,
} from "@opencompany/db/session-pull-requests";
import { captureException } from "@opencompany/observability";
import type { SessionPullRequestDto } from "@opencompany/protocol";

/**
 * How long a PR's state is trusted before GitHub is asked again.
 *
 * The sidebar badge is ambient: a CI run turning red is worth showing promptly, but not worth a
 * webhook ingress and the installation-to-user index that would require. A minute keeps a busy
 * sidebar to roughly one GitHub request per minute per user, whatever the PR count, because the
 * refresh is a single batched query.
 */
export const SESSION_PULL_REQUEST_TTL_MS = 60_000;

/** What a refresh concluded about one link: its new state, or that the link should not survive. */
type RefreshOutcome = SessionPullRequestView["state"] | "unlinked";

/**
 * The caller's linked PRs, refreshed against GitHub when stale.
 *
 * Links that GitHub will not resolve are deleted rather than retried: see
 * `unlinkSessionPullRequests`. Links never yet confirmed are withheld from the response, so a
 * badge only ever appears for a PR GitHub has agreed exists.
 */
export async function listSessionPullRequestStatuses(input: {
  userWorkosId: string;
  now?: Date;
  ttlMs?: number;
}): Promise<SessionPullRequestDto[]> {
  const db = getDb();
  const links = await listSessionPullRequests({ db, userWorkosId: input.userWorkosId });
  if (links.length === 0) return [];

  const now = input.now ?? new Date();
  const stale = selectStaleSessionPullRequests(
    links,
    input.ttlMs ?? SESSION_PULL_REQUEST_TTL_MS,
    now.getTime(),
  );
  const refreshed: ReadonlyMap<string, RefreshOutcome> =
    stale.length > 0 ? await refreshStatuses(stale, input.userWorkosId, now) : new Map();

  return links.flatMap((link) => {
    const outcome = refreshed.get(link.id);
    if (outcome === "unlinked") return [];
    const state = outcome ?? link.state;
    // Withhold a link GitHub has never confirmed. Without this a PR link recorded moments ago
    // would flash an `open` badge before the first status read could contradict it.
    if (outcome === undefined && link.checkedAt === null) return [];
    return [
      {
        conversationId: link.chatSessionId,
        repository: link.repository,
        number: link.number,
        url: link.url,
        state,
      },
    ];
  });
}

/**
 * Reads `stale` from GitHub and writes the answer back.
 *
 * A GitHub failure is not an error the caller should see: the sidebar can render the last known
 * state perfectly well, and failing the whole request would take the rest of the sidebar down with
 * it. So a failed refresh reports and returns nothing, leaving every link on its stored state.
 */
async function refreshStatuses(
  stale: readonly SessionPullRequestView[],
  userWorkosId: string,
  now: Date,
): Promise<Map<string, RefreshOutcome>> {
  const outcomes = new Map<string, RefreshOutcome>();
  const db = getDb();

  const integration = await loadGitHubUserIntegration({ userWorkosId });
  if (!integration) return outcomes;

  try {
    const accessToken = await getGitHubUserAccessToken({
      userWorkosId,
      integrationId: integration.id,
    });
    const queries: PullRequestStatusQuery[] = stale.map((link) => ({
      id: link.id,
      repository: link.repository,
      number: link.number,
    }));
    const results = await readPullRequestStatuses({ accessToken, queries });

    const unlinked: string[] = [];
    for (const result of results) {
      if (!result.found) {
        unlinked.push(result.id);
        outcomes.set(result.id, "unlinked");
        continue;
      }
      outcomes.set(result.id, result.state);
      await recordSessionPullRequestState({
        db,
        id: result.id,
        state: result.state,
        checkedAt: now,
      });
    }
    await unlinkSessionPullRequests({ db, ids: unlinked });
  } catch (error) {
    // A disconnected or expired GitHub connection is an ordinary state for this endpoint, not a
    // fault: the user simply has no way to read their PRs until they reconnect.
    if (!(error instanceof GitHubUserAccessAuthError)) {
      captureException(error, {
        event: "opencompany.session_pull_request_refresh_failed",
        user_workos_id: userWorkosId,
        link_count: stale.length,
      });
    }
    return new Map();
  }

  return outcomes;
}

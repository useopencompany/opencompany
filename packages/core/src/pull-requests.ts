/**
 * Pull requests a coding-agent session opened.
 *
 * A session's link to a PR is discovered while the turn streams (the agent either calls a
 * create-pull-request tool or prints the URL from `gh pr create`), and the PR's state is read
 * back from GitHub on demand. This module holds the parts of that with no IO: recognising a PR
 * reference, and collapsing GitHub's several orthogonal "is this PR healthy" signals into the one
 * state the sidebar shows.
 */

/** What the sidebar renders for a linked PR. */
export type PullRequestState = "draft" | "open" | "blocked" | "merged" | "closed";

export const PULL_REQUEST_STATES = ["draft", "open", "blocked", "merged", "closed"] as const;

/**
 * Narrows a state off the wire.
 *
 * The generated protocol types widen enums to `string`, so this is where a response becomes the
 * union the UI can switch on exhaustively.
 */
export function isPullRequestState(value: unknown): value is PullRequestState {
  return typeof value === "string" && (PULL_REQUEST_STATES as readonly string[]).includes(value);
}

/** Neither side of GitHub can move a merged or closed PR again, so its state never needs re-reading. */
const TERMINAL_STATES = new Set<PullRequestState>(["merged", "closed"]);

export function isTerminalPullRequestState(state: PullRequestState) {
  return TERMINAL_STATES.has(state);
}

export type PullRequestRef = {
  /** `owner/repo`, as GitHub spells it. */
  repository: string;
  number: number;
  url: string;
};

// GitHub allows `.` `-` `_` in owner and repo names. Anchored on the canonical PR URL rather than
// a bare `#123` so a PR number the agent mentions in prose is never mistaken for a link.
const PULL_REQUEST_URL_PATTERN =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Every distinct PR URL in `text`, in first-seen order.
 *
 * Callers feed this assistant prose, command output, and tool results, so the same PR usually
 * appears several times in one turn; de-duplicating here keeps the caller from having to.
 */
export function findPullRequestRefs(text: string): PullRequestRef[] {
  const found = new Map<string, PullRequestRef>();
  for (const match of text.matchAll(PULL_REQUEST_URL_PATTERN)) {
    const [url, owner, repo, rawNumber] = match;
    const number = Number(rawNumber);
    // `/pull/0` is not a PR, and a number past 2^53 would already have lost precision.
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const repository = `${owner}/${repo}`;
    const key = `${repository.toLowerCase()}#${number}`;
    if (found.has(key)) continue;
    found.set(key, { repository, number, url: `https://github.com/${repository}/pull/${number}` });
  }
  return [...found.values()];
}

/**
 * The one pull request a piece of agent-authored reporting is about, if any.
 *
 * Unlike `findPullRequestRefs`, this is for text the agent wrote *about its own run* — a Task's
 * result and outcome comment. Those two fields are the agent's account of what it did, so a PR URL
 * in them is the PR the run opened rather than one it happened to cite, and taking the first keeps
 * every surface that reads a Task's PR pointing at the same one.
 */
export function findReportedPullRequestRef(
  ...texts: Array<string | null | undefined>
): PullRequestRef | null {
  for (const text of texts) {
    const [ref] = text ? findPullRequestRefs(text) : [];
    if (ref) return ref;
  }
  return null;
}

/** The MCP tools that open a PR, across GitHub's hosted MCP server and any namespaced alias of it. */
export function isPullRequestCreationTool(toolName: string | null | undefined) {
  if (!toolName) return false;
  const bare = toolName.includes("__") ? (toolName.split("__").pop() ?? toolName) : toolName;
  return bare === "create_pull_request";
}

/**
 * GitHub reports PR health across four fields that can disagree, so the order below is what
 * decides the state:
 *
 * 1. `merged` wins outright — a merged PR has no meaningful checks or mergeability left.
 * 2. Then `closed`, for the same reason.
 * 3. Then failing checks, because a red build is the thing the reader most needs to see.
 * 4. Then a blocking merge state. `BEHIND` and `UNKNOWN` are deliberately *not* blocking: being
 *    behind the base branch is normal mid-review, and `UNKNOWN` means GitHub is still computing.
 * 5. Draft outranks plain open, so a draft never shows up as ready-to-merge green.
 */
export function derivePullRequestState(input: {
  merged: boolean;
  closed: boolean;
  isDraft: boolean;
  /** GitHub's rollup of every check and commit status on the head commit. */
  checksState?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  mergeStateStatus?:
    | "BEHIND"
    | "BLOCKED"
    | "CLEAN"
    | "DIRTY"
    | "DRAFT"
    | "HAS_HOOKS"
    | "UNKNOWN"
    | "UNSTABLE"
    | null;
}): PullRequestState {
  if (input.merged) return "merged";
  if (input.closed) return "closed";
  if (input.checksState === "FAILURE" || input.checksState === "ERROR") return "blocked";
  if (input.mergeStateStatus === "BLOCKED" || input.mergeStateStatus === "DIRTY") return "blocked";
  if (input.isDraft) return "draft";
  return "open";
}

export const PULL_REQUEST_STATE_LABELS: Record<PullRequestState, string> = {
  draft: "Draft pull request",
  open: "Pull request open",
  blocked: "Pull request blocked",
  merged: "Pull request merged",
  closed: "Pull request closed",
};

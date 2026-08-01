// Tasks don't have a structured "linked PR" field yet — agents just mention the
// PR URL in their free-text result/outcome comment. Scanning for it here keeps
// that parsing in one place so it's easy to swap for a structured field later
// (e.g. once github_open_pull_request returns a PR URL the runner can persist).
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

export function extractGitHubPullRequestUrl(
  ...texts: Array<string | null | undefined>
): string | null {
  for (const text of texts) {
    const match = text?.match(GITHUB_PULL_REQUEST_URL_PATTERN);
    if (match) return match[0];
  }
  return null;
}

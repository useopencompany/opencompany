import { findReportedPullRequestRef } from "@opencompany/core/pull-requests";

// A Task's PR lives in its free-text result/outcome comment rather than a structured field, so the
// board card scans for it. The runner records the same scan as a real session link when a Task
// settles, so the sidebar badge and this card always point at the same pull request; keeping both
// on `findReportedPullRequestRef` is what keeps that true.
export function extractGitHubPullRequestUrl(
  ...texts: Array<string | null | undefined>
): string | null {
  return findReportedPullRequestRef(...texts)?.url ?? null;
}

import type { PullRequestState } from "@opencompany/core/pull-requests";
import { cn } from "@opencompany/ui/lib/utils";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { SessionPullRequest } from "@/lib/session-pull-requests";

/**
 * The state of the pull request a coding session opened, leading that session's sidebar row.
 *
 * Both the glyph and the colour carry the state. Colour alone would be the obvious choice at this
 * size, but four states at 13px is more than hue can carry legibly — and not at all for a
 * colourblind reader. The colours are GitHub's own, so a PR reads the same here as it does on the
 * page this badge links to.
 *
 * Sized to the row's text rather than to the trailing icon buttons: it sits against the session
 * name, and a 24px control there would push every title in the list a third of a word to the right.
 */
export function PullRequestBadge({ pullRequest }: { pullRequest: SessionPullRequest }) {
  const { Glyph, colorClassName, label: stateLabel } = presentationFor(pullRequest.state);
  const label = `${stateLabel}: ${pullRequest.repository} #${pullRequest.number}`;
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      data-testid="sidebar-pull-request-badge"
      data-state={pullRequest.state}
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded transition-colors duration-150 hover:bg-surface-active focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20",
        colorClassName,
      )}
    >
      <Glyph size={13} strokeWidth={1.9} aria-hidden="true" />
    </a>
  );
}

/**
 * A switch rather than a lookup table so the compiler proves every state is covered: adding a
 * sixth state should fail to build, not silently render nothing.
 */
function presentationFor(state: PullRequestState) {
  switch (state) {
    case "draft":
      return {
        Glyph: GitPullRequestDraft,
        colorClassName: "text-pr-draft",
        label: "Draft pull request",
      };
    case "open":
      return { Glyph: GitPullRequest, colorClassName: "text-pr-open", label: "Pull request open" };
    case "blocked":
      return {
        Glyph: GitPullRequestClosed,
        colorClassName: "text-pr-blocked",
        label: "Pull request blocked",
      };
    case "merged":
      return { Glyph: GitMerge, colorClassName: "text-pr-merged", label: "Pull request merged" };
    case "closed":
      return {
        Glyph: GitPullRequestClosed,
        colorClassName: "text-pr-closed",
        label: "Pull request closed",
      };
  }
}

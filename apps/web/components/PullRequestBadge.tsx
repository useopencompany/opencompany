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
 * The same state, spelled out, for a surface with room for it: a started Task's card in chat
 * names the PR and its state so the reader can follow the hand-off without opening the Task.
 */
export function PullRequestPill({ pullRequest }: { pullRequest: SessionPullRequest }) {
  const { Glyph, colorClassName, label: stateLabel } = presentationFor(pullRequest.state);
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${stateLabel}: ${pullRequest.repository} #${pullRequest.number}`}
      data-testid="task-card-pull-request"
      data-state={pullRequest.state}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11.5px] font-medium leading-4 text-ink-muted transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <Glyph size={12} strokeWidth={2} className={colorClassName} aria-hidden="true" />
      <span>#{pullRequest.number}</span>
      <span className="text-ink-subtle">{PILL_STATE_COPY[pullRequest.state]}</span>
    </a>
  );
}

const PILL_STATE_COPY: Record<PullRequestState, string> = {
  draft: "Draft",
  open: "Open",
  blocked: "Blocked",
  merged: "Merged",
  closed: "Closed",
};

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

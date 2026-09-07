# Git contributor email privacy

- Status: Resolved for initial publication
- Date: 2026-09-04
- Decision owner: Repository publication owner

## Context

Git stores an author and committer name and email address in every commit. Those fields are part of
the commit object and become visible when the repository is public. Changing them later rewrites the
affected commit and every descendant commit, which changes commit IDs and disrupts existing clones,
forks, branches, pull requests, and links.

The open-source readiness review scanned every reachable Git ref. It found no live credentials, but
it did find non-noreply contributor addresses in the history. Three personal addresses called out by
the review are reachable from `main`; they are ordinary commit attribution rather than application
data or authentication secrets.

## Decision

We will not rewrite repository history solely because a contributor used a personal address as Git
metadata. Public author metadata is a normal part of Git collaboration, and a blanket rewrite would
cause disproportionate integrity and coordination costs.

That default does not make an unexpected disclosure acceptable. Before changing repository
visibility, the publication owner must privately notify every contributor whose non-noreply address
the final scan classifies as personal or otherwise non-public and provide a clear way to object. The
notice must explain that the address will be public in Git history and that changing local Git
settings affects only future commits. Maintainers must not record the addresses, responses, or other
private contact details in the repository.

Explicit opt-in consent is not required as a blanket publication condition. An objection, evidence
that an address was committed accidentally, or a materially higher-risk address is a release blocker
that the publication owner must resolve with the contributor. Resolution may include replacing that
contributor's historical address with their GitHub-provided noreply address.

If a rewrite is required, perform one coordinated rewrite before publication, cover every branch and
tag intended for publication, have affected contributors approve the replacement identity, and rerun
the all-ref secret and personal-data scans. Treat force-pushing rewritten history and purging old
objects from the host as an explicit publication operation; updating the default branch alone is not
sufficient.

## Initial publication record

On 2026-09-07, the publication owner confirmed that the affected contributors are aware that their
Git attribution will become public, consent to publication, and raised no objection. The final scan
covered all live branches and pull-request heads intended to remain reachable. No history rewrite is
required for the initial publication. Raw addresses and private responses are deliberately not
recorded in the repository.

## Future commits

Contributors choose the identity attached to their work. We recommend a GitHub-provided noreply
address for contributors who do not want a personal address published. `CONTRIBUTING.md` explains
how to configure one and how to enable GitHub's push protection. We do not reject a contribution
merely because its author intentionally uses another address.

This policy applies only to Git author and committer metadata. Email addresses in source files,
fixtures, logs, generated artifacts, commit messages, or other content still require context-specific
review and may need removal.

## Publication checklist

The publication owner must record completion outside the repository because the evidence contains
personal contact information:

- rerun independent secret and personal-data scans across every ref intended for publication;
- identify contributors whose history contains personal or otherwise non-public addresses;
- send and track the private notices;
- resolve every objection before the visibility change;
- if history was rewritten, verify all published refs and rerun both scans; and
- make the repository visibility change only through the owner-approved publication runbook.

## References

- [GitHub: Setting your commit email address](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
- [GitHub: Blocking command-line pushes that expose your personal email](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address)
- [GitHub: Changing a commit message](https://docs.github.com/en/pull-requests/how-tos/commit-changes/changing-a-commit-message)

# Code Review

**Reviewer:** AI
**Date:** 2026-06-16
**Reviewing:** AI-extensible KPI metric spec changes

## Summary

The implementation keeps the existing KPI architecture intact and adds a constrained config-spec layer plus a bounded GitHub PR search-count metric. The main safety boundaries are present: config validation runs server-side, repository/date scope is platform-controlled, provider credentials stay inside trusted provider code, and query pagination is capped.

## What Works Well

- The design avoids arbitrary generated-code execution while still creating a future target for AI-authored metric configs.
- `kpi_metrics.config` is reused, so no schema churn is needed.
- The Add KPI dialog remains catalog-driven instead of adding provider-specific UI.
- GitHub custom search filters reject repository, organization, user, date, and issue-query qualifiers that would break scoping or time-range semantics.
- Focused tests cover generic config validation and GitHub search-filter normalization.

## Issues

### High

- None.

### Medium

- None.

### Low

- Live GitHub GraphQL search behavior for parenthesized `repo:a/b OR repo:c/d` clauses still needs browser/dev-workspace verification with a real installation token. The implementation bounds query length and falls back to metric error state, but the exact provider parser behavior is not covered by unit tests.
- The first flexible metric is GitHub-only. PostHog/Linear custom specs and cross-provider calculated metrics remain intentionally deferred.

## Recommendation

[x] Ready for human review
[ ] Needs revision (see issues above)

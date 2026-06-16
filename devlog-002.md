# Devlog: AI-Authored KPI Metric Specs

**Date:** 2026-06-16
**Implementing:** plan.md

## What Was Done

- Reframed the KPI direction in `research.md` and `plan.md`: AI should author validated metric specs first, not arbitrary runtime code.
- Added `decision-dynamic-kpi-metric-specs.md` to capture that architecture choice.
- Added `KpiConfigField` and catalog-driven config support in the Add KPI dialog and `createKpiCard`.
- Added `normalizeKpiMetricConfig` as the shared validation boundary for form-authored and future AI-authored configs.
- Added a configurable GitHub `github.pull_request_search_count` metric for PR search filters such as `is:merged author:octocat`.
- Added focused tests for generic KPI config validation and GitHub PR search filter validation.

## Tricky Parts

- The custom GitHub metric must stay scoped to connected repositories, so the user-provided filter rejects `repo:`, `org:`, and `user:` qualifiers.
- Time range is controlled by the KPI card, so the GitHub filter rejects explicit date qualifiers and the provider adds the correct `created:` or `merged:` range during refresh.
- The GitHub search metric is event-bucketed by returned PR timestamps rather than total-only counts, so charts/deltas continue to use the existing datapoint summarizer.

## Decisions Made

- Config validation is a pure helper in `apps/web/lib/kpis/config.ts`, not inline in the server action.
- The first flexible metric is GitHub-only and deliberately bounded. PostHog HogQL, Linear GraphQL, and cross-provider calculated metrics remain future work.

## Deviations from Plan

- No schema migration was needed because `kpi_metrics.config` already supports provider-specific JSON.
- The verification command used the new focused tests rather than the older summarize test named in the draft plan.

## Next Steps

- Add AI authoring that emits the same validated config objects through Structured Outputs or an equivalent schema-constrained generation path.
- Browser-test the Add KPI dialog with a real GitHub connection and a search like `is:merged author:<login>`.

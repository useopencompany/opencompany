# Plan: AI-Authored KPI Metric Specs

**Status:** Implemented
**Author:** Codex
**Created:** 2026-06-16

## Summary

Keep the KPI dashboard's current provider/snapshot architecture, but evolve the metric catalog from static entries into validated, configurable metric specs. Do not run arbitrary AI-generated code in the web app. For this branch, implement the smallest useful proof: catalog-driven config fields plus a generic GitHub pull-request search-count KPI that can express "PRs merged by a given person" as data.

## Motivation

The existing KPI implementation is good for onboarding: users can click "Open PRs", "New Linear issues", or "Weekly active users." It is not enough for the long tail. Founders will ask for business-specific questions we cannot enumerate. The right CTO-level direction is to make the KPI layer programmable through constrained, validated specs first, then add AI authoring over those specs later.

## Goals

- Preserve the existing `KpiProvider -> datapoints -> snapshots -> cards` architecture.
- Add a safe custom-metric foundation without another database migration.
- Let catalog entries declare simple config fields the generic Add KPI dialog can render.
- Let `createKpiCard` accept config, validate it, and include it in the existing config hash.
- Add a GitHub pull-request search-count capability that supports metrics like "merged PRs by a person."
- Document the decision to prefer AI-generated JSON specs over arbitrary generated runtime code.

## Non-Goals

- No OpenAI API integration in this branch.
- No generated JavaScript execution, sandbox runtime, SDK runner, or remote worker.
- No custom PostHog HogQL editor yet.
- No Linear custom GraphQL editor yet.
- No multi-provider calculated metrics yet.
- No schema migration unless implementation discovers the existing config JSON is insufficient.

## Technical Design

### Metric spec model

`KpiCatalogEntry` gains an optional `configFields` array. The first field types should stay boring:

```ts
type KpiConfigField = {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  maxLength?: number;
};
```

The UI renders these fields generically. The server accepts `config?: Record<string, unknown>` and validates it against `entry.configFields`.

This is deliberately not provider-specific UI. A future AI authoring step can produce the same config object, and the same server validation path will apply.

### GitHub flexible metric

Add a new catalog entry:

- `key`: `github.pull_request_search_count`
- `label`: `Pull request search count`
- `metricType`: `event`
- `unit`: `count`
- `defaultViz`: `bar`
- `defaultTimeRangeDays`: `30`
- `configFields`:
  - `search`: user-authored GitHub PR search filters, e.g. `is:merged author:octocat`

The provider should:

- Always enforce `is:pr`.
- Reject unsupported input by length and character validation.
- Build bounded queries across the workspace's connected repositories so metrics are scoped to the installed GitHub integration.
- Add a `merged:YYYY-MM-DD..YYYY-MM-DD` range when the user asks for merged PRs; otherwise use `created:YYYY-MM-DD..YYYY-MM-DD`.
- Fetch PR nodes through GitHub GraphQL search, read `createdAt` or `mergedAt`, and bucket them into the existing day buckets.
- Cap pagination and report a bounded result rather than doing unbounded API work.

This gets the example working and proves the larger architecture: the custom part is a validated config string, not new product code.

### Safety model

- AI-generated specs are data, never code.
- Provider credentials remain inside deterministic server code.
- External provider responses remain validated at the fetch boundary.
- Query costs are bounded by provider-owned caps.
- The existing refresh engine stores failures as metric state, so bad custom specs show as card errors without breaking the sweep.

## Implementation Approach

1. Update `apps/web/lib/kpis/types.ts` with `KpiConfigField` and optional `configFields`.
2. Update `createKpiCard` in `apps/web/lib/kpis/actions.ts` to accept `config`, validate configured fields, and merge with any provider-resolved config.
3. Update `apps/web/components/kpis/AddKpiDialog.tsx` to render catalog config fields, maintain config state, and send config to `createKpiCard`.
4. Add `github.pull_request_search_count` to `apps/web/lib/kpis/providers/github.ts`.
5. Implement a GitHub search-count fetch path that buckets PRs into daily event datapoints and supports the "merged by author" example.
6. Add or update focused tests for config hashing and any pure validation/helpers introduced.
7. Update progress in this plan and write a decision record.
8. Run focused verification: new config/GitHub provider tests, Biome on touched code, web typecheck, and web lint.

## Alternatives Considered

**Arbitrary AI-generated TypeScript executed at refresh time.** Most flexible, but wrong first move. It introduces sandboxing, credential exfiltration risk, resource limits, versioning, review workflows, observability, and rollback concerns. This might be valuable later in a dedicated sandboxed runtime, but not inside the Next.js app.

**Keep only the static catalog.** Safest and fastest, but it fails the product strategy. It makes OpenCompany responsible for shipping every founder-specific KPI.

**Provider-native query strings only.** Useful but uneven. GitHub search strings are reasonable; PostHog HogQL and Linear GraphQL are much riskier because performance and result-shape validation are harder. The better foundation is provider-declared config specs plus deterministic executors.

**Full semantic layer now.** Powerful, but too broad. We do not yet have common entities, dimensions, joins, ownership, or permission semantics across integrations. Start with one provider capability and let the schema evolve from actual use.

## Progress

- [x] Research current KPI implementation and external patterns.
- [x] Decision: prefer AI-generated JSON metric specs over generated runtime code.
- [x] Implement catalog config fields.
- [x] Implement GitHub pull-request search-count metric.
- [x] Verify with focused tests/typecheck/lint.
- [x] Write devlog and self-review.

### Verification

- `bun run --filter @opencompany/web test -- lib/kpis/config.test.ts lib/kpis/providers/github.test.ts` - passed, 9 tests.
- `bunx biome check apps/web/lib/kpis/types.ts apps/web/lib/kpis/config.ts apps/web/lib/kpis/config.test.ts apps/web/lib/kpis/actions.ts apps/web/components/kpis/AddKpiDialog.tsx apps/web/lib/kpis/providers/github.ts apps/web/lib/kpis/providers/github.test.ts` - passed.
- `bun run --filter @opencompany/web typecheck` - passed.
- `bun run --filter @opencompany/web lint` - passed with 6 pre-existing warnings outside touched files.

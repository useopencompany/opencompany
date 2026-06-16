# Research: AI-Extensible KPI Metrics

**Requester:** Louis
**Date:** 2026-06-16

## Requirements

### Original Request

Reconsider the KPI dashboard foundation. The branch currently requires us to explicitly define every supported KPI metric in code. That is valid, but the product should be more flexible: expose deterministic integration primitives, then let users define the KPIs they actually want, potentially with AI or agent-generated metric code/specs. Example: "number of PRs merged by a given person" should not require us to ship a new bespoke metric every time.

### Context

The current branch already implemented the first KPI dashboard foundation:

- `kpi_metrics`, `kpi_cards`, and `kpi_datapoints` in `packages/db/src/schema.ts`.
- A provider registry in `apps/web/lib/kpis/providers/`.
- Concrete providers for GitHub, Linear, and PostHog.
- `kpi_metrics.config` as provider-owned JSON, included in `config_hash` for dedupe.
- A refresh engine in `apps/web/lib/kpis/refresh.ts` that calls a provider, normalizes to `{ ts, value }[]`, and snapshots datapoints.
- An add-card dialog driven by `KpiCatalogEntry[]`.

That is a strong base. The weak point is that `KpiCatalogEntry` is currently static and each metric's executable logic lives in TypeScript branches inside provider code. This handles "Open PRs" well, but not long-tail founder questions.

### Open Questions

- Should we run arbitrary AI-generated TypeScript/JavaScript for user metrics?
- Can we get most of the flexibility by generating validated data specs instead of executable code?
- What is the smallest implementation that proves the direction without destabilizing the existing KPI work?
- How should a metric like "PRs merged by Alice" be represented: a new built-in, a parameterized built-in, or a general GitHub search-count capability?

## System Architecture

### Related Components

**KPI provider contract**: `apps/web/lib/kpis/types.ts` defines `KpiProvider`, `KpiCatalogEntry`, `fetchMetric`, time ranges, and bucketing helpers. Downstream code already expects providers to normalize arbitrary source APIs into datapoints.

**Metric persistence**: `packages/db/src/schema.ts` stores `provider`, `metric_key`, `config`, `config_hash`, `metric_type`, `unit`, label, refresh cadence, refresh status, and datapoints. The JSON config column is the important extension seam: we can store a generated or user-authored metric spec without another migration.

**Creation path**: `apps/web/lib/kpis/actions.ts:createKpiCard` currently resolves provider + entry, resolves provider config, hashes config, creates or reuses `kpi_metrics`, refreshes the metric, and creates the card.

**Refresh path**: `apps/web/lib/kpis/refresh.ts:refreshKpiMetricNow` does not care whether the metric was prebuilt or user-authored; it only needs provider, key, config, and fetch results.

**UI path**: `apps/web/components/kpis/AddKpiDialog.tsx` renders catalog entries generically, but has no notion of catalog-driven config fields yet.

**Credential boundaries**: GitHub uses installation tokens from the existing work integration. Linear/PostHog use encrypted MCP OAuth credentials directly against provider APIs. Any flexible metric layer must preserve these workspace-scoped credentials and must not expose raw tokens to generated code.

### Data Flow

The current data flow remains right:

```text
metric spec/config -> deterministic provider executor -> normalized datapoints -> Postgres snapshots -> Electric/UI
```

The proposed change is at the metric spec/config layer:

```text
user prompt or form input
  -> AI-authored JSON spec (future)
  -> schema validation + provider allowlist
  -> deterministic executor owned by OpenCompany
  -> existing refresh pipeline
```

This avoids arbitrary runtime code execution while still letting the long tail live in data.

### Constraints

- Arbitrary generated JS inside the Next.js web app is not an acceptable trust boundary. Node's own documentation states that `node:vm` is not a security mechanism and should not be used for untrusted code: https://nodejs.org/api/vm.html.
- Real sandboxed generated-code execution is possible, but it is an infrastructure decision. E2B, Cloudflare Sandbox, and Deno Sandbox all position themselves around isolated execution for generated/untrusted code, with resource and network controls:
  - https://e2b.dev/docs
  - https://developers.cloudflare.com/sandbox/
  - https://docs.deno.com/runtime/fundamentals/security/
- For this product surface, we do not need executable code for the first flexible KPI layer. A JSON metric spec plus deterministic provider executors covers a large share of founder questions and avoids introducing a new sandbox vendor, worker runtime, or secret-boundary model.
- Provider APIs impose real query limits. GitHub GraphQL installation tokens have per-installation point budgets and secondary limits: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api. PostHog Query API has project-level limits and specifically warns that custom query performance is the caller's burden: https://posthog.com/docs/api/queries.
- The branch already has a migration and snapshot store. Prefer a no-migration extension unless the product contract truly needs new persistence.
- AI output must be treated as untrusted external input. OpenAI Structured Outputs can constrain a model to JSON schema, but validation still belongs at our boundary: https://developers.openai.com/api/docs/guides/structured-outputs.

## Prior Art

**Grafana** normalizes many data sources into a common response frame. Its plugin docs explicitly separate "define your response structure" from provider-specific query logic: https://grafana.com/developers/plugin-tools/tutorials/build-a-data-source-plugin. This supports our existing `fetchMetric -> datapoints` abstraction.

**Metabase** provides a useful middle ground between prebuilt metrics and arbitrary code. Custom expressions create filters, columns, and summaries from known functions/operators; saved metrics have a data source and formula and can be reused later:

- https://www.metabase.com/docs/latest/questions/query-builder/expressions
- https://www.metabase.com/docs/latest/data-modeling/metrics

This points to "validated expression/spec" over "raw generated code".

**Grafana transformations** allow calculated fields after querying, but within a known transformation catalog: https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/transform-data/. This is another example of flexible user intent expressed through constrained primitives.

**Databox** markets custom/calculated metrics as the path for business-specific KPIs: https://databox.com/custom-metrics. This validates the product need: prebuilt catalogs are onboarding, custom metrics are where companies express their actual business.

**GitHub search** is already a powerful deterministic primitive for the example metric. GitHub's issue/PR search supports author filters and merged PR filters such as `author:` and `is:merged`: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests.

## Recommendation

Do not implement arbitrary on-the-fly code execution in this branch.

Do implement the foundation for AI-authored metric specs:

- Extend catalog entries with optional typed config fields.
- Let `createKpiCard` accept and validate config.
- Add a generic GitHub "Pull request search count" metric whose config stores search filters.
- Execute that spec through our own GitHub provider code and existing snapshot pipeline.

This gives users an immediate way to create "PRs merged by a given person" while creating the exact seam an AI agent can target later: generate a small JSON config, validate it, then run deterministic code we own.

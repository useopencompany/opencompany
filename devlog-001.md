# Devlog: KPIs — Company Metrics Control Plane (v1)

**Date:** 2026-06-12
**Implementing:** plan.md

## What Was Done

Full v1 of the KPIs board, all 8 plan steps:

- 3 tables (`kpi_metrics` / `kpi_cards` / `kpi_datapoints`) + migration `drizzle/0057_perpetual_christian_walker.sql`
- Electric sync for all three (cards writable with optimistic update/delete; metrics/datapoints read-only)
- `KpiProvider` contract + registry with GitHub (App installation token → GraphQL aliased totalCounts), Linear (MCP OAuth token → GraphQL paginated day buckets), PostHog (MCP OAuth token → Query API TrendsQuery `weekly_active`)
- Pure `summarizeKpi` presentation math + 15 unit tests
- Refresh pipeline: claim-based Inngest sweep (`*/5 * * * *`), inline first fetch on create, throttled refresh-now, orphan-metric GC
- `/company/kpis` page + sidebar tab + `KpisView`/`KpiCardItem`/`AddKpiDialog` + shadcn-style `chart.tsx` on recharts@3.8.1

Static verification all green: typecheck, eslint (0 errors), biome, 701 web + 533 runner tests, production build emits `ƒ /company/kpis`.

## Tricky Parts

- **Heterogeneous provider registry typing.** `KpiProvider<TConnection>` providers can't live in one array without erasure (param contravariance). Solved with `AnyKpiProvider = KpiProvider<unknown>` and one documented cast in the registry — sound because a connection only round-trips through its own provider.
- **`react-hooks/purity` rejects `Date.now()` in render.** Replaced with a `useNowMinute()` hook (state + 60s interval), which also fixes "Updated 4m ago" and trailing windows going stale on long-open tabs. Same rule family forced the AddKpiDialog reset-on-open effect into conditional mounting (`{open && <AddKpiDialog/>}`), which is cleaner anyway.
- **MCP OAuth payload shape.** Tokens live at `payload.tokens.access_token` (SDK `OAuthTokens`), not `payload.bearerToken` — except Linear's legacy `bearer_token` credential kind. `lib/mcp/access-token.ts` handles both.
- **Event-metric healing.** Linear day buckets are emitted zero-filled across the whole fetched window (not just non-zero days) so deleted/backdated issues correct on the next refresh — upsert on `(metric_id, ts)` rewrites stale buckets.

## Decisions Made

- PostHog region (us/eu) + project id are discovered once at metric creation via `resolveConfig` and pinned in `kpi_metrics.config` — fetches never guess.
- `current` metrics snapshot on hour buckets (latest-wins upsert) to bound growth at ≤24 points/day; events/bucketed on UTC day buckets.
- Failed refreshes still advance `next_refresh_at` (no hot-looping); errors land on the metric row and surface as a card tooltip.
- 1-day range on event metrics reads as "Today" (calendar day, not rolling 24h) — storage is day-bucketed; labeled accordingly in the UI.
- Card creation is a plain server action (not a collection optimistic insert) because the metric id is server-generated; updates/deletes are optimistic through the collection.

## Deviations from Plan

- **Step 1 spike never ran**: this Conductor worktree has no `.env`/database, so token viability couldn't be tested here. Louis explicitly accepted MCP-direct with no fallback path; a bad token now surfaces as the card's error state rather than a connect-time failure.
- No other deviations — implementation follows the plan's design 1:1.

## Next Steps

- `bun run db:migrate` in the dev environment (migration 0057 pending).
- Browser click-through: add one card per provider, verify deltas/range switch/refresh/delete/empty state/dark mode.
- Watch the first Linear/PostHog refresh for token acceptance by the plain APIs.
- Later (out of v1 scope, from plan Non-Goals): drag-reorder, goal lines, custom metrics, webhook freshness, retention job.

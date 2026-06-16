# Code Review

**Reviewer:** AI
**Date:** 2026-06-12
**Reviewing:** Uncommitted KPIs feature — `packages/db/src/schema.ts`, `drizzle/0057_*`, `apps/web/lib/kpis/**`, `apps/web/lib/mcp/access-token.ts`, `apps/web/lib/collections/{index,types}.ts`, `apps/web/app/api/electric/v1/shape/route.ts`, `apps/web/lib/inngest/functions.ts`, `apps/web/components/kpis/**`, `apps/web/components/ui/chart.tsx`, `apps/web/app/company/kpis/page.tsx`, `apps/web/components/Sidebar.tsx`

## Summary

The implementation matches the approved plan 1:1 and follows house patterns faithfully (workspace-scoped schema with checks, Electric auth-proxy shapes, optimistic collections returning txids, claim-based sweeps, hydration-gated live views). Input validation exists at every boundary (server actions validate against the registry; provider responses are shape-checked before storage; GraphQL identifiers are JSON-escaped). All static verification is green. The remaining risk is concentrated in one place the worktree cannot test: whether the MCP-issued OAuth tokens are accepted by Linear/PostHog's plain APIs at runtime — explicitly accepted by the requester, and it fails visibly (card error tooltip) rather than silently.

## What Works Well

- Metric/card split with find-or-create + dedup hash, inline first fetch, GC-on-last-delete, and an orphan backstop in the sweep — the polling workload is provably "exactly what's on boards."
- Refresh failures are states, not exceptions: bookkeeping always advances `next_refresh_at`, errors truncate to 500 chars, one bad provider can't stall the sweep, and stale claims self-heal after 10 minutes.
- `summarizeKpi` is pure, runtime-agnostic (epoch ms), and the 15 tests cover the genuinely fiddly parts (partial-history baselines, zero-fill, future buckets, percent-vs-zero).
- Atomicity in the right places: datapoint upsert + bookkeeping in one batch; card delete + conditional metric GC in one transaction where `NOT EXISTS` sees the delete.

## Issues

### High
- None found.

### Medium
- [ ] **No OAuth token refresh on the direct-API path.** `lib/mcp/access-token.ts` reads the stored `access_token`; if a provider issues expiring tokens (PostHog possibly; Linear typically not), refreshes only happen when the runner's MCP client performs its OAuth dance. Until then the card shows "Last refresh failed (401)". Acceptable v1 behavior per the no-fallback decision, but worth a follow-up that checks `expiresAt` and surfaces "Reconnect PostHog in Settings" instead of a raw status code.
- [ ] **No datapoint retention.** `current` metrics accrue ≤24 rows/day/metric forever, and the `kpi_datapoints` shape syncs all of it to every client on the KPIs page. Fine for months at founder scale; needs a retention sweep (or a `ts > now()-90d`-style cap at projection time) before this is "hundreds of integrations" real. Consciously deferred in plan Non-Goals — re-flagging so it doesn't get lost.
- [ ] **Provider response-shape assumptions are unverified at runtime** (PostHog `results[0].{data,days}`, Linear `issues.pageInfo`). Both are validated defensively and fail into the error state rather than corrupt data, but the first browser test should exercise all three providers.

### Low
- [ ] `KpisViewContent` remounts when the hydration gate flips static→live, resetting transient state (`addOpen`). Window is milliseconds; only matters if a user opens the dialog instantly.
- [ ] Linear pagination caps at 2,000 issues per fetch window; day counts beyond that truncate silently (a comment documents the trade-off). A busy workspace's 90-day window could clip; the 7-day default won't.
- [ ] `providerLabel()` in `KpiCardItem` duplicates labels that already live on the registry (server-side). Harmless now; if providers multiply, thread the label through `KpiMetricPayload` instead.
- [ ] The first (oldest) day bucket of an event fetch is partial (rolling 90d cutoff) but always falls outside the largest display window, so it never renders — invariant worth keeping in mind if `KPI_FETCH_WINDOW_DAYS` and the max range ever equalize... they are equal (90/90): `windowStart = dayStart(now) - 89d` vs bucket0 at `day(now - 90d)` keeps it excluded by one day. Tight but correct.

## Recommendation
[x] Ready for human review
[ ] Needs revision (see issues above)

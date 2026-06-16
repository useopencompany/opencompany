# Plan: KPIs — Company Metrics Control Plane

**Status:** Approved
**Author:** Claude (for Louis)
**Created:** 2026-06-12

## Summary

Add a **KPIs** tab to the company workspace where users click together a dashboard of metric cards sourced from their existing integrations. Foundation: a Grafana-style `KpiProvider` contract (catalog + fetch → uniform datapoints) over the existing credential infrastructure, an Inngest-scheduled poll pipeline that snapshots values into a Postgres time-series table, Electric-synced cards for live updates, and shadcn charts (number / bar / line, per-card time horizon). Launch providers: GitHub (open PRs), Linear (new issues), PostHog (weekly active users).

## Motivation

Founders check 6 tools to answer "how are we doing?" — see `research.md` use cases (Monday pulse, ship-week watch, investor-update prep, something-feels-off check). The common thread: the value is never the live number alone, it's the number **in time context** (trend, delta). That requires snapshotting from day one and a provider abstraction that scales to hundreds of integrations.

## Goals

- One `/company/kpis` board per workspace; cards added from a prebuilt per-provider metric catalog in a couple of clicks.
- Cards: big number + delta vs previous period, optional bar/line chart, per-card time horizon (1d / 7d / 30d / 90d), "updated Xm ago," manual refresh.
- History accumulates automatically (snapshot store) so trends/deltas get richer the longer it runs.
- Provider layer that a new integration can join by implementing one small interface + catalog entries — no schema or UI changes.
- Live-updating cards via the house Electric pattern; instant optimistic add/remove.

## Non-Goals (v1)

- Multiple dashboards per workspace (schema leaves room; UI is one board).
- Custom/user-defined metrics (HogQL editor, formula metrics) — catalog-only for v1.
- Webhook-based freshness, drag-and-drop reordering, goal lines/targets, sharing/TV mode.
- Storage rollups/partitioning/retention jobs (volumes don't justify it yet; documented in research).
- Stripe MRR (Stripe is our billing, not a customer integration yet).
- Plan-gated refresh frequency.

## Technical Design

### Entity model

```
workspace ─┬─ kpi_metrics (provider + catalog key + config; polling unit; refresh bookkeeping)
           │      └─ kpi_datapoints (metric_id, ts, value — append-only snapshots/buckets)
           └─ kpi_cards (metric ref + viz type + time horizon + position — display unit)
```

Metric ≠ card: two cards showing the same metric at different horizons share one metric → one poll, one datapoint stream. This is the Databox/Klipfolio/Grafana split and the core "platform, not feature" decision.

### Schema (packages/db/src/schema.ts)

```ts
kpi_metrics:
  id text PK ("kpm_" + uuid), workspace_id FK cascade,
  provider text ("github" | "linear" | "posthog" | ...),
  metric_key text (catalog key, e.g. "github.open_prs"),
  config jsonb (provider params, e.g. { projectId } — {} for v1 defaults),
  config_hash text (stable hash for dedup),
  metric_type text ("current" | "event" | "bucketed"),
  unit text, label text,
  refresh_interval_minutes integer (default per catalog entry, floor 15),
  next_refresh_at timestamptz, last_refreshed_at timestamptz,
  last_refresh_status text ("ok" | "refreshing" | "error" | null), last_refresh_error text,
  created_at/updated_at
  unique (workspace_id, provider, metric_key, config_hash); index (next_refresh_at)

kpi_cards:
  id text PK ("kpc_" + uuid), workspace_id FK cascade, metric_id FK cascade,
  title text (defaults to catalog label), viz text ("number" | "bar" | "line"),
  time_range_days integer (1 | 7 | 30 | 90), position integer,
  created_by_user_id FK set null, created_at/updated_at
  index (workspace_id, position)

kpi_datapoints:
  id serial PK, workspace_id FK cascade (denormalized for Electric shape scoping),
  metric_id FK cascade, ts timestamptz, value double precision, created_at
  unique (metric_id, ts); index (workspace_id)
```

Bucketing by metric type (computed by fetchers, enforced by upsert on `(metric_id, ts)`):
- **current** (open PRs): snapshot truncated to the hour → upsert latest-wins; bounded at ≤24 points/day.
- **bucketed** (PostHog WAU daily trend): provider's day buckets upserted by bucket — re-fetch heals/backfills.
- **event** (Linear issues created): counted into day buckets from the provider's timestamped entities; re-fetchable.

### Provider contract (apps/web/lib/kpis/providers/)

```ts
type KpiDatapoint = { ts: Date; value: number };

type KpiCatalogEntry = {
  key: string;                    // "github.open_prs"
  label: string; description: string;
  metricType: "current" | "event" | "bucketed";
  unit: "count" | "users";
  defaultViz: "number" | "bar" | "line";
  defaultTimeRangeDays: 1 | 7 | 30 | 90;
  refreshIntervalMinutes: number; // per-entry floor
};

type KpiProvider = {
  id: string; label: string;
  catalog: KpiCatalogEntry[];
  getConnection(db, workspaceId): Promise<KpiConnection | null>; // null = not connected
  fetchMetric(connection, entry, config, range): Promise<KpiDatapoint[]>;
};
```

Registry in `providers/index.ts`. **Everything downstream (pipeline, cards, picker) sees only this interface** — normalization on the response shape, never the query shape (Grafana's seam). A future `packages/integrations` connector package can absorb these fetchers without schema churn.

Launch providers:
- **github.ts** — `catalog: [open_prs (current), merged_prs (event, stretch)]`. Connection = existing GitHub App integration; mint installation token via `lib/integrations/github.ts`. Fetch: one GraphQL request with aliased `repository(...){ pullRequests(states: OPEN){ totalCount } }` per connected repo (from `workspace_integration_resources`), summed. ~1 point per repo against a 5,000+/h per-installation budget.
- **linear.ts** — `catalog: [new_issues (event)]`. Connection = decrypted OAuth token from `workspace_mcp_credentials` (serverId linear). Fetch: `api.linear.app/graphql` `issues(filter:{ createdAt:{ gt: <range start ISO> }})` paginated (cap ~10 pages), counted into day buckets.
- **posthog.ts** — `catalog: [weekly_active_users (bucketed)]`. Connection = decrypted OAuth token from `workspace_mcp_credentials` (serverId posthog) + projectId (auto-discover via `GET /api/projects/`, persist in metric config). Fetch: `POST /api/projects/:id/query` TrendsQuery `math: "weekly_active"`, interval day → day buckets.

**Note (decided):** Linear/PostHog tokens issued through the MCP OAuth flows are used directly against the plain APIs — no api-key fallback path; clean single implementation (Louis). The spike step just confirms scopes early so any issue surfaces before UI work.

### Refresh pipeline (pull, snapshot-on-sync)

- **Cron sweep** — Inngest function (house pattern, `lib/inngest/functions.ts`), `*/5 * * * *`: claim due metrics via `UPDATE ... SET last_refresh_status='refreshing' WHERE next_refresh_at <= now() AND status IS DISTINCT FROM 'refreshing' RETURNING ...` (claim-style, no double-run), group by (workspace, provider) so shared connections batch, fetch, upsert datapoints (`db.batch`, neon-http), then set `last_refreshed_at`, `next_refresh_at = now() + interval`, status ok/error + message. Per-metric failures isolate (one bad provider doesn't block the sweep).
- **First fetch inline** — creating a card find-or-creates the metric and fetches immediately in the server action, so a new card renders with data, not a spinner-until-cron.
- **Refresh now** — server action per card; throttled (skip if `last_refreshed_at` < 60s ago); same fetch path.
- **Only placed metrics poll** — metrics exist only while ≥1 card references them; deleting the last card deletes the metric (cascades datapoints). The Databox cost lever.

### Client sync & writes

- Electric shapes for `kpi_cards`, `kpi_metrics`, `kpi_datapoints` in `SHAPE_SCOPES` (`app/api/electric/v1/shape/route.ts`), all `workspace_id = $1`.
- Row types in `lib/collections/types.ts`; collections in `lib/collections/index.ts`. `kpi_cards` gets optimistic `onInsert/onUpdate/onDelete` → server actions with `batchWithTxid()`; metrics/datapoints are read-only collections (server-written).
- Page follows the hydration-gate convention: server component fetches initial cards+metrics+datapoints via Drizzle; `<KpisView initial=...>` renders static until hydrated, then a `KpisViewLive` subcomponent subscribes via `useLiveQuery`.

### UI

- **Sidebar** — `NavItem href="/company/kpis" icon={ChartNoAxesColumn} label="KPIs"` in `components/Sidebar.tsx` primary nav.
- **Page** — `app/company/kpis/page.tsx` (server fetch) → `components/kpis/KpisView.tsx`: responsive card grid (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`), header with "Add KPI" button. Empty state: friendly explainer + provider logos + Add KPI CTA (links to `/company/settings` for unconnected providers).
- **KpiCard** — label + provider mark, headline value (latest/summed per metric type), delta chip vs previous equal-length period (↑↓ + %, success/danger tokens), chart area (line = area chart for bucketed/current trends; bar = per-day bars for event metrics; number = large value, sparkline when ≥2 points), footer "Updated 4m ago" + hover actions (refresh, time-range select, delete). Error state: subtle warning icon + tooltip with `last_refresh_error`.
- **Charts** — copy shadcn `chart.tsx` (ChartContainer/ChartTooltip/ChartConfig) into `apps/web/components/ui/chart.tsx`, add `recharts` to `apps/web`; map chart CSS vars onto existing design tokens (`--color-accent`, `--color-ink`, etc.). Follow https://ui.shadcn.com/charts/bar shapes for the bar/line configs.
- **Add KPI dialog** — house dialog pattern (`FeedbackDialog`-style overlay): step 1 pick provider (connected → catalog; unconnected → "Connect in Settings" link), step 2 pick catalog metric (label + description + default viz badge), step 3 (inline) title/viz/time-range pre-filled from catalog defaults → create.
- **Summarize logic** — pure `lib/kpis/summarize.ts`: `(metricType, points, rangeDays) → { headline, delta, series }`; current → latest value, delta vs point nearest range start; event → sum over range vs previous window; bucketed → latest complete bucket (WAU) with series over range. Unit-tested (the only non-trivial pure logic).

## Implementation Approach

Ordered steps; each lands typecheck-clean. Progress tracked in **Progress** below as work proceeds.

1. **Spike: token viability** — script-test stored Linear/PostHog MCP OAuth tokens against Linear GraphQL + PostHog Query API on the dev workspace. Decides whether step 4 includes the api-key fallback path. (Timebox; do not block schema work.)
2. **Schema + migration** — add 3 tables to `packages/db/src/schema.ts`, `bun run db:generate`, `bun run db:migrate` locally (Neon branch may need recreating if expired). Mind journal `when` ordering.
3. **Electric plumbing** — row types, `SHAPE_SCOPES` entries, collections (cards writable, metrics/datapoints read-only).
4. **Provider layer** — `lib/kpis/types.ts` (contract), `providers/{github,linear,posthog}.ts`, registry, credential helpers (decrypt MCP/integration credentials server-side; reuse existing crypto helpers). Validate external responses at the boundary.
5. **Summarize helper + unit tests** — `lib/kpis/summarize.ts` + `summarize.test.ts`.
6. **Server actions + pipeline** — `lib/kpis/actions.ts`: `createKpiCard` (find-or-create metric by config hash, inline first fetch, txid), `updateKpiCard` (title/viz/range), `deleteKpiCard` (GC orphan metric), `refreshKpiCard` (throttled). Inngest `sweepKpiRefresh` cron in `lib/inngest/functions.ts` with claim-based selection.
7. **UI** — sidebar NavItem; `app/company/kpis/page.tsx`; `components/kpis/` (KpisView + hydration gate, KpiCard, AddKpiDialog, charts); `components/ui/chart.tsx` + `recharts` dep; loading/empty/error states.
8. **Verify + polish** — typecheck/lint/test; click through in the running dev server: connect-state, add each provider card, deltas, time-range switch, refresh now, delete, empty state. Update `docs/architecture.md` (one section) — no new env vars expected.

Key files touched: `packages/db/src/schema.ts`, `drizzle/*`, `apps/web/lib/collections/{index,types}.ts`, `apps/web/app/api/electric/v1/shape/route.ts`, `apps/web/lib/kpis/**` (new), `apps/web/lib/inngest/functions.ts`, `apps/web/components/Sidebar.tsx`, `apps/web/app/company/kpis/page.tsx` (new), `apps/web/components/kpis/**` (new), `apps/web/components/ui/chart.tsx` (new), `apps/web/package.json`.

## Alternatives Considered

- **Fetch-on-view (no storage)** — always fresh, zero storage; rejected: org-shared rate limits melt with concurrent viewers, and point-in-time aggregates (WAU, open PRs) are unrecoverable — no history, no deltas, no investor-update use case. Research §3.
- **Webhook/event-driven ingestion** — PostHog has no aggregate webhooks; GitHub/Linear webhooks deliver events, not counts (state replay required). Not generalizable across hundreds of providers. Poll baseline now; webhooks later as freshness boost on the same store.
- **Invoke MCP tools for fetching** — credentials exist, but MCP tools are agent-shaped (web has no MCP client; responses are prose-ish tool payloads, not typed series). Direct provider APIs with the same stored tokens are simpler and typed. MCP remains the agent-facing surface.
- **Card-embeds-metric (no kpi_metrics table)** — fewer moving parts; rejected: duplicate polling/storage when one metric backs several cards, and no clean attachment point for refresh bookkeeping. The metric/card split is the entity model every prior-art product converged on.
- **Tremor / raw Recharts** — superseded by Louis's call: shadcn charts (thin Recharts wrappers, CSS-var theming onto existing tokens, no design-system adoption).
- **Build in `packages/integrations` now** — that package is a decided direction on another branch, not landed here; building against it would couple to unmerged work. Narrow `KpiProvider` interface keeps the later move mechanical.
- **Timescale / partitions / rollups** — IoT-scale solutions; at ≤24 points/metric/day plain Postgres with a composite unique index is the right call (research §4).

## Progress

_Updated as implementation proceeds._

- [~] 1. Spike: Linear/PostHog token viability — **deviation:** this worktree has no `.env`/DB (Conductor workspace; dev env lives elsewhere), so the spike could not run locally. Tokens are wired per the decided MCP-direct path; first real verification happens in the running dev workspace (add a Linear/PostHog card and watch the metric's status).
- [x] 2. Schema + migration — 3 tables in `packages/db/src/schema.ts`, migration `drizzle/0057_perpetual_christian_walker.sql`. **`bun run db:migrate` still pending** (needs the dev env).
- [x] 3. Electric plumbing — row types (`lib/collections/types.ts`), 3 shapes (`app/api/electric/v1/shape/route.ts`), collections (`lib/collections/index.ts`; cards writable w/ optimistic update+delete, metrics/datapoints read-only).
- [x] 4. Provider layer — `lib/kpis/types.ts` (contract), `lib/kpis/providers/{github,linear,posthog}.ts` + registry, `lib/mcp/access-token.ts` (decrypt MCP OAuth token for direct API use). PostHog resolves region+project once at creation (`resolveConfig`).
- [x] 5. `lib/kpis/summarize.ts` + 15 unit tests (all passing).
- [x] 6. Pipeline — `lib/kpis/refresh.ts` (claim-based sweep, per-connection batching, orphan-metric GC, error isolation), `lib/kpis/actions.ts` (create w/ find-or-create metric + inline first fetch, update, delete w/ metric GC, throttled refresh-now), Inngest `sweepKpiMetricRefresh` (`*/5 * * * *`) registered.
- [x] 7. UI — Sidebar "KPIs" tab; `app/company/kpis/page.tsx` (server fetch + provider connection status); `components/kpis/{KpisView,KpiCardItem,AddKpiDialog}.tsx` (hydration-gated live view, number/bar/line cards w/ delta chips + freshness + error tooltip, catalog-driven 2-step add dialog); `components/ui/chart.tsx` (shadcn-style on recharts, design-token themed); `recharts@3.8.1` added.
- [x] 8. Static verification — typecheck ✓, lint ✓ (0 errors), biome format ✓, unit tests 701 web + 533 runner ✓, production build ✓ (`/company/kpis` route emitted).

### Remaining (needs the dev environment)
- [ ] `bun run db:migrate` against the dev Neon branch.
- [ ] Browser click-through: add a card per provider, deltas, range switch, refresh now, delete, empty state, dark mode.
- [ ] Confirm Linear/PostHog MCP OAuth tokens are accepted by the plain APIs (card error state will say if not).

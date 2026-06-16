# Research: KPIs — One Control Plane for Company Metrics

**Requester:** Louis
**Date:** 2026-06-12

## Requirements

### Original Request

Add a new **KPIs** tab to the company workspace (left sidebar). Users click together KPI dashboards from the things they integrate. Examples:

- Weekly active users from PostHog (number)
- Open PRs from GitHub (number or chart)
- New issues in the last 24h from Linear

One control plane for all KPIs across the company. The foundation must scale to **hundreds of integrations**. Cards are simple and nice: number, bar chart, or line chart, with a time horizon (last 7 days, etc.). UX bar: simple, intuitive, "as a founder I want one place to see everything."

### Context

- Stack: Turborepo + Bun, Next.js App Router (`apps/web`, Vercel), Bun runner (`apps/runner`, Render), Drizzle + Neon Postgres, Electric SQL client sync, Inngest for background jobs, WorkOS auth.
- Company surface lives under `/company/*` behind `companySurfaceEnabled`; sidebar nav in `apps/web/components/Sidebar.tsx`.
- Integrations already exist in two flavors: native OAuth integrations (GitHub, Gmail, Google Calendar → `workspace_integrations` + encrypted `workspace_integration_credentials`) and MCP servers (Linear, Slack, PostHog, Better Stack, Braintrust → `workspace_mcp_servers` + `workspace_mcp_credentials`).
- An `integration_events` ledger + `packages/integrations` connector package is a *decided direction* on another branch but is **not on this branch** — nothing to build on yet, but the KPI foundation should not collide with it.

### Open Questions

- Should KPI fetching call MCP servers (generic, but tool-shaped responses are awkward for typed metrics) or provider APIs directly with the same stored credentials? → resolved in Prior Art / Constraints below: **direct provider APIs with stored credentials; MCP stays the agent-facing surface.**
- Stripe MRR is an obvious 4th metric but Stripe is only integrated for billing of *our* product, not as a customer integration. Out of scope for v1.
- Multiple dashboards per workspace vs one canonical board? (Product call; v1 can be one board with the schema allowing many.)

## System Architecture

### Related Components

**Company workspace UI** — `apps/web/app/company/{layout,page}.tsx`; sidebar nav items are `<NavItem href icon label active>` entries in `apps/web/components/Sidebar.tsx` (~line 488). Adding a tab = new route `app/company/kpis/page.tsx` + one NavItem. Existing pages to pattern-match: `AgentsView.tsx` (server-fetch + Electric live list), `app/company/settings/page.tsx` (server fetch), `FeedbackDialog.tsx` (modal + `useActionState` server-action form).

**UI kit** — Radix primitives + custom Tailwind tokens (`--color-canvas/sidebar/ink/surface/accent/...`), lucide icons, `apps/web/components/ui/*` + `packages/ui`. **No chart library anywhere in the repo yet.**

**Data fetch patterns** — Server Components fetch via Drizzle (`getDb()` + `currentWorkspace()`); real-time lists use Electric collections (`apps/web/lib/collections/index.ts`) + `useLiveQuery` **gated on a hydration flag** (SSR renders server data; live subcomponent mounts after hydration — established convention, violating it causes stuck-loading bugs). Writes: server actions using `batchWithTxid()` (neon-http has no interactive transactions; `db.batch([...])` + `pg_current_xact_id()` for Electric reconciliation). Electric shapes are defined server-side in `apps/web/app/api/electric/v1/shape/route.ts` (`SHAPE_SCOPES`, workspace-scoped WHERE clauses).

**Integrations & credentials**
- Native: `workspace_integrations` / `workspace_integration_resources` / `workspace_integration_credentials` (AES-256-GCM via `@opencompany/crypto`, AAD-bound to workspace+integration+provider+kind, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`). GitHub is a GitHub App: installation tokens minted per call (`POST /app/installations/{id}/access_tokens`, 1h TTL) — `apps/web/lib/integrations/github.ts`.
- MCP: `workspace_mcp_servers` / `workspace_mcp_credentials` for Linear, Slack, **PostHog**, Better Stack, Braintrust — OAuth tokens stored with the same encryption contract. MCP tools today are only invoked **inside the runner** during agent turns; there is no web-server-side MCP invocation path. But the **OAuth tokens themselves are usable for direct API calls** (Linear GraphQL, PostHog Query API) from server code.
- All credentials are **workspace-scoped**, not per-user.

**Background jobs** — Inngest functions in `apps/web/lib/inngest/functions.ts`: cron sweepers (every-minute recall indexer, sync-outbox sweeper, schedule runner, etc.) + event-triggered functions with per-workspace concurrency keys. The `workspace_sync_jobs` outbox (status/attempts/nextRunAt/lastError, unique on workspace+path, lease-based claim) is the house pattern for durable work queues. No Vercel crons; everything via Inngest.

**Schema conventions** — `packages/db/src/schema.ts` (single file); text PKs with prefixes (`wks_`, `usr_`) or custom ids; `workspace_id` FK with cascade on every tenant table; `createdAt/updatedAt timestamptz defaultNow`; scoped unique indexes. Any schema change ⇒ `bun run db:generate` migration; beware the Drizzle journal `when` rebase-skip issue.

### Data Flow

Proposed flow shape that fits the existing system (full design in plan.md):

```
provider API ──(scheduled poll: Inngest cron → fetcher)──▶ kpi datapoints (Postgres)
                                                              │
client card ◀──(Electric live sync / server fetch)────────────┘
user "refresh" ──(server action → fetch + snapshot now)──▶ same path
```

Key facts forcing this shape:

1. **Push is not uniformly available.** PostHog exposes *no* webhook for computed aggregates (its "webhooks" are CDP destinations streaming raw events). GitHub/Linear webhooks exist but deliver *events*, not *counts* — reconstructing "open PRs" from an event stream means replaying state. Hundreds of integrations ⇒ **poll is the baseline; webhooks are a later freshness optimization** (cache invalidation), exactly what Geckoboard/Databox converge on (most sources poll at 5–15 min).
2. **Point-in-time aggregates cannot be backfilled.** "Open PRs right now" or "WAU right now" is gone if you don't store it — you cannot ask GitHub "how many PRs were open last Tuesday." So sparklines/deltas **require snapshotting on every sync** (Databox calls these "current metrics" and timestamps each sync to build the series itself). Bucketed series (PostHog daily trends) *can* be re-fetched and upserted per bucket.
3. **Rate limits are org-shared.** PostHog `/query`: 2,400/h **across the whole org's keys**; Linear: 5,000 req/h + complexity budget per user/app; GitHub App: 5,000+/h **per installation** (good multi-tenant shape). Fetch-on-view at card granularity would melt these with a few viewers; scheduled batch polling with stored results is mandatory.

### Constraints

- **No chart library installed.** Need one new dependency. **DECIDED (Louis): use shadcn/ui charts** (https://ui.shadcn.com/charts) — copy-paste `chart.tsx` (ChartContainer/ChartTooltip/ChartConfig) into `components/ui/`, `recharts` as the only new dependency. Theming is CSS-variable based, mapped onto existing design tokens; no broader shadcn adoption needed.
- **neon-http**: no transactions in web; use `db.batch`. Runner has a real pool if heavy fetch work ever moves there; for v1, Inngest functions run in the web app (Vercel Fluid, 300s default timeout — fine for polling a handful of providers).
- **MCP tokens are usable but MCP tools aren't** (web has no MCP client; tools are agent-shaped). Direct provider API calls using the stored OAuth token is the clean path: PostHog Query API (`POST /api/projects/:id/query`, HogQL or TrendsQuery), Linear GraphQL (filter comparators support relative durations like `{ createdAt: { gt: "-P1D" } }`), GitHub GraphQL (`pullRequests(states: OPEN) { totalCount }`, ~1 point).
- PostHog MCP OAuth token scope must cover Query Read — verify at implementation time; if not, fall back to a personal API key credential kind.
- Per-workspace fairness: polling must be batched **per connection, not per card** (5 PostHog cards on the same project = 1 query), and only poll metrics that are actually placed on a dashboard (Databox deactivates schedules for unused metrics — the cost lever).
- Don't collide with the future `integration_events`/`packages/integrations` direction: keep provider fetchers behind one narrow interface so they can later be relocated into `packages/integrations` connectors without schema churn.

## Prior Art

### Product prior art (Databox, Klipfolio, Geckoboard, Equals)

All converge on the same three separable entities — this is the foundation:

> **connection** (auth'd integration instance) → **metric definition** (provider + query params + metric type) → **card** (metric ref + viz config + time range)

plus a **prebuilt metric catalog per integration** as the onboarding path ("add a card" shows a picker of ready-made metrics: GitHub → Open PRs / Merged PRs / ...), with custom metrics as a later escape hatch.

**Databox's 4 metric types** (the most reusable idea found):
1. **current** — API returns only a live total (WAU, open PRs, followers). Series must be built by snapshotting each sync; no backfill possible.
2. **event** — computed by counting timestamped entities (new Linear issues); arbitrary re-aggregation possible.
3. **general/bucketed** — provider returns pre-summarized period values (PostHog daily trend rows); re-fetchable/backfillable per bucket.
4. **calculated** — derived as delta between consecutive snapshots of a current metric.

Encoding this type in the metric descriptor determines refresh/backfill/aggregation semantics per metric — it's the difference between a hack and a platform.

**Freshness model:** sync schedule attaches to a metric when first placed on a dashboard, detaches when removed (Databox); intervals are per-provider floors (Geckoboard: most 5–15 min; slow APIs 20 min–12 h; some realtime widgets 1 min within the same integration). Manual "refresh now" everywhere, bounded by rate budget. Plan-gated frequency is the standard monetization lever.

### Extensibility prior art (Grafana, Cube, dbt)

- **Grafana datasource plugin contract** is the proven hundreds-of-sources seam: each source implements `testDatasource()` + `query(request) → DataFrame[]`. The normalization trick is the **response shape** (uniform time/value frames), never the query shape (provider-specific). Cards/panels only understand frames. → For us: a TypeScript `KpiProvider` interface: `listCatalog()`, `fetchMetric(definition, range) → {ts, value}[]`, with the catalog shipping prebuilt metric descriptors per provider.
- **Cube**: metric definition is separate from requested grain — granularity/time-range is a query-time parameter, which makes card-level time-horizon switching free. Stale-while-revalidate refresh (`refreshKey`/`every`) formalizes the hybrid cache.
- **dbt MetricFlow**: metrics as declarative config compiled to provider queries — our metric definitions should be JSON data (provider, metricKey, params, unit, type), not imperative code paths.

### Storage prior art

Plain Postgres is unambiguous at this volume (hundreds of metrics × 1 point per 15–60 min ⇒ low thousands of rows/day/workspace): narrow append-only `(metric_id, ts, value)` with a unique `(metric_id, ts)` for idempotent upserts and a composite B-tree. Partitioning/BRIN/Timescale/rollups are IoT-scale concerns — explicitly deferred. Retention via periodic delete (or partition drops much later).

### Provider API cheat sheet (launch metrics)

| Provider | Metric | Call | Notes |
|---|---|---|---|
| PostHog | WAU (number + trend) | `POST /api/projects/:id/query` TrendsQuery `math: "weekly_active"` or HogQL `count(DISTINCT person_id)` | 2,400/h org-wide on `/query`; responses cached (`is_cached`); not an export mechanism — single-aggregate polls are fine |
| GitHub | Open PRs | GraphQL `pullRequests(states: OPEN) { totalCount }` per repo, or `search(type: ISSUE, query: "org:x is:pr is:open") { issueCount }` | App installation bucket 5,000+/h; totalCount-only ≈ 1 point |
| Linear | New issues last 24h | GraphQL `issues(filter: { createdAt: { gt: "-P1D" } })` | Relative ISO durations in filters; 5,000 req/h; verify count field vs pagination on live schema |

### Founder use cases (pressure tests)

1. **Monday-morning pulse** — one glance: WAU trend (7d line), MRR-proxy, open PRs, bugs filed last 24h. Validates: mixed providers on one board, deltas vs previous period, cards readable in <5s.
2. **Ship-week watch** — during a launch: signups today (1d horizon, fast refresh), error volume, support tickets. Validates: per-card time horizons, "refresh now," same metric usable at multiple horizons.
3. **Investor-update prep** — pull the monthly numbers without logging into 6 tools: WAU growth 90d, shipped PRs 30d bar chart. Validates: longer horizons need *history*, which only exists if we've been snapshotting — strongest argument for snapshot-from-day-one.
4. **Team accountability board** — eng: PR cycle metrics; product: activation; shared on a TV/standup. Validates: multiple dashboards per workspace eventually; clean read-only rendering.
5. **Something-feels-off check** — WAU dipped? Open the board, see the dip started Tuesday, correlate with deploys/issues. Validates: stored history at daily granularity, sparklines with real time axes, not just current values.

Common thread: the value is **never the live number alone — it's the number in time context** (trend, delta, comparison). The snapshot store *is* the product.

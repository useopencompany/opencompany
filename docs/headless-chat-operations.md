# Headless Chat operations

Ordinary web Chat uses the canonical Hono API under `/v1`, durable runner execution, semantic SSE,
and authorized Electric read models. This document covers the web rollout approved for issue
[#1165](https://github.com/useopencompany/opencompany-experimental/issues/1165). Expo/mobile and
macOS-native implementation and test work are owned by a later project; the existing macOS
compatibility route is intentionally unchanged.

## Service topology

```text
browser ---- direct /v1 + shared session ----> apps/api (Hono /v1) ----> Electric
  |
  +---- pages + auth setup -----------------> apps/web

  apps/runner ---- shared application services ----> Postgres (authority)
       |                                                ^
       +---- ticketed Claude MCP <---- E2B sandbox      |
       +---- Redis presentation deltas ----> apps/api --+
                                              | SSE
                                              +----> browser
```

- `apps/api` authenticates, derives the Actor/workspace, validates commands, writes Messages/Runs,
  serves durable state and SSE, and proxies fixed versioned Electric read models.
- `apps/runner` claims queued Runs directly from Postgres, creates Attempts, heartbeats fenced
  leases, runs the model loop, and transactionally projects Messages, semantic Events, approvals,
  billing usage, cancellation, partial results, and terminal state.
- Browser code calls the first-party `NEXT_PUBLIC_GOAT_API_ORIGIN` directly. Production uses
  `https://api.opencompany.chat`, with a secure WorkOS session cookie scoped to
  `opencompany.chat`. The API allows credentialed CORS only from the configured web origin and
  rejects cookie-authenticated mutations without an allowed `Origin`. This keeps Vercel out of SSE
  and Electric long-poll response paths; same-origin `/v1` remains the local/unconfigured fallback.
  Runner invokes shared application services in-process for actions and approvals, Brain capture,
  task/schedule/workflow/skill/wiki behavior, browser sessions, artifact publication, and terminal
  settlement. The queue claim establishes Attempt and lease authority; each application operation
  re-derives its actor, workspace, membership, and Run/turn authority from persisted state. No
  canonical or coding-agent capability call is served by `apps/web`. Claude Code reaches the
  runner's `/internal/goat/claude-actions` MCP endpoint with a signed v2
  session/Run/Attempt/lease capability; the runner rechecks persisted membership and live lease
  authority on every MCP request and tool operation. The sandbox never receives actor/workspace
  identifiers, provider credentials, or `RUNNER_INTERNAL_TOKEN`.
- Canonical Auto selection is part of the authenticated `POST /v1/messages` command. The API
  reuses an accepted idempotent command's model or an authorized Conversation's stored model before
  consulting the provider, and returns the concrete model in the accepted response. The browser no
  longer calls the web `/api/chat/model-route` preflight.
- Postgres is the authority and queue. `LISTEN/NOTIFY` only reduces latency. Redis carries optional
  five-minute, 1,024-entry-per-Run presentation replay and is not required for canonical execution
  or reconnect correctness.

## Local web slice

After the normal `bun run setup`, start all four local pieces with the workspace's Infisical dev
configuration:

```sh
bun run infisical:dev:headless-chat
```

This starts web, API (port 3001 by default), runner, and the local Stripe listener, and sets the
web-only cohort to canonical Chat. Use the normal local web URL. The API health and generated
contract are available through `/v1` proxying only for versioned routes; direct process checks are
`http://127.0.0.1:3001/healthz` and `http://127.0.0.1:3001/openapi.json`.

The services share the branch-isolated database. The API prefers `API_DATABASE_URL`, then
`RUNNER_DATABASE_URL`, then a direct form of `DATABASE_URL`. Electric read models require the
existing `ELECTRIC_URL` and server-only Electric credentials. Never expose or copy those values to
browser variables. When `REDIS_URL` is present in both API and runner environments, the runner
publishes approximately 50 ms presentation deltas while durable Message/Event projection remains
on a 500 ms cadence. Leaving it absent exercises the Postgres-only fallback.

## Failure and recovery

- Closing the browser or an SSE connection does not cancel a Run. Reconnect uses the last `v1:N`
  cursor, catches up from Postgres, and reads final Run/Message state. A separate optional `p1:`
  cursor replays only the bounded presentation window and is never sent as an SSE `id`.
- API restarts do not affect execution. The runner polls/claims from Postgres even if a wakeup is
  lost.
- Runner death stops its lease heartbeat. A later worker creates the next Attempt, reclaims the Run,
  and continues without changing Run identity or duplicating the user-visible Message.
- Cancellation and approval resolution are idempotent durable commands. Partial content is retained
  on interruption/failure.
- Redis startup failure, mid-stream failure, expiry, trimming, or API/runner restart may skip
  animation frames but cannot stop a Run. Attempt numbers fence recovered workers, offset ranges
  make repeated deltas idempotent, and the latest complete Message/Event precedes every terminal
  Run Event.
- Model-visible host operations fail closed if the turn is no longer running, workspace membership
  changed, Attempt/lease authority is stale, or the host contract is incompatible. The bounded
  browser-profile cleanup operation may re-derive the same host identity after terminal settlement
  so completion, failure, and cancellation cannot leak a profile session.

## Controlled presentation cadence

Run `REDIS_URL=<isolated-redis> bun run measure:chat-presentation` to drive 90 provider chunks at a
controlled 50 ms interval through the runner delta projector, a real Redis 7 Stream, Hono SSE, and
the shared protocol client. The provider timestamps are the equivalent legacy direct-stream
baseline. On 2026-08-11, an isolated local Docker Redis run produced:

| Path | Median interval | p95 interval | Range |
| --- | ---: | ---: | ---: |
| Legacy-equivalent provider → client | 51.9 ms | 52.8 ms | 50.1–53.3 ms |
| Runner → Redis → API SSE → protocol client | 45.0 ms | 69.1 ms | 41.7–71.2 ms |

The sample included all 90 deltas, with 13.3 ms median and 23.5 ms p95 provider-to-SSE delivery
latency. Durable Message/Event projection remains 500 ms and terminal ordering remains
Postgres-backed. This controlled result complements the prior full local product measurement: PR
#1172's 150 ms database throttle produced visible updates around 223–308 ms, compared with the
legacy path's approximately 50 ms cadence.

## Production rollout gate

Issue #1171 authorizes `@louismorgner` to operate the staged production activation. The separately
deployed Render service is named `opencompany-api`. API runtime values are owned by Infisical
`prod` `/api`; Redis is shared with `prod` `/runner`; web origin/flag values remain in `prod`
`/goat`; and release service IDs/origins remain in `prod` `/release`. Render's stable HTTPS URL is
the initial server-only API origin, so a custom subdomain is not required for activation.

Before setting `NEXT_PUBLIC_GOAT_HEADLESS_CHAT=true`, the operator must:

1. Add `apps/api` as a separately deployable production service and include its `/healthz` in the
   release SHA/health gate.
2. Provide its server-only database, WorkOS, Vercel AI Gateway, blob, Electric, Redis, and
   observability configuration through Infisical `prod` `/api`; configure the same `REDIS_URL` in
   `prod` `/runner`. Verify the runner's Render-provided `RENDER_EXTERNAL_URL` (or explicit
   `RUNNER_PUBLIC_URL`) is the HTTPS origin written into Claude sandbox MCP configuration.
3. Register `api.opencompany.chat` on the Render API service and point its DNS directly to Render.
   Configure web `NEXT_PUBLIC_GOAT_API_ORIGIN=https://api.opencompany.chat`, configure the API's
   exact credentialed browser-origin allowlist, and scope `WORKOS_COOKIE_DOMAIN` to
   `opencompany.chat` in both web and API runtimes. Retain server-only `GOAT_API_ORIGIN` only for
   the same-origin fallback and rollback diagnostics.
4. Deploy migration, runner, API, then web while `NEXT_PUBLIC_GOAT_HEADLESS_CHAT` is absent or false.
5. Smoke-test session auth and tenant isolation; create/upload/send; Auto routing; task creation;
   Brain read/text/attachment capture; integration and managed actions with approval; public and
   authenticated browser tools; cancellation; partial failure; worker recovery; terminal-cursor SSE
   reconnect; Electric reconciliation; archive/restore/pin/seen; and billing debit.
6. Set `NEXT_PUBLIC_GOAT_HEADLESS_CHAT=true`, deploy web, and repeat the web smoke set while watching
   correlated request/Run/Attempt logs and queue/event lag.

Direct-origin verification must show that `/healthz`, authenticated Run SSE, and Electric read
models are served by Render without Vercel response headers. Runner health must advertise
`capabilities.claudeActionsMcp=v2`. Verify a pre-existing browser session
is migrated to the shared cookie before its first cross-origin request, sign-out clears that shared
cookie, disallowed origins receive no credentialed CORS access, and cookie-authenticated mutations
from disallowed or missing origins are rejected. A rollback disables
`NEXT_PUBLIC_GOAT_HEADLESS_CHAT` and redeploys web; the API service and additive DNS record can stay
online.

The removed web execution routes are not a standby transport. Do not roll the runner back below the
runner-hosted Claude/in-process capability cutovers while a canonical Run may execute. An emergency
code rollback that needs those older transports must first redeploy the route-adapter revision of
web, then roll back API/browser Auto routing together, and only then roll back runner. Normal
rollback leaves the current API/runner deployed and disables `NEXT_PUBLIC_GOAT_HEADLESS_CHAT` for
new browser requests; already queued canonical Runs continue without web.

Record expected-SHA health output, the complete disabled/enabled smoke matrices, responsive-cadence
samples, a Redis-degraded fallback probe, and the real-traffic soak result on issues #1165 and #1171.
Do not treat a healthy process as activation evidence unless its release SHA matches the release.

## Rollback and compatibility

Set `NEXT_PUBLIC_GOAT_HEADLESS_CHAT=false` (or remove it) and redeploy web. New foreground requests
then use the isolated compatibility implementation in `apps/web/lib/legacy-chat-route.ts`; already
queued canonical Runs continue safely in the runner. Additive tables, Events, Attempts, Messages,
and projections remain and must not be dropped. Reverting runner/API code is optional only after
canonical Runs have settled or a compatible runner remains available.

The compatibility endpoint remains until the later native project migrates or separately proves
all surviving clients no longer use it, and after the agreed web production soak shows no unexplained
command, settlement, reconnect, recovery, or tenant-isolation regressions. Do not add new ordinary
Chat orchestration to that endpoint.

## Observability and exit evidence

API logs/spans correlate request IDs with Run IDs without logging prompts. Runner logs and durable
Events correlate Run/Attempt transitions, queue delay, claim/recovery, projection failures, and host
gateway cleanup. SSE emits validated sequence cursors; tests cover first connect, cursor reconnect,
approval continuation, and reconnect after the terminal cursor. Release evidence must include the
web, API, runner, DB repository/migration, core, protocol/OpenAPI drift, authorization/tenancy, and
secret-scan gates. Native suites are not part of this web phase.

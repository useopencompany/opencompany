# Chat operations

opencompany, Codex, and Claude Code use one authenticated `/v1` protocol, durable runner execution,
semantic SSE, and API-owned Electric read models. Postgres is the authority for accepted work;
Redis and notifications only reduce presentation latency.

## Service topology

```text
browser ---- typed /v1 commands + WorkOS session ----> apps/api ----> Postgres
  |                                                  |             ^
  +---- pages and browser-auth shell ----> apps/web  |             |
                                                     v             |
                                             SSE/read models       |
                                                                   |
apps/runner ---- fenced Run claims, Attempts, Events, settlement --+
       |
       +---- ticketed tools and engine sandboxes
```

- `apps/api` authenticates every public route, derives Actor/workspace scope, validates commands,
  persists Messages and Runs, serves semantic SSE, and exposes fixed authorized read models.
- `apps/runner` claims queued Runs, creates Attempts, heartbeats fenced leases, executes the selected
  engine, and settles Messages, Events, approvals, artifacts, usage, and state.
- `apps/web` renders the product and owns the WorkOS browser shell. It has no Chat persistence or
  execution path.

## Configuration

The browser uses `NEXT_PUBLIC_GOAT_API_ORIGIN`; Server Components use `GOAT_API_ORIGIN`. Production
browser traffic connects directly to the API with the shared secure WorkOS cookie.
`API_BROWSER_ORIGINS` must contain the exact production web origin. Required values are enforced by
`scripts/release-preflight.mjs` and belong to the owning Infisical runtime path.

## Release verification

After a Chat-affecting release:

1. Confirm web, API, and runner health checks report the expected SHA.
2. Send one opencompany Message and confirm the user Message, assistant Message, and terminal Run
   survive a reload.
3. Exercise a follow-up, cancellation, or approval when the change touches that command.
4. Confirm authorized Conversation, Message, Run, and Event state converges in the browser.
5. Exercise Codex or Claude Code when engine continuity, sandbox capabilities, or engine auth changed.
6. Check API and runner telemetry for authorization, idempotency, lease, and settlement failures.
7. Run `bun run boundary:check` and confirm the web boundary remains clean.

## Failure handling

- Never redispatch an accepted command merely because the browser stream disconnected. Read the
  Run, reconnect SSE from the last semantic Event ID, and let the durable Attempt settle.
- A dead worker loses its lease; another Attempt can reclaim the Run after expiry. Fence checks
  prevent the old Attempt from settling.
- Cancellation is an idempotent Run command. Conversation archive state is metadata and does not
  cancel active work.
- Fix authentication, CORS, worker, or read-model faults through the protected release flow. Do not
  add a web persistence path, second queue, or dual write.
- Database migrations are forward-only and additive. Do not drop or rewrite source or retained
  historical data during incident response.

The sessionless Task history protected by ADR 0002 remains read-only through its bounded
compatibility resources. It is not a Chat execution path.

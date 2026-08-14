# Headless Chat operations

Ordinary web Chat, Codex, and Claude Code use the authenticated canonical API, durable runner
execution, semantic SSE, and API-owned Electric read models. The rollback window was closed in
issue [#1203](https://github.com/useopencompany/opencompany-experimental/issues/1203); operations are
fix-forward.

## Service topology

```text
browser ---- typed /v1 commands + session ----> apps/api ----> Postgres/Electric
  |                                              ^                  |
  +---- pages and auth setup ----> apps/web      |                  |
                                                 |                  v
apps/runner ---- fenced Run execution -----------+------------> browser read models
       |
       +---- ticketed tools and engine sandboxes
```

- `apps/api` authenticates every public route, derives Actor/workspace scope, validates commands,
  persists Messages and Runs, serves SSE, and exposes fixed authorized read models.
- `apps/runner` claims queued Runs, creates Attempts, heartbeats fenced leases, executes the selected
  engine, and transactionally settles Messages, Events, approvals, artifacts, usage, and state.
- `apps/web` is the presentation and Server Component composition root. Its Chat readers and
  mutations use the typed first-party client; it has no Chat database or execution fallback.
- Postgres is authoritative. Notifications and Redis reduce latency but do not own execution.

## Configuration

The browser uses `NEXT_PUBLIC_GOAT_API_ORIGIN`; Server Components use `GOAT_API_ORIGIN`.
Production browser traffic connects directly to the API with the shared secure WorkOS cookie.
`API_BROWSER_ORIGINS` must include the production web origin.

Required values are validated by `scripts/release-preflight.mjs`. If a required API value is added,
mirror it to Infisical `prod` `/api` before merge or release preflight will stop deployment.

## Release verification

After a Chat-affecting deploy:

1. Confirm web, API, and runner health checks report the expected SHA.
2. Send one OpenCompany message and confirm the user Message, assistant Message, and terminal Run
   survive a reload.
3. Exercise one follow-up or cancel action when the change touches command handling.
4. Confirm an authenticated Conversation and Message read model updates in the browser.
5. Check API and runner error telemetry for authorization, idempotency, lease, and settlement
   failures.

Confirm retired `/api/chat`, bespoke engine Message routes, and the generic web Electric selector
remain absent. `bun run boundary:check` must report the permanent zero-import rule.

## Failure handling

- Do not route accepted canonical work into an older queue or reintroduce a first-party rollback
  adapter. Runs keep their IDs and original idempotency reservations.
- Fix authentication, CORS, worker, or read-model faults forward and deploy through the normal
  protected release workflow.
- A stalled browser stream does not imply lost work. Read the Run and durable Events, then reconnect
  SSE from the last semantic event ID.
- A dead worker loses its lease; another Attempt reclaims the Run after expiry. Fence checks prevent
  the old Attempt from settling.
- Database migrations are forward-only and additive. Never use an incident response to drop or
  rewrite source or retained historical data.

The sessionless historical Task read-only resources remain a separate ADR 0002 retention gate and
must not be removed as part of Chat operations. They do not provide a Chat execution fallback.

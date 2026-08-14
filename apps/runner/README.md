# Runner ownership

`apps/runner` owns durable execution and background work: Conversation/Task turns, schedules,
integration polling and flush, Brain ingestion/import, coding sandboxes, brokered model access,
dictation transport, and usage settlement. Postgres state and fenced claims own recovery; wakeups
only reduce latency.

## Dependency boundary

The runner may compose `@opencompany/core`, `@opencompany/db`, and reusable execution/provider
packages. It must not import from `apps/web` or `apps/api`, and it never calls the public API for
execution persistence. Browser-reachable transports require scoped capabilities; other control
routes require the internal runner token.

## Stable entry points

- `src/index.ts` — process composition, worker lifecycle, and graceful shutdown.
- `src/server.ts` — Fastify health, broker, capability, and internal-control routes.
- `src/db.ts` — direct pooled Postgres adapter.
- `/healthz` — local and deployment health contract.

Internal `/internal/goat/*` paths and retained physical schema `goat.*` rows are compatibility
contracts, not a second product name or public client API.

## Verify changes

```bash
bun --filter @opencompany/runner test
bun --filter @opencompany/runner typecheck
bun run smoke:local
```

Exercise the real durable path for worker changes when provider fixtures are available. Community
mode verifies process health with provider-backed workers intentionally disabled.

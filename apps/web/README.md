# Web ownership

`apps/web` owns the Next.js product presentation and authentication shell: App Router pages, Server
Component composition, optimistic browser state, WorkOS browser flows, static/health delivery, and
narrow same-origin relays that preserve public URLs. Product persistence, authorization, provider
ingress, and durable execution belong to the API or runner.

## Dependency boundary

The web client may depend on `@opencompany/protocol` and presentation-focused packages such as
`@opencompany/ui`. Product data must cross typed `/v1` resources or fixed API read models. Production
web code must not import `@opencompany/db`, Drizzle, API/runner internals, or invoke application-core
services directly. `bun run boundary:check` enforces the database half of this boundary.

## Stable entry points

- `app/` — pages, route handlers, and the `/v1` continuity relay.
- `proxy.ts` — request authentication and public-route policy.
- `app/api/healthz/route.ts` — deployment and local health contract.
- `lib/headless-*-api.ts` and `lib/server-api-client.ts` — typed protocol adapters.

The detailed runtime flow lives in [the system map](../../docs/system-map.md).

## Verify changes

```bash
bun --filter @opencompany/web test
bun --filter @opencompany/web typecheck
bun --filter @opencompany/web lint
bun run boundary:check
```

For user-facing work, run `bun run dev:web` (internal) or `bun run dev:community`, then exercise the
real route and one obvious empty or error state in a browser.

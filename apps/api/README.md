# API ownership

`apps/api` is the public product and provider-ingress composition root. It owns authenticated `/v1`
resources, Actor/workspace authorization, OpenAPI, semantic Run SSE, fixed Electric read models,
identity and onboarding persistence, billing commands, provider OAuth callbacks, and webhook
verification.

## Dependency boundary

The API composes `@opencompany/protocol` routes, `@opencompany/core` application services, and
`@opencompany/db` repositories with narrow provider adapters. It must not import from `apps/web` or
`apps/runner`. Runner control uses authenticated HTTP; durable repositories remain shared adapters,
not cross-app imports.

## Stable entry points

- `src/server.ts` — deployed process composition and lifecycle.
- `src/app.ts` — Hono route composition used by the server and contract tests.
- `/v1/*` — canonical product API defined by `@opencompany/protocol`.
- `/openapi.json` and `/healthz` — contract discovery and health.

Provider callback relays may keep a historical web URL, but verification and persistence terminate
here.

## Verify changes

```bash
bun --filter @opencompany/api test
bun --filter @opencompany/api typecheck
bun --filter @opencompany/protocol openapi:check
bun run smoke:local
```

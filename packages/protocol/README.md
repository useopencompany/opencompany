# Protocol ownership

`@opencompany/protocol` owns the versioned wire contract: `/v1` schemas and routes, semantic Run
events, the inferred typed Hono client, protocol/version headers, and the reviewed OpenAPI artifact.
It contains no persistence or application policy.

## Dependency boundary

Protocol may use contract-only libraries such as Hono and Zod. It must not depend on any `apps/*`
composition root or on `@opencompany/core`/`@opencompany/db`. Clients depend on protocol instead of
physical storage.

## Stable entry points

- `@opencompany/protocol` — schemas, DTOs, routes, events, version constants, and client exports.
- `@opencompany/protocol/client` and `/events` — focused client/event imports.
- `@opencompany/protocol/openapi` — `openapi/openapi.v1.json`.

Only package exports in `package.json` are supported entry points; individual `src/*` files are not.

## Verify changes

```bash
bun --filter @opencompany/protocol test
bun --filter @opencompany/protocol typecheck
bun --filter @opencompany/protocol openapi:check
```

Run `openapi:generate` intentionally when the reviewed contract changes, then include the artifact.

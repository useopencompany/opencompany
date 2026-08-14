# Core ownership

`@opencompany/core` owns framework-free application behavior and ports for Chat, Tasks, Workflows,
Knowledge, Skills, Actors, attachments, and repository contracts. It expresses use cases without
choosing an HTTP framework, database driver, queue, or UI.

## Dependency boundary

Core has no runtime dependencies. It must not import from `apps/*`, `@opencompany/protocol`,
`@opencompany/db`, Drizzle, Next.js, Hono, or Fastify. Composition roots translate protocol DTOs into
core commands and satisfy core ports with database/provider adapters.

## Stable entry points

- `@opencompany/core` — complete public application surface.
- `@opencompany/core/chat`, `/tasks`, `/workflows`, and `/knowledge` — focused exports declared in
  `package.json`.

Unexported `src/*` modules are internal.

## Verify changes

```bash
bun --filter @opencompany/core test
bun --filter @opencompany/core typecheck
```

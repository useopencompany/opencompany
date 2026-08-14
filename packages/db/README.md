# Database ownership

`@opencompany/db` owns Postgres persistence adapters: the current product schema, repository
implementations, pooled/serverless clients, claims and projections, and storage-specific provider
queries. Checked-in Drizzle migrations at the repository root are the immutable data history.

The physical `goat` schema and retained billing/LLM-broker names are historical compatibility
contracts. They stay behind this package and are not the public product vocabulary.

## Dependency boundary

Database adapters may implement `@opencompany/core` ports and use narrow reusable storage/domain
helpers. They must not import from `apps/*` or `@opencompany/protocol`; wire DTOs and HTTP concerns do
not belong in persistence. Apps consume only the explicit package exports in `package.json`.

## Stable entry points

- `@opencompany/db/product-schema` — current product schema model.
- `@opencompany/db/client` and `/pool` — serverless and long-lived process clients.
- Repository exports such as `/chat-repository`, `/task-repository`, `/workflow-repository`, and
  `/knowledge-repository`.
- Other subpaths explicitly declared in `package.json` for existing bounded adapters.

## Verify changes

```bash
bun --filter @opencompany/db test
bun --filter @opencompany/db typecheck
bun run db:migrations:check
```

Every physical schema change needs a reviewed new migration. Never rewrite applied migrations or run
production migrations from a development task.

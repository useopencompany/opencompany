# Database and migrations

OpenCompany uses Neon Postgres and Drizzle. Local development creates a Neon child branch for the
current Git branch; production releases use `PRODUCTION_DATABASE_URL` only inside the release
workflow.

## Schema modules

- `packages/db/src/goat-schema.ts` — current Goat product tables in the `goat` schema.
- `packages/db/src/legacy-billing-schema.ts` — retained public-schema billing compatibility tables.
- `packages/db/src/llm-broker-schema.ts` — retained public-schema broker token/request tables.

`client.ts`, `pool.ts`, and `drizzle.config.ts` compose exactly those modules. Feature-specific
query helpers live in `packages/db/src/goat-*`; consumers should import the narrow package export
instead of the entire schema where practical.

## Local branches

`bun run setup` creates or reuses a branch derived from the configured Neon parent and writes its
pooled connection to `.env.local`. The runner derives a direct endpoint or uses
`RUNNER_DATABASE_URL` for its node-postgres pool. Run `bun run db:branch:create` to refresh the
current branch and `bun run db:branch:delete` only after verifying the exact target.

## Migrations

```bash
bun run db:generate
bun run db:migrations:check
bun run db:migrate
```

Generate a migration for physical schema changes, inspect the SQL, and test it on the branch-local
database. Never edit already-applied migrations or the Drizzle journal. CI checks schema/migration
coupling and journal consistency.

Compatibility tables must not be dropped as incidental cleanup. Retiring their schemas requires a
separate, explicitly destructive migration plan with production data verification and rollback
analysis.

## Canonical execution projections

Canonical Chat and Task repositories map the public `Conversation`, `Message`, `Run`, `Attempt`,
`Event`, and `Task` vocabulary onto retained physical Goat tables. Keep that mapping inside
`packages/db/src/chat-repository.ts` and `packages/db/src/task-repository.ts`; API and client code
must not depend on physical table or lease names.

The `*_read_model_v1` tables are derived, API-owned Electric projections. Postgres source rows stay
authoritative, and every Electric shape must use a fixed server-owned table, columns, predicate,
Actor, and Workspace. Adding or changing a projection requires an additive migration, a backfill,
and authorization tests. Historical sessionless Tasks are intentionally excluded from the
canonical Task projection until the bounded compatibility migration in issue #1190; do not delete
their legacy history while that adapter exists.

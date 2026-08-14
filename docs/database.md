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

Migrations are forward-only deployment mechanics, not a runtime mode switch. The application has
one canonical API/runner data path after a migration lands; do not add dual writes, rollback tables,
or client adapters to make an additive migration look reversible. A safe application revert may
leave additive columns, reservations, and rebuildable projections deployed.

Compatibility tables must not be dropped as incidental cleanup. Retiring their schemas requires a
separate, explicitly destructive migration plan with production data verification and rollback
analysis.

## Canonical execution projections

Canonical Chat, Task, and automation repositories map the public `Conversation`, `Message`, `Run`,
`Attempt`, `Event`, `Task`, `Workflow`, and `TaskSchedule` vocabulary onto retained physical Goat
tables. Keep that mapping inside `packages/db/src/chat-repository.ts`,
`packages/db/src/task-repository.ts`, and `packages/db/src/workflow-repository.ts`; API and client
code must not depend on physical table, planner payload, or lease names.

The `*_read_model_v1` tables are derived, API-owned Electric projections. Postgres source rows stay
authoritative, and every public Electric model fixes its server-owned table, columns, predicate,
Actor, Workspace, and allowed parameters. Clients select only named versions such as
`chat-conversations-v1`, `tasks-v1`, `workflows-v1`, `brain-documents-v1`, or
`integration-accounts-v1`; there is no generic web shape selector. Adding or changing a projection
requires an additive migration, an idempotent backfill when existing rows need it, and authorization
tests.

Production `apps/web` code does not import the database or Drizzle. API and runner composition roots
own repository wiring; shared packages own the mapping. The 35 sessionless pre-cutover Tasks remain
readable only through the bounded actor-scoped compatibility resources governed by ADR 0002. Their
physical history must not be deleted without the separate retention, usage, and data-rollback gate.

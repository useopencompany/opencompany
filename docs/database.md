# Database and migrations

opencompany uses Neon Postgres and Drizzle. Local development creates a Neon child branch for the
current Git branch; production releases use `PRODUCTION_DATABASE_URL` only inside the release
workflow.

## Schema modules

- `packages/db/src/product-schema.ts` — current opencompany product tables in the `goat` schema.
- `packages/db/src/legacy-billing-schema.ts` — retained public-schema billing compatibility tables.
- `packages/db/src/llm-broker-schema.ts` — retained public-schema broker token/request tables.

`client.ts`, `pool.ts`, and `drizzle.config.ts` compose exactly those modules. Feature-specific
query helpers live in `packages/db/src/*`; consumers should import the narrow package export
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

## Queue retention and maintenance

The one-shot `bun run db:queue:maintenance --execute` command prunes execution-plane history in
small `FOR UPDATE SKIP LOCKED` batches. It is not started by the runner: schedule it only after the
retention policy below has human approval. A session advisory lock keeps overlapping invocations
from duplicating the work. The proposed policy is:

- `run_events`, `codex_chat_events`, and canonical `task_events` are retained for 30 days after the
  owning Run or Task reaches a terminal state.
- Terminal `codex_chat_turns` are retained for 90 days and are deleted only after their event rows
  have drained. Cascades remove execution attempts, approvals, and interactions; artifact source
  references become null as defined by their foreign key.
- `chat_messages`, `task_messages`, and the canonical read models are not pruned, so user-visible
  transcripts and lightweight Run history remain available.
- Sessionless pre-cutover Task events remain protected by ADR 0002 and are excluded until that
  compatibility retention gate is approved independently.

Migration `0218_goat_postgres_queue_hygiene.sql` adds retention indexes and tighter table-level
autovacuum thresholds, especially for lease- and heartbeat-heavy `codex_chat_turns`. Each command
invocation exports dead-tuple count and ratio gauges per queue table and warns when at least 1,000
dead tuples exceed 20% of the estimated row population.

## LISTEN/NOTIFY policy

Existing LISTEN/NOTIFY paths are latency hints over durable polling. PostgreSQL releases before 19
serialize NOTIFY-adjacent commits on a database-wide lock, so do not add channels or consumers
without revisiting the architecture; new wakeups use the existing poll+wake pattern. The Brain
worker listener samples `pg_notification_queue_usage()` once per minute, exports
`goat.postgres.notify_queue_usage`, and logs a threshold warning at 25% usage. Polling remains the
correctness path if notifications or the listener fail.

## Canonical execution projections

Canonical Chat, Task, and automation repositories map the public `Conversation`, `Message`, `Run`,
`Attempt`, `Event`, `Task`, `Workflow`, and `TaskSchedule` vocabulary onto retained physical opencompany
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

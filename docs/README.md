# Documentation

Start with:

- [opencompany system map](../apps/web/docs/README.md) — current web, API, runner, Chat, Task,
  Workflow, Brain, and coding paths.
- [Getting started](./getting-started.md) — local prerequisites, branch-isolated setup, and development.
- [Architecture](./architecture.md) — application, runner, database, and integration boundaries.
- [Database](./database.md) — Neon branches, Drizzle schemas, and migration rules.
- [Runner](./runner.md) — durable workers and internal endpoints.
- [Deployment](./deployment.md) — production release and rollback flow.
- [Chat operations](./chat-operations.md) — `/v1` topology, release verification, and recovery.
- [Environment variables](./env-vars.md) and [secret management](./secret-management.md).

`docs/future-concepts` contains speculative research, not current operational guidance.

User- and API-facing documentation lives in `apps/docs`; this directory remains the contributor,
architecture, and operations reference.

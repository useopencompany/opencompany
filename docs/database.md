# Database

We use [Neon](https://neon.tech) (serverless Postgres) with [Drizzle ORM](https://orm.drizzle.team).

## Default local database

Local checkouts use a Neon branch by default. `bun run setup` pulls shared non-database env vars
from Infisical, creates or reuses a Neon branch for the current Git branch, writes that branch
connection string to `.env.local`, then runs migrations. Later `bun run env:pull` runs preserve that
branch-specific `DATABASE_URL`.

Developers can use their own Neon project without changing shared Infisical values by creating
`.env.override.local` with `bun run setup:personal` and setting `NEON_PROJECT_ID` there. The
override file is gitignored and takes precedence over `.env.local`.

A shared `DATABASE_URL` is still available as an escape hatch with `bun run setup -- --shared-db`,
but it should not be the normal path for parallel worktrees. Automatic setup runs migrations, and
migrations against a shared branch make unrelated local work interfere with each other.

## Per-branch databases

Each Git branch gets its own Neon branch. Schema migrations, seed data, and destructive experiments stay isolated. Switching Git branches means switching databases.

Neon branches are copy-on-write, so creation is instant and cheap (a few MB until you start diverging).

Local Neon branches expire automatically after 24 hours by default. Running `bun run setup` or
`bun run db:branch:create` refreshes the expiration window. Set `NEON_BRANCH_TTL_HOURS=0` in
`.env.local` before creating the branch if you need to keep one around indefinitely. The script does
not set expiration on the configured parent branch or on branches Neon reports as protected/default.

## Commands

| Command | What it does |
|---|---|
| `bun run db:branch:create` | Creates a Neon branch matching the current Git branch, writes `DATABASE_URL` to `.env.local`. Idempotent. |
| `bun run db:branch:delete` | Deletes the Neon branch matching the current Git branch. |
| `bun run db:generate` | Generates a SQL migration from `packages/db/src/schema.ts` changes into `drizzle/`. |
| `bun run db:migrate` | Applies pending migrations to whatever `DATABASE_URL` points at. |
| `bun run db:seed` | Inserts a dev user + workspace (idempotent). |

## How branch resolution works

`scripts/neon-branch.mjs` shells out to `neonctl` and resolves the project from `NEON_PROJECT_ID`
in `.env.override.local` or `.env.local`.

For local development, set `NEON_PROJECT_ID` in Infisical `dev` + `/web` and run
`bun run env:pull`. This works across new worktrees because the project id is copied into each
`.env.local`. Avoid relying on `bunx neonctl set-context --project-id <id>` for this repo: it writes
a local `.neon` context file, which is worktree-local and gitignored here.

When fetching a connection string, the script auto-selects `neondb` and `neondb_owner` if they exist. These are the right defaults for local migrations and app queries. Set `NEON_DATABASE_NAME` or `NEON_ROLE_NAME` only for nonstandard Neon projects.

The Neon branch name is your current Git branch, lower-cased and sanitized to `[a-z0-9-]`, truncated to 63 chars.

If two local worktrees intentionally use the same Git branch, set `NEON_BRANCH_NAME` in one or both `.env.local` files so they do not point at the same Neon branch.

For a clean local reset, delete and recreate the branch:

```bash
bun run db:branch:delete
bun run setup
```

## Schema changes

1. Edit `packages/db/src/schema.ts`.
2. `bun run db:generate` — produces a new SQL file in `drizzle/`.
3. Review the generated SQL.
4. `bun run db:migrate` — applies it to your branch DB.
5. Commit both `packages/db/src/schema.ts` and the generated SQL.

When teammates pull your branch, their `db:migrate` will catch them up on their own Neon branch.

## Production

Production migrations run from the `Release Production` GitHub Actions workflow before the web app
and runner are deployed. Vercel builds do not run migrations. Set the following in Vercel project
env:

- `DATABASE_URL` — pooled connection string for your prod Neon branch (usually `production` or `main`).
- `NEON_API_KEY` — only needed if you also want to run branch scripts from CI.
- `NEON_PROJECT_ID` — shared project config. Also set this in Infisical `dev` + `/web` for local worktree setup.

Set the same production database URL as `PRODUCTION_DATABASE_URL` in the protected GitHub Actions
`production` environment so the release workflow can apply migrations.

Vercel preview deployments can be wired to spin up their own Neon branch via the [Neon Vercel integration](https://neon.tech/docs/guides/vercel-overview) — out of scope for this doc.

## Optional env vars

These let you override defaults in headless environments:

- `NEON_PARENT_BRANCH` — Neon branch to fork from (default: the project's default branch, usually `production`).
- `NEON_BRANCH_NAME` — local override for the Neon branch name, useful when multiple worktrees share one Git branch.
- `NEON_BRANCH_TTL_HOURS` — local Neon branch lifetime in hours (default: `24`, max: `720`, `0` disables expiration).
- `NEON_DATABASE_NAME` — non-default database name.
- `NEON_ROLE_NAME` — non-default role to connect as.
- `NEON_API_KEY` — headless Neon CLI auth, only needed outside local browser OAuth.
- `OPENCOMPANY_SHARED_DATABASE=1` — use the shared `DATABASE_URL` escape hatch during setup.

## Schema overview

Current tables (see `packages/db/src/schema.ts` for the source of truth):

- `users` — one row per WorkOS user, keyed by `usr_<workos_id>`.
- `workspaces` — internal tenant boundary; each new workspace maps to a WorkOS Organization through `workos_organization_id`.
- `workspace_memberships` — local mirror of user↔workspace membership with a `role`; WorkOS is the source of truth.
- `agents` — latest editable agent state: path, title/body, parsed config, content hash, version, and GitHub sync status.
- `workspace_sync_jobs` — unified GitHub materialization outbox for all synced resources (agents, brain files, agent bundle files). Each row records desired state (`repoPath`, `sourceKind`, `sourceRef`, `operation`, `desiredHash`, rename/delete metadata) plus retry bookkeeping. Repeated edits to the same path coalesce on the unique `(workspaceId, repoPath)` index. Drained by `projectWorkspaceToGitHub()`.
- `workspace_repositories` — one managed private GitHub repo per workspace, including repo id, full name, default branch, and latest head SHA.
- `onboarding_responses` — user's onboarding answers for a workspace.

All app data should hang off `workspaces` so multi-tenant isolation is enforceable from day one.

## Shared package

Database code lives in `@opencompany/db` so the web app and future workers/scripts can share the same schema without importing from `apps/web`.

- `@opencompany/db/schema` exports Drizzle tables, relations, and inferred row types.
- `@opencompany/db/client` exports `getDb()` for the default singleton client and `createDb(databaseUrl?)` for callers that need an explicit connection string.
- `@opencompany/db/pool` exports `createPooledDb(databaseUrl?, options?)` for long-lived services that need a connection pool and interactive transactions.

### Two drivers: `neon-http` (web) vs pooled `node-postgres` (runner)

The two clients exist for two very different workloads:

| | `@opencompany/db/client` (`neon-http`) | `@opencompany/db/pool` (`node-postgres`) |
|---|---|---|
| Used by | Web app (Vercel, serverless) | Runner (`apps/runner`, long-lived) |
| Transport | One HTTPS request per query | Bounded pool of persistent TCP sockets |
| Transactions | None (only `db.batch()` non-interactive batches) | Real `db.transaction(...)` |
| Neon endpoint | Pooled (`-pooler`) | **Direct (non-pooled)** |

A serverless web request touches the database once or twice and then disappears, so a
per-request HTTP driver against Neon's PgBouncer pooler is the right fit. The runner is
the opposite: a persistent process that streams for minutes and issues many queries per
turn. It keeps its own small pool of real Postgres connections, which gives it
statement pipelining and interactive transactions (used by the session-execution lease
writes), and it connects to Neon's **direct** endpoint because PgBouncer transaction
pooling cannot do interactive transactions or `LISTEN`/`NOTIFY`.

The runner resolves its connection string as `RUNNER_DATABASE_URL`, falling back to
`DATABASE_URL` with the `-pooler` host label stripped to reach the direct endpoint.

### Runner pool sizing

`RUNNER_DB_POOL_MAX` (default `10`) bounds the runner's pool. Size it as worker
concurrency (`RUNNER_WORKER_CONCURRENCY`) plus headroom for HTTP routes, the job poller,
and lease heartbeats. Connections are held only transiently (heartbeats are sub-second
writes every 5s; tool/message persistence is short-lived), so the pool needs to cover a
*burst* — roughly one connection per concurrent session at a step boundary — not one
permanently-held connection per session.

The hard ceiling is Neon's `max_connections`, which on the current compute is **~901**
(7 reserved), shared with the web app (`neon-http`, transient) and Inngest. Keep
`instances × RUNNER_DB_POOL_MAX` comfortably under it. In practice the pool is nowhere
near the binding constraint: at the current prod sizing (`RUNNER_WORKER_CONCURRENCY=40`,
`RUNNER_DB_POOL_MAX=60`, 1 instance) the runner uses <7% of Neon's connections, leaving
the rest for the web app. The session ceiling is set by the single event loop, the E2B
concurrent-sandbox quota, and model-gateway rate limits long before Neon is.

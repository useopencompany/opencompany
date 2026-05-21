# Database

We use [Neon](https://neon.tech) (serverless Postgres) with [Drizzle ORM](https://orm.drizzle.team).

## Why per-branch databases

Each Git branch gets its own Neon branch. Schema migrations, seed data, and destructive experiments stay isolated. Switching Git branches means switching databases — no fear of breaking a teammate or your own other branch.

Neon branches are copy-on-write, so creation is instant and cheap (a few MB until you start diverging).

## Commands

| Command | What it does |
|---|---|
| `bun run db:branch:create` | Creates a Neon branch matching the current Git branch, writes `DATABASE_URL` to `.env.local`. Idempotent. |
| `bun run db:branch:delete` | Deletes the Neon branch matching the current Git branch. |
| `bun run db:generate` | Generates a SQL migration from `packages/db/src/schema.ts` changes into `drizzle/`. |
| `bun run db:migrate` | Applies pending migrations to whatever `DATABASE_URL` points at. |
| `bun run db:seed` | Inserts a dev user + workspace (idempotent). |

## How branch resolution works

`scripts/neon-branch.mjs` shells out to `neonctl` and resolves the project from `NEON_PROJECT_ID` in `.env.local`.

For local development, set `NEON_PROJECT_ID` in Vercel Development and run `bun run env:pull`. This works across new worktrees because the project id is copied into each `.env.local`. Avoid relying on `bunx neonctl set-context --project-id <id>` for this repo: it writes a local `.neon` context file, which is worktree-local and gitignored here.

When fetching a connection string, the script auto-selects `neondb` and `neondb_owner` if they exist. These are the right defaults for local migrations and app queries. Set `NEON_DATABASE_NAME` or `NEON_ROLE_NAME` only for nonstandard Neon projects.

The Neon branch name is your current Git branch, lower-cased and sanitized to `[a-z0-9-]`, truncated to 63 chars.

## Schema changes

1. Edit `packages/db/src/schema.ts`.
2. `bun run db:generate` — produces a new SQL file in `drizzle/`.
3. Review the generated SQL.
4. `bun run db:migrate` — applies it to your branch DB.
5. Commit both `packages/db/src/schema.ts` and the generated SQL.

When teammates pull your branch, their `db:migrate` will catch them up on their own Neon branch.

## Production / Vercel

`vercel-build` runs `db:migrate && next build`, so prod deploys auto-migrate against whatever `DATABASE_URL` Vercel has. Set the following in Vercel project env:

- `DATABASE_URL` — pooled connection string for your prod Neon branch (usually `production` or `main`).
- `NEON_API_KEY` — only needed if you also want to run branch scripts from CI.
- `NEON_PROJECT_ID` — shared project config. Also set this in Vercel Development for local worktree setup.

Vercel preview deployments can be wired to spin up their own Neon branch via the [Neon Vercel integration](https://neon.tech/docs/guides/vercel-overview) — out of scope for this doc.

## Optional env vars

These let you override defaults in headless environments:

- `NEON_PARENT_BRANCH` — Neon branch to fork from (default: the project's default branch, usually `production`).
- `NEON_DATABASE_NAME` — non-default database name.
- `NEON_ROLE_NAME` — non-default role to connect as.

## Schema overview

Current tables (see `packages/db/src/schema.ts` for the source of truth):

- `users` — one row per WorkOS user, keyed by `usr_<workos_id>`.
- `workspaces` — tenant boundary; one default workspace per user on first sign-in.
- `workspace_memberships` — many-to-many user↔workspace with a `role`.
- `agents` — workspace-scoped agent documents.
- `onboarding_responses` — one onboarding response per user, tied to a workspace.

All app data should hang off `workspaces` so multi-tenant isolation is enforceable from day one.

## Shared package

Database code lives in `@opencompany/db` so the web app and future workers/scripts can share the same schema without importing from `apps/web`.

- `@opencompany/db/schema` exports Drizzle tables, relations, and inferred row types.
- `@opencompany/db/client` exports `getDb()` for the default singleton client and `createDb(databaseUrl?)` for callers that need an explicit connection string.

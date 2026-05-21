# Database

We use [Neon](https://neon.tech) (serverless Postgres) with [Drizzle ORM](https://orm.drizzle.team).

## Why per-branch databases

Each Git branch gets its own Neon branch. Schema migrations, seed data, and destructive experiments stay isolated. Switching Git branches means switching databases — no fear of breaking a teammate or your own other branch.

Neon branches are copy-on-write, so creation is instant and cheap (a few MB until you start diverging).

## Commands

| Command | What it does |
|---|---|
| `npm run db:branch:create` | Creates a Neon branch matching the current Git branch, writes `DATABASE_URL` to `.env.local`. Idempotent. |
| `npm run db:branch:delete` | Deletes the Neon branch matching the current Git branch. |
| `npm run db:generate` | Generates a SQL migration from `lib/db/schema.ts` changes into `drizzle/`. |
| `npm run db:migrate` | Applies pending migrations to whatever `DATABASE_URL` points at. |
| `npm run db:seed` | Inserts a dev user + workspace (idempotent). |

## How branch resolution works

`scripts/neon-branch.mjs` shells out to `neonctl` and lets it resolve the project from:

1. `NEON_PROJECT_ID` env var (if set)
2. `neon set-context --project-id <id>` config file (if set)
3. Single-project auto-detect (if your account has exactly one project)

The Neon branch name is your current Git branch, lower-cased and sanitized to `[a-z0-9-]`, truncated to 63 chars.

## Schema changes

1. Edit `lib/db/schema.ts`.
2. `npm run db:generate` — produces a new SQL file in `drizzle/`.
3. Review the generated SQL.
4. `npm run db:migrate` — applies it to your branch DB.
5. Commit both `schema.ts` and the generated SQL.

When teammates pull your branch, their `db:migrate` will catch them up on their own Neon branch.

## Production / Vercel

`vercel-build` runs `db:migrate && next build`, so prod deploys auto-migrate against whatever `DATABASE_URL` Vercel has. Set the following in Vercel project env:

- `DATABASE_URL` — pooled connection string for your prod Neon branch (usually `production` or `main`).
- `NEON_API_KEY` — only needed if you also want to run branch scripts from CI.
- `NEON_PROJECT_ID` — only needed if running branch scripts from CI.

Vercel preview deployments can be wired to spin up their own Neon branch via the [Neon Vercel integration](https://neon.tech/docs/guides/vercel-overview) — out of scope for this doc.

## Optional env vars

These let you override defaults in headless environments:

- `NEON_PARENT_BRANCH` — Neon branch to fork from (default: the project's default branch, usually `production`).
- `NEON_DATABASE_NAME` — non-default database name.
- `NEON_ROLE_NAME` — non-default role to connect as.

## Schema overview

Current tables (see `lib/db/schema.ts` for the source of truth):

- `users` — one row per WorkOS user, keyed by `usr_<workos_id>`.
- `workspaces` — tenant boundary; one default workspace per user on first sign-in.
- `workspace_memberships` — many-to-many user↔workspace with a `role`.

All app data should hang off `workspaces` so multi-tenant isolation is enforceable from day one.

# Getting started

Goal: get a local dev environment running with auth and a personal database in under five minutes.

## Prerequisites

- Node 20+ and Bun 1.3+
- Access to this project's Vercel project for shared development environment variables.
- (optional) A Neon account — https://console.neon.tech. The Neon CLI's `auth` command will create one for you.
- (optional) A WorkOS account — https://dashboard.workos.com. Most local development should use the shared WorkOS staging/local environment from Vercel.

## The short version

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is interactive and idempotent. It will:

1. Copy `.env.example` → `.env.local` if missing.
2. If WorkOS keys are placeholders, offer to pull shared Development env vars from Vercel into `.env.local`.
3. Run `bunx neonctl auth` if you're not logged in (browser OAuth).
4. Create a Neon branch matching your current Git branch and write `DATABASE_URL`.
5. Run migrations.
6. Optionally seed a dev user/workspace.

Re-running it is safe.

## For agents

```bash
bun run setup -- --check
```

Emits a JSON state snapshot with a `nextSteps` array. Used by the `start-work` skill so agents know exactly which steps they can run vs which need a human at the terminal.

## Env vars

Vercel is the source of truth for shared development env vars. Store the stable WorkOS dev/staging AuthKit values in Vercel's **Development** environment:

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `NEON_PROJECT_ID`

Then pull them locally:

```bash
bunx vercel link      # one-time per checkout, if .vercel/ is missing
bun run env:pull
```

`bun run env:pull` pulls Vercel Development env vars to a temporary file and merges only shared setup keys into `.env.local`, so it does not overwrite branch-local values like `DATABASE_URL` and `NEON_BRANCH`.

Mark `WORKOS_API_KEY` and any other secrets as sensitive in Vercel. `NEON_PROJECT_ID` is project configuration, not a database password. Do not put `DATABASE_URL` in Vercel Development for local branch databases; setup writes that per checkout after creating the Neon branch.

## What's still manual

- **Neon project id:** set `NEON_PROJECT_ID` in Vercel Development so new worktrees can create their branch database without relying on local `neonctl set-context` files. The branch script auto-selects `neondb` / `neondb_owner` when present; use `NEON_DATABASE_NAME` or `NEON_ROLE_NAME` only for nonstandard projects.
- **Initial WorkOS bootstrap only:** if the shared WorkOS dev environment does not exist yet, run `bunx workos@latest install --integration next --redirect-uri http://localhost:3000/auth/callback --no-branch --no-commit` once, copy the resulting AuthKit env vars into Vercel Development, and keep using `bun run env:pull` after that.
- **Production WorkOS:** create a production WorkOS environment in the dashboard and set the redirect URI to your prod callback URL. Keep production values in Vercel Production, separate from Development.

## Day-to-day

- New Git branch → `bun run db:branch:create` (or re-run `bun run setup`). Each Git branch gets its own isolated Neon DB.
- Delete a Git branch → `bun run db:branch:delete` to clean up its Neon branch.
- Schema change → edit `apps/web/lib/db/schema.ts`, then `bun run db:generate`, then `bun run db:migrate`.

See [database.md](./database.md) for the branching workflow and [auth.md](./auth.md) for the auth flow.

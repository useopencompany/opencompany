# Getting started

Goal: get a local dev environment running with auth and the shared dev database in under five minutes.

## Prerequisites

- Node 20+ and Bun 1.3+
- Access to this project's Vercel project for shared development environment variables.
- (optional) A WorkOS account — https://dashboard.workos.com. Most local development should use the shared WorkOS staging/local environment from Vercel.

## The short version

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is interactive and idempotent. It will:

1. Copy `.env.example` → `.env.local` if missing.
2. If WorkOS keys or `DATABASE_URL` are placeholders, offer to pull shared Development env vars from Vercel into `.env.local`.
3. Run migrations against `DATABASE_URL`.
4. Optionally seed a dev user/workspace.

Re-running it is safe.

Per-branch Neon databases aren't part of the default setup right now — every checkout uses the `DATABASE_URL` from Vercel Development. The `db:branch:create` / `db:branch:delete` scripts are still around if you want to opt into branch isolation manually; see [database.md](./database.md).

## For agents

```bash
bun run setup -- --check
```

Emits a JSON state snapshot with a `nextSteps` array. Used by the `start-work` skill so agents know exactly which steps they can run vs which need a human at the terminal.

## Env vars

Vercel is the source of truth for shared development env vars. Store the stable shared dev values in Vercel's **Development** environment:

- `DATABASE_URL`
- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `OPENCOMPANY_GITHUB_ORG`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`

Then pull them locally:

```bash
bunx vercel link      # one-time per checkout, if .vercel/ is missing
bun run env:pull
```

`bun run env:pull` pulls Vercel Development env vars to a temporary file and merges only the shared setup keys above into `.env.local`.

Mark `WORKOS_API_KEY`, `DATABASE_URL`, and `GITHUB_APP_PRIVATE_KEY` as sensitive in Vercel.

The Inngest values in `.env.example` are for background jobs. Local `bun run dev` uses the Inngest dev helper; hosted environments should set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.

## What's still manual

- **Initial WorkOS bootstrap only:** if the shared WorkOS dev environment does not exist yet, run `bunx workos@latest install --integration next --redirect-uri http://localhost:3000/auth/callback --no-branch --no-commit` once, copy the resulting AuthKit env vars into Vercel Development, and keep using `bun run env:pull` after that.
- **Production WorkOS:** create a production WorkOS environment in the dashboard and set the redirect URI to your prod callback URL. Keep production values in Vercel Production, separate from Development.

## Day-to-day

- Schema change → edit `packages/db/src/schema.ts`, then `bun run db:generate`, then `bun run db:migrate`.
- New env var in Vercel → `bun run env:pull` to refresh `.env.local`.
- Agent editing / GitHub / Inngest architecture → see [architecture.md](./architecture.md).

See [database.md](./database.md) for the optional per-branch workflow and [auth.md](./auth.md) for the auth flow.

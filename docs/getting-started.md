# Getting started

Goal: get a local dev environment running with auth and a personal database in under five minutes.

## Prerequisites

- Node 20+ and Bun 1.3+
- (optional) A Neon account — https://console.neon.tech. The Neon CLI's `auth` command will create one for you.
- (optional) A WorkOS account — https://dashboard.workos.com. The WorkOS installer can auto-provision a temporary dev environment, so you can try things before signing up.

## The short version

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is interactive and idempotent. It will:

1. Copy `.env.example` → `.env.local` if missing.
2. If WorkOS keys are placeholders, offer to run `bunx workos@latest install` — which **auto-provisions a temporary WorkOS environment** (no signup), sets the redirect URI, and writes keys to `.env.local`.
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

## What's still manual

- **Neon multi-project users only:** pin which Neon project this repo uses with `bunx neonctl set-context --project-id <id>` (single-project accounts auto-detect).
- **Production WorkOS:** the auto-provisioned environment is for dev. For real deployments, create a production WorkOS environment in their dashboard and set the redirect URI to your prod callback URL.

## Day-to-day

- New Git branch → `bun run db:branch:create` (or re-run `bun run setup`). Each Git branch gets its own isolated Neon DB.
- Delete a Git branch → `bun run db:branch:delete` to clean up its Neon branch.
- Schema change → edit `lib/db/schema.ts`, then `bun run db:generate`, then `bun run db:migrate`.

See [database.md](./database.md) for the branching workflow and [auth.md](./auth.md) for the auth flow.

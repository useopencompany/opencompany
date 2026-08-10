# Getting started

## Prerequisites

- Bun `1.3.2`
- Node `20.20.0` or newer
- Infisical CLI authenticated to this project
- Neon CLI access to the development project
- Docker or OrbStack for local Electric
- Stripe CLI for local billing webhooks
- Caddy for Goat's local HTTPS origin (setup can install it with Homebrew on macOS)

## Bootstrap

```bash
bun install --frozen-lockfile
bun run setup
bun run dev:goat
```

Setup copies `.env.example` to `.env.local` when needed, pulls Infisical `dev` values from `/goat`
and `/runner`, creates or reuses a Neon child branch named for the current Git branch, runs the
checked-in migrations, starts local Electric, and mirrors the required values to
`apps/goat/.env.local`. It is safe to rerun.

Use `bun run setup -- --check` for a read-only readiness report. `bun run env:pull` refreshes shared
development values, and `bun run setup:stripe` refreshes local Stripe configuration.

## Local stack

`bun run dev` and `bun run dev:goat` start the same current stack:

- Goat, normally at `https://localhost:3443`;
- the Goat runner, normally at `http://localhost:3040`;
- Stripe CLI forwarding to Goat's webhook;
- Electric and the local HTTPS/tunnel helpers used by integrations.

Use `bun run dev:logs -- --source goat --tail 100` or `--source runner` to inspect the gitignored
Turbo log. Do not paste unredacted local logs into issues because provider output can be sensitive.

## Database isolation

The default is one Neon branch per Git branch. Do not replace `DATABASE_URL` with a shared database
to work around setup failures. `OPENCOMPANY_SHARED_DATABASE=1` is an explicit escape hatch only.
Delete an abandoned branch with `bun run db:branch:delete` after resolving its exact target.

## First verification

Open Goat, sign in through WorkOS, send a foreground chat message, and confirm live updates arrive.
For changes touching the runner, create the relevant task or cloud coding turn and verify its
durable status in the UI. For billing work, run `bun run setup:stripe` and confirm the local Stripe
listener forwards a signed event to `/api/stripe/webhook`.

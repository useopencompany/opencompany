# Getting started

> **Current support boundary:** This guide documents the maintainer setup and requires access to
> opencompany-managed development services. A credential-independent path for core local
> development is planned but not yet available. Community contributors can still install
> dependencies and run the checks documented in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- Bun `1.3.2`
- Node `20.20.0` or newer
- Infisical CLI authenticated to this project
- Neon CLI access to the development project
- Docker or OrbStack for local Electric
- Stripe CLI for local billing webhooks
- Caddy for the web app's local HTTPS origin (setup can install it with Homebrew on macOS)

The tracked `.infisical.json` selects opencompany's Infisical project without containing
credentials. Once the CLI is authenticated and the user has project access, setup works in regular
clones and worktrees without running `infisical init`. Run `vercel link` only when local work needs
Vercel project access; it creates the gitignored `.vercel/project.json`. Conductor copies that local
Vercel binding from the repository root into new workspaces through `.worktreeinclude`.

## Bootstrap

```bash
bun install --frozen-lockfile
bun run setup
bun run dev:web
```

Setup copies `.env.example` to `.env.local` when needed, pulls Infisical `dev` values from `/web`
and `/runner`, creates or reuses a Neon child branch named for the current Git branch, runs the
checked-in migrations, starts local Electric, and mirrors the required values to
`apps/web/.env.local`. It is safe to rerun.

The local web app is a presentation client. Product commands, identity persistence, and authorized
read models are served by the local API; the runner claims durable execution and background work
directly from the branch database.

Use `bun run setup -- --check` for a read-only readiness report. `bun run env:pull` refreshes shared
development values, and `bun run setup:stripe` refreshes local Stripe configuration.

## Local stack

`bun run dev` and `bun run dev:web` start the same current stack:

- the opencompany web app, normally at `https://localhost:3443`;
- the product API, normally at `http://localhost:3001`;
- the runner, normally at `http://localhost:3040`;
- Stripe CLI forwarding to the web app's unchanged `/api/stripe/webhook` relay, which streams to
  the API-owned handler;
- Electric and the local HTTPS/tunnel helpers used by integrations.

The browser uses the web origin for pages and the configured API origin for `/v1` commands, streams,
and named read models. Provider callback URLs may pass through thin web relays before the API handles
them; this does not create a second local backend.

Use `bun run dev:logs -- --source web --tail 100`, `--source @opencompany/api#dev`, or
`--source runner` to inspect the gitignored Turbo log. Do not paste unredacted local logs into issues
because provider output can be sensitive.

## Database isolation

The default is one Neon branch per Git branch. Do not replace `DATABASE_URL` with a shared database
to work around setup failures. `OPENCOMPANY_SHARED_DATABASE=1` is an explicit escape hatch only.
Delete an abandoned branch with `bun run db:branch:delete` after resolving its exact target.

## First verification

Open the web app and sign in through WorkOS. Confirm the API-backed identity resolves, send a
foreground chat message, reload during or after the Run, and confirm the durable result converges.
For changes touching the runner, create the relevant task or cloud coding turn and verify its
durable status in the UI. For billing work, run `bun run setup:stripe` and confirm the local Stripe
listener forwards a signed event through `/api/stripe/webhook` to the API-owned handler.

# Getting started

Goal: get a local dev environment running with auth and an isolated Neon branch database in under
five minutes.

## Prerequisites

- Node 20+ and Bun 1.3+
- A container runtime — [OrbStack](https://orbstack.dev) (`brew install orbstack`) or Docker
  Desktop. **Required:** `bun run setup` uses it to start local Electric, which the app's live
  sync goes through, and fails fast if it's missing. Also enable logical replication on the Neon
  project (Neon console → Settings) so Electric can replicate.
- Caddy for local HTTPS/HTTP2. `bun run setup` installs it with Homebrew on macOS when possible;
  without it, `bun run dev` still works but the app falls back to plain HTTP on `APP_PORT`.
- Access to this project's Infisical project for shared development environment variables.
- (optional) A WorkOS account — https://dashboard.workos.com. Most local development should use
  the shared WorkOS staging/local environment from Infisical.

## New engineer setup

Grant these before the first setup call:

- GitHub repo access, with permission to push branches and open PRs.
- Infisical access to the `opencompany` project, `dev` environment only, paths `/web` and
  `/runner` (the `dev` `/web` folder holds the shared app dev values).
- A personal Neon account and project for local development.

Optional, depending on what they will touch:

- Stripe test access or a Stripe CLI login for billing and webhook work.
- Linear access for issue triage and feedback intake.
- Vercel, Render, Better Stack, SigNoz, and PostHog access for hosted debugging.

Do not grant production Neon, Infisical `prod`, or Infisical `/release` for normal onboarding.

First run:

```bash
git clone <repo-url>
cd opencompany
nvm install
nvm use
bun install

infisical login
infisical init

bun run setup:personal
```

Set the engineer's personal Neon project in `.env.override.local`:

```dotenv
NEON_PROJECT_ID="your-personal-neon-project-id"
```

For local terminals, prefer Neon browser auth:

```bash
bunx neonctl auth
```

Then run:

```bash
bun run setup
bun run dev
```

Open the printed URL — normally `https://localhost:3443`.

## The short version

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is idempotent. It will:

1. Copy `.env.example` → `.env.local` if missing.
2. If WorkOS keys or `NEON_PROJECT_ID` are placeholders, pull shared dev env vars from Infisical
   (`dev` + `/web` and `/runner`) into `.env.local`.
3. Create or reuse a Neon branch for the current Git branch and write its `DATABASE_URL` to
   `.env.local`.
4. Fill missing local Stripe credentials from the Stripe CLI when available.
5. Run migrations against that branch database.
6. Start a local Electric sync container against that database and set `ELECTRIC_URL`. A container
   runtime is required — setup fails fast with install instructions if OrbStack/Docker is missing
   or not running. See [docs/stack/electric-sync.md](stack/electric-sync.md).
7. Install/check Caddy when available so local dev serves `https://localhost:3443` over HTTP/2.
   This avoids browser HTTP/1.1 connection starvation from many Electric shape streams.
8. Mirror the DB/Auth/runner/Electric values the app needs into `apps/app/.env.local`.

Re-running it is safe.

## Local scripts

These are the root commands a contributor is expected to run directly:

| Command | Use when |
| --- | --- |
| `bun run setup` | Prepare or refresh local env files, Neon branch database, Stripe fallback values, and migrations. |
| `bun run setup:dev` | Run setup, then start the dev stack. |
| `bun run setup:personal` | Create `.env.override.local` for developer-owned values such as a personal Neon project. |
| `bun run setup:stripe` | Complete local Stripe billing setup: load restricted billing values from Infisical when available, generate the reconciliation secret, and refresh the app env. |
| `bun run env:pull` | Merge shared Infisical dev values into `.env.local` without replacing local database settings. |
| `bun run dev` | Start the product stack — app + runner — with streaming logs, the local dev proxy, Caddy HTTPS, and ngrok when available. The app runs internally on port 3002 and is served at `https://localhost:3443` when Caddy is installed. In a Conductor workspace whose ports are taken, it automatically falls back to that workspace's isolated port range. |
| `bun run dev:tui` | Same stack with Turbo's interactive TUI instead of streaming output. |
| `bun run dev:runner` | Start only the runner service. |
| `bun run dev:ds` | Start only the design-system app. |
| `bun run dev:marketing` | Start only the marketing site. |
| `bun run dev:logs` | Read the latest local dev logs from `.context/logs/dev-turbo.json`; use `-- --source runner`, `-- --source app`, `-- --errors`, `-- --grep <text>`, or `-- --follow`. |
| `bun run electric:dev` | Run the local Electric sync container in the foreground to tail its logs or restart it against a freshly rebranched database. `bun run setup` already starts it detached. |
| `bun run dev:kill-port` | Stop whichever process is listening on port 3000, or pass another port after `--`. |
| `bun run github:tunnel` | Start or refresh an ngrok tunnel for local GitHub integration callbacks. |
| `bun run db:generate` | Generate a Drizzle migration after changing the schema in `packages/db/src`. |
| `bun run db:migrate` | Apply pending Drizzle migrations to the current `DATABASE_URL`. |
| `bun run db:branch:create` | Create or refresh the Neon branch for the current Git branch. |
| `bun run db:branch:delete` | Delete the Neon branch for the current Git branch. |
| `bun run db:seed` | Insert the idempotent development user and workspace seed data. |
| `bun run capabilities:contract` | Check the managed-capabilities contract after touching capability definitions. |

Release automation commands are documented in [deployment.md](./deployment.md), not in this
onboarding flow.

## Personal overrides

Use a personal override file for developer-owned resources that should not be pulled from
Infisical or overwritten by `bun run env:pull`:

```bash
bun run setup:personal
```

This creates `.env.override.local`, which is gitignored and has higher precedence than
`.env.local`. The main use case is personal Neon projects for local development:

```dotenv
NEON_PROJECT_ID="your-personal-neon-project-id"
# Optional for headless Neon CLI usage. Prefer `bunx neonctl auth` locally.
NEON_API_KEY=""
```

After adding personal overrides, run `bun run setup`. Shared dev secrets still come from Infisical
`dev` + `/web` and `/runner`, but the local override wins for keys like `NEON_PROJECT_ID`.

If you want setup to launch the dev server after migrations, run `bun run setup:dev`.

`bun run dev` attempts to start ngrok before the app when the local ngrok CLI is authenticated.
That gives integrations such as GitHub, Slack, and HubSpot a public callback URL without a separate
command, and the wrapper exposes a local proxy through ngrok and injects
`RUNNER_LLM_BROKER_PUBLIC_URL` into the runner process so sandboxed coding agents can call back to
the runner's `/broker/*` routes. Set `OPENCOMPANY_NGROK_DISABLED=1` to skip the tunnel, or
`APP_HTTPS_DISABLED=1` to skip Caddy and use HTTP on `APP_PORT`. Register
`https://localhost:3443/auth/callback` in WorkOS for fixed-port local development and allow the
printed localhost callback port when using parallel workspaces.

`bun run dev` also writes Turbo's structured task output to `.context/logs/dev-turbo.json` for
local debugging. The file is gitignored and captures the same output that appears in the dev
terminal, including possible secrets, so do not paste raw excerpts outside trusted debugging
contexts. If the top-level supervisor itself crashes, its uncaught error is preserved separately in
`.context/logs/dev-supervisor.log`. Useful reads:

```bash
bun run dev:logs -- --source runner --tail 100
bun run dev:logs -- --source app --grep ECONNREFUSED
bun run dev:logs -- --errors --follow
```

The older shared database path is still available with `bun run setup -- --shared-db`, but the
default is branch isolation because this repo is commonly used from multiple Git worktrees. See
[database.md](./database.md).

## For agents

```bash
bun run setup -- --check
```

Emits a JSON state snapshot with a `nextSteps` array. Used by the `start-work` skill so agents know
exactly which steps they can run vs which need a human at the terminal.

Use the same command if setup fails and you want a machine-readable status.

## Env vars

Infisical is the source of truth for shared development env vars. Store the stable shared dev
values in Infisical `dev` + `/web` and `/runner`:

- `NEON_PROJECT_ID`
- WorkOS vars (`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`,
  `NEXT_PUBLIC_WORKOS_REDIRECT_URI`)
- GitHub app vars (workspace-state and integration apps)
- `STRIPE_API_KEY`, `STRIPE_CHECKOUT_ENABLED`, `CRON_SECRET`
- optional runner, Linear, analytics, and observability values from `.env.example`

`DATABASE_URL` can exist in Infisical `dev` only for the explicit `--shared-db` mode, but normal
local setup writes `.env.local` with a Neon branch-specific URL.

Runner-only development secrets such as `E2B_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`,
`OPENAI_CODEX_API_KEY`, `EXA_API_KEY`, `APIFY_API_TOKEN`, and `SUPADATA_API_KEY` are also pulled
from Infisical `dev` + `/runner` into `.env.local` when present. This lets the local runner use the
same shared provider credentials without copying them by hand.

Stripe setup has a local fallback: if `STRIPE_API_KEY` or `STRIPE_WEBHOOK_SECRET` are still
placeholders, `bun run setup` reads the active Stripe CLI test key and runs
`stripe listen --print-secret`, then writes both values into `.env.local` without printing them.
It also generates `CRON_SECRET` and refreshes `apps/app/.env.local`. Run `stripe login` once
first. If you use a non-default Stripe CLI profile, set `STRIPE_CLI_PROJECT_NAME` before running
setup. For an existing checkout where only Stripe is missing, run `bun run setup:stripe`.

Billing requires `STRIPE_API_KEY` to be a restricted key. Setup prefers an `rk_test_` key from the
Stripe CLI; Stripe may instead issue an expiring `sk_test_` CLI key, which setup accepts only as a
gitignored local-development fallback. Hosted environments always require a dedicated restricted
key stored in Infisical. Billing has a $0 Hobby plan with $5 of calendar-month usage and a
$20-per-seat Pro plan with $20 of calendar-month usage per seat; Pro admins can buy shared top-up
credits and enable auto-refill. Checkout creates the recurring price inline, uses automatic tax
(configure **Stripe Tax → Registrations** before enabling live Checkout), and hosted live Checkout
additionally requires `STRIPE_CHECKOUT_ENABLED=true`. Limit the restricted key to Customer,
Checkout Session, Customer Portal, PaymentIntent, and Subscription read/write permissions.

Credit top-up Checkouts accept promotion codes. For internal no-cost tests, create a 100%-off
coupon and a customer-facing promotion code in Stripe test mode. Add an expiry, redemption limit,
or customer restriction unless the code is deliberately permanent; create live-mode codes
separately and keep them private.

Then pull shared values locally:

```bash
bun run env:pull
```

`bun run env:pull` pulls Infisical dev values and merges only the shared setup keys above into
`.env.local`. In the default branch database mode, it does not overwrite `DATABASE_URL`.

## What's still manual

- **Initial WorkOS bootstrap only:** if the shared WorkOS dev environment does not exist yet,
  create it in WorkOS, set `https://localhost:3443/auth/callback` as a redirect URI, and copy the
  resulting AuthKit env vars into Infisical `dev` + `/web`.
- **Initial Stripe CLI bootstrap only:** run `stripe login` once. For shared development env vars,
  prefer storing a restricted test key as `STRIPE_API_KEY` in Infisical `dev` + `/web`.
- **Initial GitHub integration bootstrap only:** create a dedicated development GitHub App and a
  stable ngrok domain when testing the user-facing GitHub work integration locally. See
  [github-local-dev.md](./github-local-dev.md).
- **Google (Gmail + Calendar + Drive) integration bootstrap only:** create an OAuth client in the
  Google Cloud console (APIs & Services → Credentials → OAuth client ID, type "Web application").
  Add `${NEXT_PUBLIC_APP_URL}/api/integrations/gmail/callback`,
  `${NEXT_PUBLIC_APP_URL}/api/integrations/google-calendar/callback`, and
  `${NEXT_PUBLIC_APP_URL}/api/integrations/google-drive/callback` as authorized redirect URIs,
  enable the Gmail, Google Calendar, Google Drive, and Google Docs APIs, and put
  `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and
  `GOOGLE_INTEGRATION_STATE_SECRET` in Infisical `dev` + `/web` and `/runner`. On the OAuth consent
  screen, Gmail's `gmail.readonly` and `gmail.compose` scopes and Drive's `drive.readonly` scope
  are **restricted**, while Calendar and the `documents` scope used for confirmation-gated Google
  Doc edits are **sensitive**. For external/production users Google requires app verification, and
  restricted server-side access may require a security assessment. Until verification, add
  yourself as a **test user** on the consent screen — the flow works fully for test users.
- **Slack / HubSpot / Linear ingestion bootstrap only:** these need public webhook URLs; use a
  second "dev" provider app pointed at a tunnel (for example
  `cloudflared tunnel --url http://localhost:3443`) in front of the local app. Redirect and webhook
  URL shapes are documented in [.env.example](../.env.example) and [env-vars.md](./env-vars.md).
- **Neon logical replication (one-time per project):** enable logical replication in the Neon
  console (project → Settings) so Electric can create its replication slot. Project-level, so it
  covers every branch. `bun run setup` starts Electric but cannot flip this toggle for you.
- **Production WorkOS:** production values live in Infisical `prod`, separate from `dev`. See
  [deployment.md](./deployment.md).

## Day-to-day

- Schema change → edit the schema in `packages/db/src`, then `bun run db:generate`, then
  `bun run db:migrate`.
- Reset local database → `bun run db:branch:delete`, then `bun run setup`.
- New env var in Infisical → `bun run env:pull` to refresh `.env.local`.
- Missing local Stripe values → `bun run setup:stripe`.
- System orientation → see [architecture.md](./architecture.md) and
  [apps/app/docs/README.md](../apps/app/docs/README.md).

## Common fixes

- Infisical export fails: confirm the engineer has `dev` access to `/web` and `/runner`, then run
  `infisical login` again.
- Neon branch creation fails: confirm `NEON_PROJECT_ID` is in `.env.override.local` and run
  `bunx neonctl auth`.
- Setup fails with "No container runtime found": install OrbStack (`brew install orbstack`) and
  start it (`open -a OrbStack`), then re-run `bun run setup`.
- Electric started but isn't healthy, or the app shows no data / shape proxy returns 503: enable
  logical replication on the Neon project (console → Settings), then re-run setup. Inspect with
  `docker logs --tail 40 opencompany-electric`.
- WorkOS redirect fails: the local redirect URI must include `https://localhost:3443/auth/callback`
  (or the printed fallback port in parallel workspaces).
- Stripe setup warns: run `stripe login`, or skip it unless the task touches billing.

See [database.md](./database.md) for the database workflow and [auth.md](./auth.md) for the auth
flow.

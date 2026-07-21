# Getting started

Goal: get a local dev environment running with auth and an isolated Neon branch database in under five minutes.

## Prerequisites

- Node 20+ and Bun 1.3+
- A container runtime — [OrbStack](https://orbstack.dev) (`brew install orbstack`) or Docker
  Desktop. **Required:** `bun run setup` uses it to start local Electric, which the
  agents/sessions UI syncs through, and fails fast if it's missing. Also enable logical
  replication on the Neon project (Neon console → Settings) so Electric can replicate.
- Caddy for Goat local HTTPS/HTTP2. `bun run setup` installs it with Homebrew on macOS when
  possible; without it, `bun run dev:goat` still works but falls back to plain HTTP.
- Access to this project's Infisical project for shared development environment variables.
- (optional) A WorkOS account — https://dashboard.workos.com. Most local development should use the shared WorkOS staging/local environment from Infisical.

## New engineer setup

Grant these before the first setup call:

- GitHub repo access, with permission to push branches and open PRs.
- Infisical access to the `opencompany` project, `dev` environment only, paths `/web` and
  `/runner`.
- A personal Neon account and project for local development.

Optional, depending on what they will touch:

- Stripe test access or a Stripe CLI login for billing and webhook work.
- Linear access for issue triage and feedback intake.
- Vercel, Render, Better Stack, PostHog, and Inngest Cloud access for hosted debugging.

Do not grant production Neon, Infisical `prod`, or Infisical `/release` for normal onboarding.

First run:

```bash
git clone <repo-url>
cd lisbon-v4
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

Open `http://localhost:3000`.

## The short version

```bash
bun install
bun run setup
bun run dev
```

`bun run setup` is idempotent. It will:

1. Copy `.env.example` → `.env.local` if missing.
2. If WorkOS keys or `NEON_PROJECT_ID` are placeholders, pull shared dev env vars from Infisical into `.env.local`.
3. Create or reuse a Neon branch for the current Git branch and write its `DATABASE_URL` to `.env.local`.
4. Fill missing local Stripe credentials from the Stripe CLI when available.
5. Run migrations against that branch database.
6. Start a local Electric sync container against that database and set `ELECTRIC_URL`. A
   container runtime is required — setup fails fast with install instructions if OrbStack/Docker
   is missing or not running. See [docs/stack/electric-sync.md](stack/electric-sync.md).
7. Install/check Caddy when available so Goat local dev can serve `https://localhost:3443` over
   HTTP/2. This avoids browser HTTP/1.1 connection starvation from many Electric shape streams.
8. Mirror the DB/Auth/runner/Electric values Goat needs into `apps/goat/.env.local`.

Re-running it is safe.

## Local scripts

These are the root commands a contributor is expected to run directly:

| Command | Use when |
| --- | --- |
| `bun run setup` | Prepare or refresh local env files, Neon branch database, Stripe fallback values, and migrations. |
| `bun run setup:dev` | Run setup, then start the full local dev stack. |
| `bun run setup:personal` | Create `.env.override.local` for developer-owned values such as a personal Neon project. |
| `bun run setup:stripe` | Complete local Stripe billing setup: load restricted Goat values from Infisical when available, reuse or create the OpenCompany Pro test Price, generate the reconciliation secret, and refresh the Goat app env. |
| `bun run env:pull` | Merge shared Infisical dev values into `.env.local` without replacing local database settings. |
| `bun run dev` | Start the full local stack with the Turbo TUI: web, runner, Inngest, Stripe webhooks, a local Durable Streams server (auto-sets `DURABLE_STREAMS_URL`), and ngrok when available. |
| `bun run dev:goat` | Start the Goat experiment app plus the runner with stream output and the same local Durable Streams/ngrok wrapper. Goat runs internally on port 3002 by default and is exposed through Caddy at `https://localhost:3443` when Caddy is installed. If those ports are occupied in a Conductor workspace, the command automatically falls back to that workspace's allocated port range so parallel workspaces cannot terminate each other. When ngrok is available, it also exposes one public URL through a local proxy so E2B Goat tasks can reach runner `/goat/tools/*` and `/broker/*` callbacks. Run `bun run setup` first so Electric, Caddy, and `apps/goat/.env.local` are ready. Use `bun run dev:goat:tui` only when you specifically want Turbo's interactive TUI. |
| `bun run dev:stream` | Start the same full local stack with streaming logs instead of the Turbo TUI. |
| `bun run dev:logs` | Read the latest local dev logs from `.context/logs/dev-turbo.json`; use `-- --source runner`, `-- --source web`, `-- --errors`, `-- --grep <text>`, or `-- --follow`. |
| `bun run dev:web` | Start only the Next.js web app. |
| `bun run dev:runner` | Start only the runner service. |
| `bun run electric:dev` | Run the local Electric sync container in the foreground to tail its logs or restart it against a freshly rebranched database. `bun run setup` already starts it detached. |
| `bun run dev:kill-port` | Stop whichever process is listening on port 3000, or pass another port after `--`. |
| `bun run dev:kill-3000` | Stop whichever process is listening on port 3000. |
| `bun run github:tunnel` | Start or refresh an ngrok tunnel for local GitHub integration callbacks. |
| `bun run db:generate` | Generate a Drizzle migration after changing `packages/db/src/schema.ts`. |
| `bun run db:migrate` | Apply pending Drizzle migrations to the current `DATABASE_URL`. |
| `bun run db:branch:create` | Create or refresh the Neon branch for the current Git branch. |
| `bun run db:branch:delete` | Delete the Neon branch for the current Git branch. |
| `bun run db:seed` | Insert the idempotent development user and workspace seed data. |

Release automation commands are documented in [deployment.md](./deployment.md), not in this
onboarding flow.

## Personal overrides

Use a personal override file for developer-owned resources that should not be pulled from
Infisical or overwritten by `bun run env:pull`:

```bash
bun run setup:personal
```

This creates `.env.override.local`, which is gitignored and has higher precedence than `.env.local`.
The main use case is personal Neon projects for local development:

```dotenv
NEON_PROJECT_ID="your-personal-neon-project-id"
# Optional for headless Neon CLI usage. Prefer `bunx neonctl auth` locally.
NEON_API_KEY=""
```

After adding personal overrides, run `bun run setup`. Shared dev secrets still come from Infisical
`dev` + `/web` and `/runner`, but the local override wins for keys like `NEON_PROJECT_ID`.
Setup pins local WorkOS redirects to `http://localhost:3000/auth/callback` even if shared Infisical
dev values contain an ngrok URL.

If you want setup to launch the dev server after migrations, run `bun run setup:dev`.

`bun run dev` also attempts to start ngrok before the app when the local ngrok CLI is authenticated.
That gives integrations such as GitHub a public callback URL without a separate command. In Goat
mode, the wrapper exposes a local proxy through ngrok and injects `RUNNER_LLM_BROKER_PUBLIC_URL`
into the runner process so sandboxed Goat Gmail/Calendar tools can call back to `/goat/tools/*`.
`bun run dev:goat` also starts Caddy when available and prints the local HTTPS URL to open so
Electric shape requests use HTTP/2. The URL is normally `https://localhost:3443`; when those ports
are occupied, a Conductor workspace falls back to its isolated port range. Set
`OPENCOMPANY_NGROK_DISABLED=1` to skip the tunnel, or `OPENCOMPANY_GOAT_HTTPS_DISABLED=1` to skip
Caddy and use HTTP. Register `https://localhost:3443/auth/callback` in WorkOS for fixed-port local
development and allow the printed localhost callback port when using parallel workspaces.

`bun run dev` and `bun run dev:stream` also write Turbo's structured task output to
`.context/logs/dev-turbo.json` for local debugging. The file is gitignored and captures the same
output that appears in the dev terminal, including possible secrets, so do not paste raw excerpts
outside trusted debugging contexts. If the top-level supervisor itself crashes, its uncaught error
is preserved separately in `.context/logs/dev-supervisor.log` before the child process tree is
terminated. Useful reads:

```bash
bun run dev:logs -- --source runner --tail 100
bun run dev:logs -- --source web --grep ECONNREFUSED
bun run dev:logs -- --errors --follow
```

`bun run dev` additionally starts a local Durable Streams server (in-memory, no Docker) and injects
`DURABLE_STREAMS_URL` into the web and runner processes so live session transcripts stream out of the
box. It steps aside if you set `DURABLE_STREAMS_URL` yourself (e.g. Electric Cloud) and reuses an
already-running server. Live sync data (agents, sessions) is separate — it comes from the Electric
container that `bun run setup` starts. See [stack/electric-sync.md](stack/electric-sync.md).

The older shared database path is still available with `bun run setup -- --shared-db`, but the default is branch isolation because this repo is commonly used from multiple Git worktrees. See [database.md](./database.md).

## For agents

```bash
bun run setup -- --check
```

Emits a JSON state snapshot with a `nextSteps` array. Used by the `start-work` skill so agents know exactly which steps they can run vs which need a human at the terminal.

Use the same command if setup fails and you want a machine-readable status.

## Env vars

Infisical is the source of truth for shared development env vars. Store the stable shared dev values
in Infisical `dev` + `/web` and `/runner`:

- `NEON_PROJECT_ID`
- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `OPENCOMPANY_GITHUB_ORG`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `STRIPE_SECRET_KEY`
- `GOAT_STRIPE_API_KEY`
- `GOAT_STRIPE_CHECKOUT_ENABLED`
- `CRON_SECRET`
- optional runner, Linear, analytics, and observability values from `.env.example`

`DATABASE_URL` can exist in Infisical `dev` only for the explicit `--shared-db` mode, but normal
local setup writes `.env.local` with a Neon branch-specific URL.

Runner-only development secrets such as `E2B_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`,
`OPENAI_CODEX_API_KEY`, `EXA_API_KEY`, `APIFY_API_TOKEN`,
`SUPADATA_API_KEY`, and `AMP_API_KEY` are also pulled from Infisical `dev` + `/runner` into
`.env.local` when present. This lets the local runner use the same shared provider credentials
without copying them by hand.

Stripe setup has a local fallback: if `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` are still
placeholders, `bun run setup` reads the active Stripe CLI test key and runs
`stripe listen --print-secret`, then writes both values into `.env.local` without printing them. It
also loads Goat billing values from Infisical `dev` + `/web`, generates `CRON_SECRET`, and refreshes
`apps/goat/.env.local`. Run `stripe login` once first. If you use a non-default Stripe CLI profile,
set `STRIPE_CLI_PROJECT_NAME` before running setup.

For an existing checkout where only Stripe is missing, run `bun run setup:stripe`.

Goat billing additionally requires `GOAT_STRIPE_API_KEY`. Setup prefers an `rk_test_` key from
the Stripe CLI. Stripe may instead issue an expiring `sk_test_` CLI key; setup accepts that only as a
gitignored local-development fallback. It refuses non-restricted keys without an expiry, and hosted
environments always require a dedicated restricted key stored in Infisical. If the active profile
has no suitable key, run `stripe login` or create a restricted test key in Stripe, store it in
Infisical `dev` + `/web`, and rerun setup.
Goat billing is pure usage-based (wallet top-ups, no subscription Prices to provision). Stripe
Checkout uses automatic tax; add the jurisdictions where the business is registered under
**Stripe Tax → Registrations** before enabling live Checkout. Configure the customer portal
separately in test and live modes with payment methods, invoice history, and tax IDs enabled.
Limit the Goat restricted key to Customer, Checkout Session, Customer Portal, and PaymentIntent
write permissions (auto-refill creates off-session PaymentIntents on saved cards).
Hosted live Checkout also requires `GOAT_STRIPE_CHECKOUT_ENABLED=true`; keep it false until the
business's Stripe Tax registrations are configured.

Goat credit top-up Checkouts accept promotion codes. For internal no-cost tests, create a 100%-off
coupon and a customer-facing promotion code in Stripe test mode. Add an expiry, redemption limit, or
customer restriction unless the code is deliberately permanent; create live-mode codes separately
and keep them private.

Then pull them locally:

```bash
bun run env:pull
```

`bun run env:pull` pulls Infisical dev values and merges only the shared setup keys above into
`.env.local`. In the default branch database mode, it does not overwrite `DATABASE_URL`.

The Inngest values in `.env.example` are for background jobs. Local `bun run dev` uses the Inngest dev helper; hosted environments should set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.

## What's still manual

- **Initial WorkOS bootstrap only:** if the shared WorkOS dev environment does not exist yet, create
  it in WorkOS, set `http://localhost:3000/auth/callback` as a redirect URI, and copy the resulting
  AuthKit env vars into Infisical `dev` + `/web`.
- **Initial Stripe CLI bootstrap only:** run `stripe login` once. For shared development env vars,
  prefer storing a restricted test key as `STRIPE_SECRET_KEY` in Infisical `dev` + `/web`.
- **Initial GitHub integration bootstrap only:** create a dedicated development GitHub App and a
  stable ngrok domain when testing the user-facing GitHub work integration locally. ngrok is required
  for the smoothest developer experience on callback/webhook integrations. See
  [github-local-dev.md](./github-local-dev.md).
- **Google (Gmail + Calendar + Drive) integration bootstrap only:** create an OAuth client in the
  Google Cloud console (APIs & Services → Credentials → OAuth client ID, type "Web application").
  Add `${NEXT_PUBLIC_APP_URL}/api/integrations/gmail/callback`,
  `${NEXT_PUBLIC_APP_URL}/api/integrations/google-calendar/callback`, and
  `${NEXT_PUBLIC_APP_URL}/api/integrations/google-drive/callback` as authorized redirect URIs,
  enable the Gmail, Google Calendar, Google Drive, and Google Docs APIs, and put
  `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and
  `GOOGLE_INTEGRATION_STATE_SECRET` in Infisical `dev` + `/web` and `/runner`. On the OAuth consent
  screen, Gmail's `gmail.readonly` scope is **restricted** and Calendar is **sensitive**, while
  Drive uses the non-sensitive `drive.file` per-file scope: for external/production users Google
  still requires app verification for the sensitive/restricted scopes already in use. Until
  verification, add yourself as a **test user** on the consent screen — the flow works fully for
  test users.
- **Neon logical replication (one-time per project):** enable logical replication in the Neon console
  (project → Settings) so Electric can create its replication slot. Project-level, so it covers every
  branch. `bun run setup` starts Electric but cannot flip this toggle for you.
- **Production WorkOS:** create a production WorkOS environment in the dashboard and set the redirect
  URI to your prod callback URL. Keep production values in Infisical `prod`, separate from `dev`.

## Day-to-day

- Schema change → edit `packages/db/src/schema.ts`, then `bun run db:generate`, then `bun run db:migrate`.
- Reset local database → `bun run db:branch:delete`, then `bun run setup`.
- New env var in Infisical → `bun run env:pull` to refresh `.env.local`.
- Missing local Stripe values → `bun run setup:stripe`.
- Agent editing / GitHub / Inngest architecture → see [architecture.md](./architecture.md).

## Common fixes

- Infisical export fails: confirm the engineer has `dev` access to `/web` and `/runner`, then run
  `infisical login` again.
- Neon branch creation fails: confirm `NEON_PROJECT_ID` is in `.env.override.local` and run
  `bunx neonctl auth`.
- Setup fails with "No container runtime found": install OrbStack (`brew install orbstack`) and start
  it (`open -a OrbStack`), then re-run `bun run setup`.
- Electric started but isn't healthy, or the agents/sessions UI shows nothing / shape proxy returns
  503: enable logical replication on the Neon project (console → Settings), then re-run setup. Inspect
  with `docker logs --tail 40 opencompany-electric`.
- Session transcript not updating live: `bun run dev` starts the Durable Streams server; if you run
  the apps outside `bun run dev`, start `bun scripts/durable-streams-dev.mjs` and set
  `DURABLE_STREAMS_URL`.
- WorkOS redirect fails: local redirect URI must include `http://localhost:3000/auth/callback`.
- Stripe setup warns: run `stripe login`, or skip it unless the task touches billing.

See [database.md](./database.md) for the database workflow and [auth.md](./auth.md) for the auth flow.

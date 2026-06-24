# Getting started

Goal: get a local dev environment running with auth and an isolated Neon branch database in under five minutes.

## Prerequisites

- Node 20+ and Bun 1.3+
- A container runtime — [OrbStack](https://orbstack.dev) (`brew install orbstack`) or Docker
  Desktop. **Required:** `bun run setup` uses it to start local Electric, which the
  agents/sessions UI syncs through, and fails fast if it's missing. Also enable logical
  replication on the Neon project (Neon console → Settings) so Electric can replicate.
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

Re-running it is safe.

## Local scripts

These are the root commands a contributor is expected to run directly:

| Command | Use when |
| --- | --- |
| `bun run setup` | Prepare or refresh local env files, Neon branch database, Stripe fallback values, and migrations. |
| `bun run setup:dev` | Run setup, then start the full local dev stack. |
| `bun run setup:personal` | Create `.env.override.local` for developer-owned values such as a personal Neon project. |
| `bun run setup:stripe` | Fill only missing local Stripe values after the main setup already ran. |
| `bun run env:pull` | Merge shared Infisical dev values into `.env.local` without replacing local database settings. |
| `bun run dev` | Start the full local stack with the Turbo TUI: web, runner, Inngest, Stripe webhooks, a local Durable Streams server (auto-sets `DURABLE_STREAMS_URL`), and ngrok when available. |
| `bun run dev:stream` | Start the same full local stack with streaming logs instead of the Turbo TUI. |
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
That gives integrations such as GitHub a public callback URL without a separate command. Set
`OPENCOMPANY_NGROK_DISABLED=1` to skip the tunnel. WorkOS still redirects to localhost for local
sign-in.

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
- optional runner, Linear, analytics, and observability values from `.env.example`

`DATABASE_URL` can exist in Infisical `dev` only for the explicit `--shared-db` mode, but normal
local setup writes `.env.local` with a Neon branch-specific URL.

Runner-only development secrets such as `E2B_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`,
`OPENAI_CODEX_API_KEY`, `EXA_API_KEY`, `X_API_BEARER_TOKEN`, `APIFY_API_TOKEN`,
`SUPADATA_API_KEY`, and `AMP_API_KEY` are also pulled from Infisical `dev` + `/runner` into
`.env.local` when present. This lets the local runner use the same shared provider credentials
without copying them by hand.

Stripe setup has a local fallback: if `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` are still
placeholders, `bun run setup` reads the active Stripe CLI test key and runs
`stripe listen --print-secret`, then writes both values into `.env.local` without printing them. Run
`stripe login` once first. If you use a non-default Stripe CLI profile, set `STRIPE_CLI_PROJECT_NAME`
before running setup.

For an existing checkout where only Stripe is missing, run `bun run setup:stripe`.

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

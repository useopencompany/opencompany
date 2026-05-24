# Deployment

Production uses Infisical as the secret source of truth, Vercel as the release control plane, and
Render for the long-lived agent runner.

## Runtime split

- Infisical stores and syncs runtime/release secrets.
- Vercel hosts `apps/web`, serves the Next.js UI, WorkOS callback routes, server actions, and the
  Inngest endpoint at `/api/inngest`.
- Render hosts `apps/runner`, the Bun/Fastify service that owns live agent runs, E2B sandboxes,
  model/tool streams, abort state, and browser SSE from `/sessions/:id/events`.
- Neon Postgres is shared by web, Inngest functions, and the runner.
- Inngest coordinates background functions, but it does not host live token streams.

Keep this split for V1. Vercel Queues/Workflow/Fluid Compute are useful later, but the current
runner is a dedicated live data plane rather than a short request handler.

## Release contract

Production releases are intentionally serialized:

1. Run CI on `main`.
2. Run Drizzle migrations against production Neon.
3. Build and deploy the Vercel web app for the exact commit.
4. Trigger and wait for the Render runner deploy for the exact commit.
5. Smoke check the canonical production web `/api/healthz` and runner `/healthz`.

The workflow lives in `.github/workflows/release-production.yml`. It runs automatically after the
`CI` workflow succeeds for a push to `main`, and it can still be manually triggered from GitHub
Actions. It is protected with `concurrency: production-release` so two production releases cannot
overlap. GitHub Actions keeps only the newest queued production release in that concurrency group;
older queued releases are cancelled automatically. A release that has already started is not killed
mid-flight, but automatic releases re-check `origin/main` before setup, before production changes,
and before deploy so stale commits skip the remaining expensive or mutating work.

The `CI` workflow uses branch/PR concurrency with `cancel-in-progress: true`, so a newer push to the
same PR or to `main` cancels superseded lint/typecheck/build/test work. This keeps rapid merge
bursts from spending Actions minutes on commits that can no longer release.

The web smoke check uses `PRODUCTION_WEB_URL` from Infisical `prod` + `/release`, not the raw Vercel
deployment URL, so Vercel deployment protection can remain enabled on generated preview-style URLs.

Release attribution is not managed as an Infisical secret. Vercel and Render expose commit metadata
to the server runtimes, and the production workflow injects `RELEASE_SHA` as
`NEXT_PUBLIC_OBSERVABILITY_RELEASE` during `vercel build` so browser Better Stack events group under
the same commit. Keep `OBSERVABILITY_RELEASE` unset in normal hosted deploys; reserve it for manual
or non-Git deploys where platform commit metadata is unavailable.

Vercel's build command no longer runs migrations. Migrations happen once, explicitly, before web and
runner deployment. Keep schema changes backwards compatible with the previous web and runner version
until the release has completed.

## Platform setup

### Vercel

Create/import the web project from this repo.

- Install command: `bun install --frozen-lockfile`
- Build command: `bun run vercel-build`
- Production branch: `main`
- Enable "Automatically expose System Environment Variables".
- Enable Skew Protection.
- If available, enable Rolling Releases with manual approval stages.
- Disable automatic production deploys from Git once the GitHub Actions release workflow is ready.
  Preview deploys can stay enabled.

Set these in Infisical `prod` + `/web` and sync them into Vercel:

- `DATABASE_URL`
- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `OPENCOMPANY_GITHUB_ORG`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`
- `RUNNER_PUBLIC_URL`
- `RUNNER_INTERNAL_TOKEN`
- `RUNNER_STREAM_TOKEN_SECRET`
- optional analytics, feedback, and observability env vars

Forward production web logs to the Better Stack source `opencompany-web-production` using the
Vercel Better Stack integration or a Vercel Log Drain. Keep the source token in Vercel/Infisical,
not in git.

### Render

Create the runner from `render.yaml`.

- Service name: `opencompany-runner`
- Runtime: Docker
- Health check: `/healthz`
- Auto deploy: off, so GitHub Actions controls release order
- API deploys: store `RENDER_SERVICE_ID` and `RENDER_API_KEY` in Infisical `prod` + `/release`

Set these in Infisical `prod` + `/runner` and sync them into Render:

- `DATABASE_URL`
- `RUNNER_INTERNAL_TOKEN`
- `RUNNER_STREAM_TOKEN_SECRET`
- `RUNNER_ALLOWED_ORIGINS`
- `E2B_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY`
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`

Forward runner logs to the Better Stack source `opencompany-runner-production` using a Render Log
Stream. Keep the source token in Render/Infisical, not in git.

`RUNNER_ALLOWED_ORIGINS` must include the exact production web origin, for example
`https://app.example.com`. Add preview origins only if you intentionally allow previews to connect
to the production runner.

### Neon

Use a dedicated production branch/database and set the pooled connection string as `DATABASE_URL` in
Infisical `prod` + `/web` and `/runner`, and as `PRODUCTION_DATABASE_URL` in Infisical `prod` +
`/release`.

Before first real deployment:

- Enable backups/PITR.
- Confirm the production branch is not used by local development.
- Run `bun run db:migrate` once against production from the release workflow, not from a developer
  laptop.

### Inngest

Create a production Inngest app and connect it to:

```text
https://<production-web-domain>/api/inngest
```

Set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in Vercel. Do not set `INNGEST_DEV=1` in hosted
environments.

### WorkOS

Create or switch to the production WorkOS environment.

- Add the production redirect URI:
  `https://<production-web-domain>/auth/callback`
- Set `NEXT_PUBLIC_WORKOS_REDIRECT_URI` to the same value in Vercel.
- Generate a 32+ character `WORKOS_COOKIE_PASSWORD`.

### GitHub Actions

Create a protected `production` environment in GitHub and add these environment variables:

- `INFISICAL_PROJECT_SLUG`
- `INFISICAL_MACHINE_IDENTITY_ID`
- `INFISICAL_ENV_SLUG` (optional, defaults to `prod`)
- `INFISICAL_DOMAIN` (optional, defaults to `https://eu.infisical.com`)

Store release secrets in Infisical `prod` + `/release`; see [secret-management.md](./secret-management.md).

The release workflow checks these with:

```bash
bun run release:preflight -- --release
```

## Local/operator commands

Check local env coverage:

```bash
bun run release:preflight
```

Check only web or runner env coverage:

```bash
bun run release:preflight -- --web
bun run release:preflight -- --runner
```

Run smoke checks against deployed services:

```bash
PRODUCTION_WEB_URL=https://app.example.com \
RUNNER_PUBLIC_URL=https://opencompany-runner.onrender.com \
bun run release:smoke
```

## First release checklist

- CI is green on `main`.
- Infisical `prod` + `/web`, `/runner`, and `/release` are populated.
- Infisical syncs to Vercel and Render are enabled.
- GitHub Actions production vars for Infisical OIDC are set.
- WorkOS production callback works.
- Inngest production app can sync functions from `/api/inngest`.
- Neon backups/PITR are enabled.
- Render API deploy works for the runner service.
- `bun run release:preflight -- --release` passes in GitHub Actions.
- The first `Release Production` workflow finishes with smoke checks green.

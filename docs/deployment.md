# Deployment

Production uses Infisical as the secret source of truth, Vercel as the release control plane, and
Render for the long-lived agent runner.

## Runtime split

- Infisical stores and syncs runtime/release secrets.
- Vercel hosts `apps/app` (the product at my.opencompany.chat): the Next.js UI, WorkOS auth
  routes, server actions, the Electric shape proxy, the Stripe webhook, and Vercel cron routes.
- Vercel hosts `apps/marketing` as a separate marketing site project.
- Render hosts `apps/runner`, the Bun/Fastify service that owns the durable turn worker, Brain
  ingestion workers, the scheduler, E2B sandboxes, and the LLM broker.
- Neon Postgres is shared by the app and the runner; Electric streams live rows to the browser.

## Release contract

Production releases are intentionally guarded:

1. Run CI on `main`.
2. Compare the commit range since the last successful production deployment with Turbo's package
   graph and plan which of app, marketing, and runner need deployment.
3. Run Drizzle migrations against production Neon.
4. Build the affected Vercel apps for the exact commit.
5. Re-check that the release is still current.
6. Trigger an affected Render runner deploy, then deploy the affected prebuilt Vercel apps while
   Render builds.
7. Wait for the Render runner deploy when one was triggered.
8. Smoke check all canonical production health endpoints, requiring the exact commit only from
   surfaces deployed by this release.

The workflow lives in `.github/workflows/release-production.yml`. It runs automatically after the
`CI` workflow succeeds for a push to `main`, and it can still be manually triggered from GitHub
Actions. It is protected with `concurrency: production-release` so two production releases cannot
overlap. GitHub Actions keeps only the newest queued production release in that concurrency group;
older queued releases are cancelled automatically. A release that has already started is not killed
mid-flight, but automatic releases re-check `origin/main` before setup, before production changes,
and before deploy so stale commits skip the remaining expensive or mutating work.

Automatic releases use the last successful GitHub production deployment as the affected-range base,
not the immediate parent commit. This preserves changes from a superseded release that was skipped.
If the workflow cannot resolve a valid ancestor base, it safely deploys every surface. Changes to
release orchestration and shared root build configuration also force a full release. Manual workflow
dispatches deploy every Vercel app and optionally the runner.

After migrations and the final deploy freshness check, affected Vercel and runner deployment wait
time may overlap. This keeps release latency down without starting production deploys for stale
commits. A failed Vercel deploy best-effort cancels the in-flight Render deploy, but cancellation is
not a rollback guarantee; if Render has already gone live, treat the failed workflow as requiring
operator follow-up.

The `CI` workflow uses branch/PR concurrency with `cancel-in-progress: true`, so a newer push to the
same PR or to `main` cancels superseded lint/typecheck/build/test work. This keeps rapid merge
bursts from spending Actions minutes on commits that can no longer release.

The app smoke check uses `PRODUCTION_APP_URL` from Infisical `prod` + `/release`, not the raw
Vercel deployment URL, so Vercel deployment protection can remain enabled on generated
preview-style URLs. Every production surface receives a basic health check; only surfaces selected
by the release plan must report the new commit SHA. The canonical production app URL is
`https://my.opencompany.chat`. The Better Stack status page monitors the same app `/api/healthz`
and runner `/healthz` endpoints as the release smoke check, so keep those health endpoints stable
when changing deployment or monitoring behavior.

Release attribution is not managed as an Infisical secret. Vercel and Render expose commit metadata
to the server runtimes, and the production workflow injects `RELEASE_SHA` as
`NEXT_PUBLIC_OBSERVABILITY_RELEASE` during `vercel build` so browser Better Stack events group under
the same commit. Keep `OBSERVABILITY_RELEASE` unset in normal hosted deploys; reserve it for manual
or non-Git deploys where platform commit metadata is unavailable.

Production release history is recorded with GitHub Deployments, keyed by the released commit SHA. The
workflow creates a `production` deployment before migrations and marks it successful only after the
deploy and smoke checks complete. If an automatic release is superseded after the deployment record is
created but before deploy, the record is marked inactive. Use GitHub Deployments as the operational
audit trail for what is or was in production; `CHANGELOG.md` remains a product-facing summary and does
not drive deployment.

Vercel's build command does not run migrations. Migrations happen once, explicitly, before app and
runner deployment. Keep schema changes backwards compatible with the previous app and runner
version until the release has completed. Because app and runner deploys can finish in either
order, keep app-runner contracts compatible in both directions for at least one release: the new
app must tolerate the previous runner, and the previous app must tolerate the new runner during
the deployment window.

## Platform setup

### Vercel (the app)

`apps/app` deploys as the product Vercel project with the project root set to `apps/app`:

- Install command: `bun install --frozen-lockfile`
- Build command: `bun run vercel-build:app`
- Production branch: `main`
- Framework preset: Next.js
- Enable "Automatically expose System Environment Variables" and Skew Protection.
- Automatic Git deploys stay off; production deploys are created by the release workflow with
  `vercel deploy --prebuilt --prod`.

Set the app envs in Infisical `prod` + `/goat` (the folder name is a frozen external contract) and
sync that path into the app project's Production environment. `scripts/release-preflight.mjs
--app` is the authoritative required-key list, and the release workflow independently verifies the
billing keys before migrations. The app uses its own WorkOS Application; register the production
redirect URI on it:

```text
https://my.opencompany.chat/auth/callback
```

The `goat` Postgres schema (a frozen physical name) must be migrated before
the app is served. Rollback is additive for the MVP: disabling the opencompany Vercel project stops new
task creation without affecting core `public` schema data.

### Vercel Marketing

`apps/marketing` deploys as a separate Vercel project/domain. Set the Vercel project root to
`apps/marketing`:

- Install command: `bun install --frozen-lockfile`
- Build command: `bun run vercel-build:marketing`
- Production branch: `main`
- Framework preset: Next.js
- Automatic Git deploys: off. Production deploys are created by the GitHub Actions release workflow
  with `vercel deploy --prebuilt --prod`.

The marketing app currently has no required runtime secrets. Store `MARKETING_VERCEL_PROJECT_ID` in
Infisical `prod` + `/release` so the release workflow can build and deploy the correct Vercel
project.

### Render

Create the runner from `render.yaml`.

- Service name: `opencompany-runner`
- Runtime: Docker
- Health check: `/healthz`
- Shutdown delay: `300` seconds, Render's documented maximum. Render sends `SIGTERM` to the old
  instance during deploys and follows with `SIGKILL` after this delay. The runner stops claiming
  new work immediately and gives active jobs and Codex turns up to 240 seconds to finish in
  place before interrupting or handing them off, leaving time for bounded cleanup and telemetry
  flushes. This is still a mitigation, not a guarantee that every long turn finishes before deploy.
- Auto deploy: off, so GitHub Actions controls release order
- API deploys: store `RENDER_SERVICE_ID` and `RENDER_API_KEY` in Infisical `prod` + `/release`

Set these in Infisical `prod` + `/runner` and sync them into Render:

- `DATABASE_URL`
- `RUNNER_INTERNAL_TOKEN`
- `RUNNER_STREAM_TOKEN_SECRET`
- `RUNNER_ALLOWED_ORIGINS`
- `RUNNER_PREVIEW_BASE_DOMAIN` (optional; required for opencompany cloud coding workspace previews)
- `RUNNER_PREVIEW_PROTOCOL` (optional; defaults to `https`)
- `E2B_API_KEY`
- `VERCEL_AI_GATEWAY_API_KEY`
- `NEXT_PUBLIC_POSTHOG_TOKEN`
- `NEXT_PUBLIC_POSTHOG_HOST`
- `EXA_API_KEY` (required when tasks are enabled)
- `RUNNER_BROWSER_ENABLED` (optional; set `true` to allow opencompany rendered-browser tasks)
- `BROWSERLESS_API_KEY` (required when opencompany Browser is enabled with the production Browserless default)
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_INTEGRATION_APP_ID`
- `GITHUB_INTEGRATION_APP_PRIVATE_KEY`

Forward runner logs to the Better Stack source `opencompany-runner-production` using a Render Log
Stream. Keep the source token in Render/Infisical, not in git.

`RUNNER_ALLOWED_ORIGINS` must include the exact production app origin, for example
`https://app.example.com`. Add preview origins only if you intentionally allow previews to connect
to the production runner.

For opencompany persistent cloud coding workspace previews (Codex and Claude Code), set
`RUNNER_PREVIEW_BASE_DOMAIN` to a dedicated hostname such as `preview.opencompany.example`. Add both
`preview.opencompany.example` and
`*.preview.opencompany.example` to the Render runner's custom domains and configure the corresponding
DNS records. The wildcard is required because each preview uses a short-lived signed capability as
its leftmost label. Keep the preview hostname on the runner service; it must not point at opencompany or
directly at E2B. `RUNNER_PREVIEW_PROTOCOL` defaults to `https`; override it only for an HTTP preview
environment such as local development.

Use a separate registrable domain (or eTLD+1) for the preview hostname than the one opencompany's own
cookies are scoped to. Preview content runs in a `sandbox="allow-same-origin allow-scripts"` iframe,
so if the preview domain shares a registrable domain with opencompany and opencompany sets broadly-scoped
(`Domain=.example.com`) cookies, the untrusted preview could read the user's opencompany session cookies.
Hosting previews on an unrelated domain keeps that boundary intact.

### Neon

Use a dedicated production branch/database and set the pooled connection string as `DATABASE_URL` in
Infisical `prod` + `/goat` and `/runner`, and as `PRODUCTION_DATABASE_URL` in Infisical `prod` +
`/release`.

Before first real deployment:

- Enable backups/PITR.
- Confirm the production branch is not used by local development.
- Run `bun run db:migrate` once against production from the release workflow, not from a developer
  laptop.

### WorkOS

Create or switch to the production WorkOS environment.

- The app has its own WorkOS Application in the production environment.
- Add the production redirect URI: `https://my.opencompany.chat/auth/callback`
- Set the Application's User invitation URL to: `https://my.opencompany.chat/auth/invite`
- Set `NEXT_PUBLIC_WORKOS_REDIRECT_URI` to the same value in Vercel.
- Generate a 32+ character `WORKOS_COOKIE_PASSWORD`.

### GitHub Work Integration

Create a separate production GitHub App for user-facing work repository integrations.

- Set callback URLs to:
  `https://<production-web-domain>/api/integrations/github/callback`
  `https://my.opencompany.chat/api/integrations/github/callback`
- Grant repository contents read/write and pull request read/write permissions.
- Leave webhooks inactive until a GitHub webhook ingestion route is deployed. When enabled, subscribe
  to pull request events used by `.agent` triggers: `opened`, `reopened`, `synchronize`, and
  `ready_for_review`.
- Install the App only on the orgs or repositories customers should connect.
- Set `GITHUB_INTEGRATION_APP_ID`, `GITHUB_INTEGRATION_APP_PRIVATE_KEY`,
  `GITHUB_INTEGRATION_APP_SLUG`, `GITHUB_INTEGRATION_APP_CLIENT_ID`,
  `GITHUB_INTEGRATION_APP_CLIENT_SECRET`, and a separate 32+ character
  `GITHUB_INTEGRATION_STATE_SECRET` in Vercel.

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
bun run release:preflight -- --app
bun run release:preflight -- --runner
```

Run smoke checks against deployed services:

```bash
PRODUCTION_WEB_URL=https://my.opencompany.cloud \
RUNNER_PUBLIC_URL=https://opencompany-runner.onrender.com \
bun run release:smoke
```

## First release checklist

- CI is green on `main`.
- Infisical `prod` + `/goat`, `/runner`, and `/release` are populated.
- `MARKETING_VERCEL_PROJECT_ID` in `/release` points to a Vercel project rooted at
  `apps/marketing`.
- Infisical syncs to Vercel and Render are enabled.
- GitHub Actions production vars for Infisical OIDC are set.
- Legacy web and opencompany use separate WorkOS Application credentials, and both production callbacks work.
- Neon backups/PITR are enabled.
- Render API deploy works for the runner service.
- `bun run release:preflight -- --release` passes in GitHub Actions.
- The first `Release Production` workflow finishes with smoke checks green.

## PR preview environments

The per-PR preview system was retired with the legacy web app (it deployed the legacy Vercel
project over Durable Streams). Resurrect it from git history against `apps/app` once preview
auth is registered in WorkOS for the app environment.
